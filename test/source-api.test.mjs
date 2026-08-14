// Process-private source claim continuity — direct, hermetic HTTP contract tests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  SourceOnboardingError,
  createSourceClaimSession,
} from "../dist/onboarding/source-api.js";
import { rememberReservation } from "../dist/onboarding/session.js";

const BASE_URL = "https://api.layers.test";
const TRIAL_HANDLE = "a".repeat(64);
const OTHER_TRIAL_HANDLE = "d".repeat(64);
const ATTEMPT_HANDLE = "b".repeat(43);
const OTHER_ATTEMPT_HANDLE = "e".repeat(43);
const RESERVATION_CAPABILITY = "reservation_capability_process_only_123";
const POSTCLAIM_CAPABILITY = "c".repeat(43);
const CLAIM_URL = `https://app.layers.test/claim?claimAttemptHandle=${ATTEMPT_HANDLE}`;
const ATTEMPT_EXPIRES_AT = "2100-08-14T00:15:00.000Z";
const CAPABILITY_EXPIRES_AT = "2100-08-14T00:30:00.000Z";
const UPDATED_AT = "2100-08-14T00:01:00.000Z";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const CLAIM_ATTEMPT_RESPONSE = {
  protocolVersion: 1,
  trialHandle: TRIAL_HANDLE,
  attemptHandle: ATTEMPT_HANDLE,
  claimUrl: CLAIM_URL,
  expiresAt: ATTEMPT_EXPIRES_AT,
  state: "pending",
};

const POSTCLAIM_RESPONSE = {
  protocolVersion: 1,
  trialHandle: TRIAL_HANDLE,
  state: "claimed",
  organizationName: "Example Organization",
  projectName: "Example Project",
  capabilityState: "active",
  capabilityExpiresAt: CAPABILITY_EXPIRES_AT,
  postclaimState: "running",
  generationStatus: "generating",
  updatedAt: UPDATED_AT,
};

function rememberActiveReservation() {
  rememberReservation({
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    reservationCapability: RESERVATION_CAPABILITY,
    expiresAt: "2100-08-14T01:00:00.000Z",
    state: "awaiting_evidence",
  });
}

function jsonResponse(body, status, headers = {}) {
  return Response.json(body, { status, headers });
}

function captureRequest(input, init = {}) {
  return {
    url: String(input),
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: typeof init.body === "string" ? init.body : "",
    signal: init.signal,
  };
}

function pendingExchangeResponse(overrides = {}) {
  return {
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    attemptHandle: ATTEMPT_HANDLE,
    state: "pending",
    expiresAt: ATTEMPT_EXPIRES_AT,
    ...overrides,
  };
}

function claimedExchangeResponse() {
  return {
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    attemptHandle: ATTEMPT_HANDLE,
    state: "claimed",
    postclaimCapability: POSTCLAIM_CAPABILITY,
    capabilityExpiresAt: CAPABILITY_EXPIRES_AT,
  };
}

function abortablePendingResponse(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () =>
      reject(new DOMException("mock request aborted", "AbortError"));
    if (signal?.aborted) {
      rejectAbort();
      return;
    }
    signal?.addEventListener("abort", rejectAbort, { once: true });
  });
}

test("claim session emits the exact transport contract and keeps poll IDs stable", async () => {
  rememberActiveReservation();
  const originalFetch = globalThis.fetch;
  const requests = [];
  let session;

  globalThis.fetch = async (input, init = {}) => {
    const request = captureRequest(input, init);
    requests.push(request);
    if (requests.length === 1) {
      return jsonResponse(CLAIM_ATTEMPT_RESPONSE, 202);
    }
    return jsonResponse(pendingExchangeResponse(), 202);
  };

  try {
    session = await createSourceClaimSession(BASE_URL);
    assert.equal(session.claimUrl, CLAIM_URL);
    assert.equal(session.expiresAt, ATTEMPT_EXPIRES_AT);

    const first = await session.exchange();
    const second = await session.exchange();
    assert.deepEqual(first, {
      state: "pending",
      expiresAt: ATTEMPT_EXPIRES_AT,
    });
    assert.deepEqual(second, first);
    assert.equal(requests.length, 3, "pending exchange must not read postclaim");

    const [create, firstPoll, secondPoll] = requests;
    assert.equal(
      new URL(create.url).pathname,
      `/api/onboard/agent/trials/${TRIAL_HANDLE}/claim-attempts`,
    );
    assert.equal(create.method, "POST");
    assert.deepEqual([...create.headers.keys()].sort(), [
      "accept",
      "content-type",
      "x-layers-onboard-capability",
      "x-layers-onboard-transport-capability",
    ]);
    assert.equal(create.headers.get("accept"), "application/json");
    assert.equal(create.headers.get("content-type"), "application/json");
    assert.equal(
      create.headers.get("x-layers-onboard-capability"),
      RESERVATION_CAPABILITY,
    );
    const transportCapability = create.headers.get(
      "x-layers-onboard-transport-capability",
    );
    assert.ok(transportCapability);
    assert.match(transportCapability, BASE64URL_256_PATTERN);
    assert.equal(create.headers.get("authorization"), null);
    assert.equal(
      create.headers.get("x-layers-onboard-postclaim-capability"),
      null,
    );

    const createBody = JSON.parse(create.body);
    assert.deepEqual(Object.keys(createBody).sort(), [
      "attemptRequestId",
      "codeChallenge",
      "codeChallengeMethod",
      "protocolVersion",
    ]);
    assert.equal(createBody.protocolVersion, 1);
    assert.match(createBody.attemptRequestId, UUID_PATTERN);
    assert.match(createBody.codeChallenge, BASE64URL_256_PATTERN);
    assert.equal(createBody.codeChallengeMethod, "S256");

    for (const poll of [firstPoll, secondPoll]) {
      assert.equal(
        new URL(poll.url).pathname,
        `/api/onboard/agent/trials/${TRIAL_HANDLE}/claim-attempts/${ATTEMPT_HANDLE}/exchange`,
      );
      assert.equal(poll.method, "POST");
      assert.deepEqual([...poll.headers.keys()].sort(), [
        "accept",
        "content-type",
        "x-layers-onboard-capability",
        "x-layers-onboard-transport-capability",
      ]);
      assert.equal(poll.headers.get("accept"), "application/json");
      assert.equal(poll.headers.get("content-type"), "application/json");
      assert.equal(
        poll.headers.get("x-layers-onboard-capability"),
        RESERVATION_CAPABILITY,
      );
      assert.equal(
        poll.headers.get("x-layers-onboard-transport-capability"),
        transportCapability,
      );
    }

    assert.equal(
      firstPoll.body,
      secondPoll.body,
      "poll replay must be byte-identical",
    );
    const exchangeBody = JSON.parse(firstPoll.body);
    assert.deepEqual(Object.keys(exchangeBody).sort(), [
      "codeVerifier",
      "exchangeRequestId",
      "protocolVersion",
    ]);
    assert.equal(exchangeBody.protocolVersion, 1);
    assert.match(exchangeBody.exchangeRequestId, UUID_PATTERN);
    assert.match(exchangeBody.codeVerifier, BASE64URL_256_PATTERN);
    assert.equal(
      createHash("sha256")
        .update(exchangeBody.codeVerifier, "ascii")
        .digest("base64url"),
      createBody.codeChallenge,
      "the fixed verifier must prove the create request's S256 challenge",
    );
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("a 200 claimed exchange immediately returns only the safe postclaim projection", async () => {
  rememberActiveReservation();
  const originalFetch = globalThis.fetch;
  const requests = [];
  let session;

  globalThis.fetch = async (input, init = {}) => {
    const request = captureRequest(input, init);
    requests.push(request);
    if (requests.length === 1) {
      return jsonResponse(CLAIM_ATTEMPT_RESPONSE, 202);
    }
    if (requests.length === 2) {
      return jsonResponse(claimedExchangeResponse(), 200);
    }
    return jsonResponse(POSTCLAIM_RESPONSE, 200);
  };

  try {
    session = await createSourceClaimSession(BASE_URL);
    const result = await session.exchange();

    assert.deepEqual(result, {
      state: "claimed",
      postclaim: POSTCLAIM_RESPONSE,
    });
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      [
        `/api/onboard/agent/trials/${TRIAL_HANDLE}/claim-attempts`,
        `/api/onboard/agent/trials/${TRIAL_HANDLE}/claim-attempts/${ATTEMPT_HANDLE}/exchange`,
        `/api/onboard/agent/trials/${TRIAL_HANDLE}/postclaim`,
      ],
      "postclaim must be read before a claimed result resolves",
    );

    const createTransportCapability = requests[0].headers.get(
      "x-layers-onboard-transport-capability",
    );
    const exchangeBody = JSON.parse(requests[1].body);
    assert.ok(createTransportCapability);
    assert.equal(typeof exchangeBody.codeVerifier, "string");
    const postclaim = requests[2];
    assert.equal(postclaim.method, "GET");
    assert.equal(postclaim.headers.get("accept"), "application/json");
    assert.equal(
      postclaim.headers.get("x-layers-onboard-postclaim-capability"),
      POSTCLAIM_CAPABILITY,
    );
    assert.equal(postclaim.headers.get("x-layers-onboard-capability"), null);
    assert.equal(
      postclaim.headers.get("x-layers-onboard-transport-capability"),
      null,
    );

    const serializedResult = JSON.stringify(result);
    const serializedSession = JSON.stringify(session);
    for (const secret of [
      RESERVATION_CAPABILITY,
      createTransportCapability,
      exchangeBody.codeVerifier,
      POSTCLAIM_CAPABILITY,
    ]) {
      assert.equal(serializedResult.includes(secret), false);
      assert.equal(serializedSession.includes(secret), false);
    }
    assert.equal("postclaimCapability" in result.postclaim, false);
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("claim creation retries one transport failure with an identical idempotent request", async () => {
  rememberActiveReservation();
  const originalFetch = globalThis.fetch;
  const requests = [];
  let session;

  globalThis.fetch = async (input, init = {}) => {
    const request = captureRequest(input, init);
    requests.push(request);
    if (requests.length === 1) {
      throw new TypeError("mock connection reset");
    }
    return jsonResponse(CLAIM_ATTEMPT_RESPONSE, 202);
  };

  try {
    session = await createSourceClaimSession(BASE_URL);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, requests[1].url);
    assert.equal(requests[0].method, requests[1].method);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(
      requests[0].headers.get("x-layers-onboard-capability"),
      requests[1].headers.get("x-layers-onboard-capability"),
    );
    assert.equal(
      requests[0].headers.get("x-layers-onboard-transport-capability"),
      requests[1].headers.get("x-layers-onboard-transport-capability"),
    );
    assert.equal(
      JSON.parse(requests[0].body).attemptRequestId,
      JSON.parse(requests[1].body).attemptRequestId,
    );
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("claim creation replays one HTTP 5xx with the identical idempotent request", async () => {
  rememberActiveReservation();
  const originalFetch = globalThis.fetch;
  const requests = [];
  let session;

  globalThis.fetch = async (input, init = {}) => {
    const request = captureRequest(input, init);
    requests.push(request);
    return requests.length === 1
      ? jsonResponse({ error: "response lost after adoption" }, 503)
      : jsonResponse(CLAIM_ATTEMPT_RESPONSE, 202);
  };

  try {
    session = await createSourceClaimSession(BASE_URL);
    assert.equal(requests.length, 2, "HTTP 5xx gets exactly one replay");
    assert.equal(requests[0].url, requests[1].url);
    assert.equal(requests[0].method, requests[1].method);
    assert.equal(requests[0].body, requests[1].body);
    assert.deepEqual(
      [...requests[0].headers.entries()],
      [...requests[1].headers.entries()],
      "the replay must preserve reservation, transport, and content headers",
    );
    assert.deepEqual(
      JSON.parse(requests[0].body),
      JSON.parse(requests[1].body),
    );
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 429 remains caller-visible without replay or secret disclosure", async () => {
  rememberActiveReservation();
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const request = captureRequest(input, init);
    requests.push(request);
    return jsonResponse(
      { error: `do not echo ${RESERVATION_CAPABILITY}` },
      429,
      { "retry-after": "7" },
    );
  };

  try {
    await assert.rejects(createSourceClaimSession(BASE_URL), (error) => {
      assert.ok(error instanceof SourceOnboardingError);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSeconds, 7);
      const rendered = `${String(error)}\n${error.stack ?? ""}`;
      const transportCapability = requests[0].headers.get(
        "x-layers-onboard-transport-capability",
      );
      assert.ok(transportCapability);
      assert.equal(rendered.includes(RESERVATION_CAPABILITY), false);
      assert.equal(rendered.includes(transportCapability), false);
      return true;
    });
    assert.equal(
      requests.length,
      1,
      "HTTP 429 is caller-retryable, not auto-replayed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exchange rejects wrong bindings and status/state pairs", async () => {
  rememberActiveReservation();
  const originalFetch = globalThis.fetch;
  let exchangeCount = 0;
  let session;

  globalThis.fetch = async (input, init = {}) => {
    const request = captureRequest(input, init);
    if (!new URL(request.url).pathname.endsWith("/exchange")) {
      return jsonResponse(CLAIM_ATTEMPT_RESPONSE, 202);
    }
    exchangeCount += 1;
    if (exchangeCount === 1) {
      return jsonResponse(
        pendingExchangeResponse({ trialHandle: OTHER_TRIAL_HANDLE }),
        202,
      );
    }
    if (exchangeCount === 2) {
      return jsonResponse(
        pendingExchangeResponse({ attemptHandle: OTHER_ATTEMPT_HANDLE }),
        202,
      );
    }
    return exchangeCount === 3
      ? jsonResponse(pendingExchangeResponse(), 200)
      : jsonResponse(claimedExchangeResponse(), 202);
  };

  try {
    session = await createSourceClaimSession(BASE_URL);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(session.exchange(), (error) => {
        assert.ok(error instanceof SourceOnboardingError);
        assert.equal(error.retryable, false);
        assert.match(error.message, /invalid response/u);
        assert.equal(error.message.includes(OTHER_TRIAL_HANDLE), false);
        assert.equal(error.message.includes(OTHER_ATTEMPT_HANDLE), false);
        return true;
      });
    }
    assert.equal(exchangeCount, 4);
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("caller abort and dispose interrupt exchange without exposing session secrets", async () => {
  rememberActiveReservation();
  const originalFetch = globalThis.fetch;
  let createCount = 0;

  globalThis.fetch = async (input, init = {}) => {
    const request = captureRequest(input, init);
    if (!new URL(request.url).pathname.endsWith("/exchange")) {
      createCount += 1;
      return jsonResponse(CLAIM_ATTEMPT_RESPONSE, 202);
    }
    return abortablePendingResponse(request.signal);
  };

  let callerAbortSession;
  let disposedSession;
  try {
    callerAbortSession = await createSourceClaimSession(BASE_URL);
    const caller = new AbortController();
    const callerAbortedExchange = callerAbortSession.exchange(caller.signal);
    caller.abort();
    await assert.rejects(callerAbortedExchange, (error) => {
      assert.ok(error instanceof SourceOnboardingError);
      assert.equal(error.retryable, false);
      assert.equal(error.message, "Onboarding interrupted");
      return true;
    });
    callerAbortSession.dispose();

    disposedSession = await createSourceClaimSession(BASE_URL);
    const disposedExchange = disposedSession.exchange();
    disposedSession.dispose();
    await assert.rejects(disposedExchange, (error) => {
      assert.ok(error instanceof SourceOnboardingError);
      assert.equal(error.retryable, false);
      assert.equal(error.message, "Onboarding interrupted");
      assert.equal(error.message.includes(RESERVATION_CAPABILITY), false);
      return true;
    });
    await assert.rejects(disposedSession.exchange(), (error) => {
      assert.ok(error instanceof SourceOnboardingError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /session is unavailable/u);
      assert.equal(error.message.includes(RESERVATION_CAPABILITY), false);
      return true;
    });
    assert.equal(createCount, 2);
  } finally {
    callerAbortSession?.dispose();
    disposedSession?.dispose();
    globalThis.fetch = originalFetch;
  }
});
