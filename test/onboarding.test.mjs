// Keyless onboarding mode — hermetic localhost contract and security tests.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, parseUrl, spawnServer, startClient, withMockApi } from "./helpers.mjs";

const ACCESS_TOKEN = "access_token_live_secret_123";
const REFRESHED_ACCESS_TOKEN = "access_token_refreshed_secret_456";
const SESSION_HANDLE = "sessionHandle_live_secret_789";
const ACCESS_TOKEN_B = "access_token_replacement_secret_b";
const SESSION_HANDLE_B = "sessionHandle_replacement_secret_b";
const REFRESHED_ACCESS_TOKEN_A = "access_token_stale_refresh_secret_a";
const TRIAL_HANDLE = "trial_test_123";
const TRIAL_HANDLE_B = "trial_test_456";
const CLAIM_TOKEN = "claim_test_456";
const PREVIEW_URL = "https://layers.test/p/preview_test_123";
const CLAIM_URL = `https://layers.test/claim?token=${CLAIM_TOKEN}`;
const EXPIRES_AT = "2026-07-22T12:00:00.000Z";

const START_RESPONSE = {
  trialHandle: TRIAL_HANDLE,
  previewUrl: PREVIEW_URL,
  claimUrl: CLAIM_URL,
  expiresAt: EXPIRES_AT,
  session: { access_token: ACCESS_TOKEN, expires_in: 3600 },
  sessionHandle: SESSION_HANDLE,
};

const STATUS_RESPONSE = {
  buildState: "preview_ready",
  planState: "ready",
  claimState: "unclaimed",
  postclaimState: "n/a",
  previewUrl: PREVIEW_URL,
  claimUrl: CLAIM_URL,
  claimed: false,
  continuity: "browser",
  plan: { state: "ready", teaser: "A reveal-gated plan teaser" },
};

function countLeadingZeroBits(digest) {
  let count = 0;
  for (const byte of digest) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    return count + Math.clz32(byte) - 24;
  }
  return count;
}

function validPow({ powNonce, powSolution }, difficulty) {
  const digest = createHash("sha256").update(powNonce + powSolution, "utf8").digest();
  return countLeadingZeroBits(digest) >= difficulty;
}

function onboardingHandler(overrides = {}) {
  return (req, captured) => {
    const path = parseUrl(captured).pathname;
    if (overrides[path]) return overrides[path](req, captured);
    if (path === "/api/onboard/agent/challenge") {
      return { status: 200, json: { nonce: "test_nonce", difficulty: 8 } };
    }
    if (path === "/api/onboard/agent/start") {
      return { status: 202, json: START_RESPONSE };
    }
    return { status: 500, json: { error: `unexpected mock route: ${path}` } };
  };
}

test("keyless mode registers only the four native onboarding tools", async () => {
  const client = await startClient(["--read-only", "--organization", "ignored_org"], {
    apiKey: null,
  });
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "onboard_start",
        "get_onboarding_status",
        "onboard_claim_begin",
        "onboard_claim_verify",
      ],
    );
    assert.match(client.getInstructions(), /stateless/i);
    assert.match(client.getInstructions(), /six-digit code/i);
    assert.match(client.getInstructions(), /never invent/i);
  } finally {
    await client.close();
  }
});

test("onboard_start validates PoW and keeps session credentials out of its result", async () => {
  let submitted;
  assert.equal("refresh_token" in START_RESPONSE.session, false, "mock must never mint a refresh token");

  await withMockApi(
    async (client, requests) => {
      const result = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(result.isError, false, result.text);
      assert.deepEqual(JSON.parse(result.text), {
        trialHandle: TRIAL_HANDLE,
        previewUrl: PREVIEW_URL,
        claimUrl: CLAIM_URL,
        expiresAt: EXPIRES_AT,
      });
      assert.doesNotMatch(result.text, /access_token|sessionHandle/);
      assert.doesNotMatch(result.text, new RegExp(ACCESS_TOKEN));
      assert.doesNotMatch(result.text, new RegExp(SESSION_HANDLE));

      const challenge = requests.find(
        (request) => parseUrl(request).pathname === "/api/onboard/agent/challenge",
      );
      const start = requests.find(
        (request) => parseUrl(request).pathname === "/api/onboard/agent/start",
      );
      assert.equal(challenge.method, "GET");
      assert.equal(challenge.headers.authorization, undefined);
      assert.equal(start.method, "POST");
      assert.equal(start.headers.authorization, undefined);
      assert.ok(submitted);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        "/api/onboard/agent/start": (_req, captured) => {
          submitted = JSON.parse(captured.body);
          assert.equal(submitted.url, "https://example.com");
          assert.equal(submitted.powNonce, "test_nonce");
          assert.equal(validPow(submitted, 8), true, "mock API must re-validate the PoW solution");
          assert.match(submitted.startRequestId, /^[0-9a-f-]{36}$/i);
          return { status: 202, json: START_RESPONSE };
        },
      }),
    },
  );
});

test("status attaches bearer auth, refreshes once on 401, and retries with the new token", async () => {
  let statusCalls = 0;
  await withMockApi(
    async (client, requests) => {
      const started = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(started.isError, false, started.text);

      const result = await callTool(client, "get_onboarding_status");
      assert.equal(result.isError, false, result.text);
      assert.deepEqual(JSON.parse(result.text), STATUS_RESPONSE, "status body must pass through verbatim");

      const statuses = requests.filter(
        (request) => parseUrl(request).pathname === `/api/onboard/agent/trials/${TRIAL_HANDLE}`,
      );
      const refreshes = requests.filter(
        (request) => parseUrl(request).pathname === "/api/onboard/agent/refresh",
      );
      assert.equal(statuses.length, 2);
      assert.equal(statuses[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
      assert.equal(statuses[1].headers.authorization, `Bearer ${REFRESHED_ACCESS_TOKEN}`);
      assert.equal(refreshes.length, 1, "a 401 must trigger exactly one refresh");
      assert.deepEqual(JSON.parse(refreshes[0].body), { sessionHandle: SESSION_HANDLE });
      assert.equal(refreshes[0].headers.authorization, undefined);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        [`/api/onboard/agent/trials/${TRIAL_HANDLE}`]: () => {
          statusCalls += 1;
          return statusCalls === 1
            ? { status: 401, json: { error: "expired" } }
            : { status: 200, json: STATUS_RESPONSE };
        },
        "/api/onboard/agent/refresh": () => ({
          status: 200,
          json: { access_token: REFRESHED_ACCESS_TOKEN, expires_in: 3600 },
        }),
      }),
    },
  );
});

test("claim begin and verify mirror public tokenless contracts", async () => {
  const verifyResponse = {
    status: "claimed",
    organizationId: "org_test_123",
    continuity: "browser",
  };

  await withMockApi(
    async (client, requests) => {
      const started = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(started.isError, false, started.text);

      const begun = await callTool(client, "onboard_claim_begin", {
        email: "human@example.com",
      });
      assert.equal(begun.isError, false, begun.text);
      assert.deepEqual(JSON.parse(begun.text), { status: "otp_sent" });

      const verified = await callTool(client, "onboard_claim_verify", {
        email: "human@example.com",
        code: "123456",
      });
      assert.equal(verified.isError, false, verified.text);
      assert.deepEqual(JSON.parse(verified.text), verifyResponse);
      assert.doesNotMatch(verified.text, /access_token|sessionHandle|refresh_token/);

      const beginRequest = requests.find(
        (request) => parseUrl(request).pathname === "/api/onboard/claim/begin",
      );
      const verifyRequest = requests.find(
        (request) => parseUrl(request).pathname === "/api/onboard/claim/verify",
      );
      assert.deepEqual(JSON.parse(beginRequest.body), {
        claimToken: CLAIM_TOKEN,
        email: "human@example.com",
      });
      assert.deepEqual(JSON.parse(verifyRequest.body), {
        claimToken: CLAIM_TOKEN,
        email: "human@example.com",
        code: "123456",
      });
      assert.equal(beginRequest.headers.authorization, undefined);
      assert.equal(verifyRequest.headers.authorization, undefined);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        "/api/onboard/claim/begin": () => ({ status: 200, json: { status: "otp_sent" } }),
        "/api/onboard/claim/verify": () => ({ status: 200, json: verifyResponse }),
      }),
    },
  );
});

test("onboarding HTTP errors expose only status and response byte count", async () => {
  await withMockApi(
    async (client) => {
      const started = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(started.isError, false, started.text);

      const result = await callTool(client, "get_onboarding_status");
      assert.equal(result.isError, true);
      assert.match(result.text, /Onboarding status failed \(500\): response body \(\d+ bytes\)/);
      assert.doesNotMatch(result.text, /upstream leaked/);
      assert.doesNotMatch(result.text, new RegExp(ACCESS_TOKEN));
      assert.doesNotMatch(result.text, new RegExp(SESSION_HANDLE));
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        [`/api/onboard/agent/trials/${TRIAL_HANDLE}`]: () => ({
          status: 500,
          json: { error: `upstream leaked ${ACCESS_TOKEN} and ${SESSION_HANDLE}` },
        }),
      }),
    },
  );
});

test("a malformed start response cannot leak pre-session credentials", async () => {
  const mintedAccessToken = "access_token_minted_before_parse";
  const mintedSessionHandle = "sessionHandle_minted_before_parse";
  const malformedBody =
    `{"access_token":"${mintedAccessToken}",` +
    `"sessionHandle":"${mintedSessionHandle}"`;

  await withMockApi(
    async (client) => {
      const result = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(result.isError, true);
      assert.match(result.text, /Onboarding start returned an invalid JSON response \(\d+ bytes\)/);
      assert.doesNotMatch(result.text, new RegExp(mintedAccessToken));
      assert.doesNotMatch(result.text, new RegExp(mintedSessionHandle));
      assert.doesNotMatch(result.text, /access_token|sessionHandle/);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        "/api/onboard/agent/start": () => ({ status: 202, text: malformedBody }),
      }),
    },
  );
});

test("onboard_start reuses one startRequestId across a transport retry", async () => {
  let startAttempts = 0;
  await withMockApi(
    async (client, requests) => {
      const result = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(result.isError, false, result.text);

      const starts = requests.filter(
        (request) => parseUrl(request).pathname === "/api/onboard/agent/start",
      );
      assert.equal(starts.length, 2);
      const first = JSON.parse(starts[0].body);
      const second = JSON.parse(starts[1].body);
      assert.equal(first.startRequestId, second.startRequestId);
      assert.deepEqual(second, first, "the complete in-flight start payload must be stable");
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        "/api/onboard/agent/start": () => {
          startAttempts += 1;
          return startAttempts === 1
            ? { destroy: true }
            : { status: 202, json: START_RESPONSE };
        },
      }),
    },
  );
});

test("a stalled refresh cannot overwrite a replacement onboarding session", async () => {
  let startCalls = 0;
  let statusACalls = 0;
  let releaseRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => {
    markRefreshStarted = resolve;
  });

  const startResponseB = {
    ...START_RESPONSE,
    trialHandle: TRIAL_HANDLE_B,
    session: { access_token: ACCESS_TOKEN_B, expires_in: 3600 },
    sessionHandle: SESSION_HANDLE_B,
  };

  await withMockApi(
    async (client, requests) => {
      const startedA = await callTool(client, "onboard_start", { url: "https://a.example.com" });
      assert.equal(startedA.isError, false, startedA.text);

      const statusAInFlight = callTool(client, "get_onboarding_status");
      await refreshStarted;

      const startedB = await callTool(client, "onboard_start", { url: "https://b.example.com" });
      assert.equal(startedB.isError, false, startedB.text);
      releaseRefresh();

      const statusA = await statusAInFlight;
      assert.equal(statusA.isError, false, statusA.text);
      const statusB = await callTool(client, "get_onboarding_status");
      assert.equal(statusB.isError, false, statusB.text);

      const refreshes = requests.filter(
        (request) => parseUrl(request).pathname === "/api/onboard/agent/refresh",
      );
      assert.equal(refreshes.length, 1);
      assert.deepEqual(JSON.parse(refreshes[0].body), { sessionHandle: SESSION_HANDLE });

      const statusesA = requests.filter(
        (request) => parseUrl(request).pathname === `/api/onboard/agent/trials/${TRIAL_HANDLE}`,
      );
      const statusesB = requests.filter(
        (request) => parseUrl(request).pathname === `/api/onboard/agent/trials/${TRIAL_HANDLE_B}`,
      );
      assert.equal(statusesA.length, 2);
      assert.equal(statusesA[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
      assert.equal(statusesA[1].headers.authorization, `Bearer ${ACCESS_TOKEN_B}`);
      assert.equal(statusesB.length, 1);
      assert.equal(statusesB[0].headers.authorization, `Bearer ${ACCESS_TOKEN_B}`);
      assert.notEqual(statusesB[0].headers.authorization, `Bearer ${REFRESHED_ACCESS_TOKEN_A}`);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        "/api/onboard/agent/start": () => {
          startCalls += 1;
          return { status: 202, json: startCalls === 1 ? START_RESPONSE : startResponseB };
        },
        [`/api/onboard/agent/trials/${TRIAL_HANDLE}`]: () => {
          statusACalls += 1;
          return statusACalls === 1
            ? { status: 401, json: { error: "expired" } }
            : { status: 200, json: STATUS_RESPONSE };
        },
        [`/api/onboard/agent/trials/${TRIAL_HANDLE_B}`]: () => ({
          status: 200,
          json: { ...STATUS_RESPONSE, trialHandle: TRIAL_HANDLE_B },
        }),
        "/api/onboard/agent/refresh": async () => {
          markRefreshStarted();
          return await new Promise((resolve) => {
            releaseRefresh = () =>
              resolve({
                status: 200,
                json: { access_token: REFRESHED_ACCESS_TOKEN_A, expires_in: 3600 },
              });
          });
        },
      }),
    },
  );
});

test("a repeated 401 refreshes exactly once and surfaces the retry error", async () => {
  await withMockApi(
    async (client, requests) => {
      const started = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(started.isError, false, started.text);

      const result = await callTool(client, "get_onboarding_status");
      assert.equal(result.isError, true);
      assert.match(result.text, /Onboarding status failed \(401\)/);

      const statuses = requests.filter(
        (request) => parseUrl(request).pathname === `/api/onboard/agent/trials/${TRIAL_HANDLE}`,
      );
      const refreshes = requests.filter(
        (request) => parseUrl(request).pathname === "/api/onboard/agent/refresh",
      );
      assert.equal(statuses.length, 2, "the request must be attempted only twice");
      assert.equal(refreshes.length, 1, "the retry must not start another refresh loop");
      assert.equal(statuses[1].headers.authorization, `Bearer ${REFRESHED_ACCESS_TOKEN}`);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        [`/api/onboard/agent/trials/${TRIAL_HANDLE}`]: () => ({
          status: 401,
          json: { error: "still unauthorized" },
        }),
        "/api/onboard/agent/refresh": () => ({
          status: 200,
          json: { access_token: REFRESHED_ACCESS_TOKEN, expires_in: 3600 },
        }),
      }),
    },
  );
});

test("a session expiring within 30 seconds refreshes before its first authed request", async () => {
  const expiringStartResponse = {
    ...START_RESPONSE,
    session: { access_token: ACCESS_TOKEN, expires_in: 1 },
  };

  await withMockApi(
    async (client, requests) => {
      const started = await callTool(client, "onboard_start", { url: "https://example.com" });
      assert.equal(started.isError, false, started.text);
      const result = await callTool(client, "get_onboarding_status");
      assert.equal(result.isError, false, result.text);

      const refreshIndex = requests.findIndex(
        (request) => parseUrl(request).pathname === "/api/onboard/agent/refresh",
      );
      const statusRequests = requests.filter(
        (request) => parseUrl(request).pathname === `/api/onboard/agent/trials/${TRIAL_HANDLE}`,
      );
      const statusIndex = requests.indexOf(statusRequests[0]);
      assert.ok(refreshIndex >= 0 && refreshIndex < statusIndex, "refresh must precede status");
      assert.equal(statusRequests.length, 1);
      assert.equal(statusRequests[0].headers.authorization, `Bearer ${REFRESHED_ACCESS_TOKEN}`);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        "/api/onboard/agent/start": () => ({ status: 202, json: expiringStartResponse }),
        "/api/onboard/agent/refresh": () => ({
          status: 200,
          json: { access_token: REFRESHED_ACCESS_TOKEN, expires_in: 3600 },
        }),
        [`/api/onboard/agent/trials/${TRIAL_HANDLE}`]: () => ({
          status: 200,
          json: STATUS_RESPONSE,
        }),
      }),
    },
  );
});

test("separate onboard_start calls use different startRequestIds", async () => {
  await withMockApi(
    async (client, requests) => {
      const first = await callTool(client, "onboard_start", { url: "https://one.example.com" });
      const second = await callTool(client, "onboard_start", { url: "https://two.example.com" });
      assert.equal(first.isError, false, first.text);
      assert.equal(second.isError, false, second.text);

      const starts = requests
        .filter((request) => parseUrl(request).pathname === "/api/onboard/agent/start")
        .map((request) => JSON.parse(request.body));
      assert.equal(starts.length, 2);
      assert.notEqual(starts[0].startRequestId, starts[1].startRequestId);
    },
    { apiKey: null, handler: onboardingHandler() },
  );
});

test("a failed onboard_start leaves the previous session intact", async () => {
  let startCalls = 0;
  const rejectedAccessToken = "access_token_rejected_start_secret";
  const rejectedSessionHandle = "sessionHandle_rejected_start_secret";

  await withMockApi(
    async (client, requests) => {
      const first = await callTool(client, "onboard_start", { url: "https://one.example.com" });
      assert.equal(first.isError, false, first.text);

      const failed = await callTool(client, "onboard_start", { url: "https://two.example.com" });
      assert.equal(failed.isError, true);
      assert.match(failed.text, /Onboarding start failed \(502\): response body \(\d+ bytes\)/);
      assert.doesNotMatch(failed.text, new RegExp(rejectedAccessToken));
      assert.doesNotMatch(failed.text, new RegExp(rejectedSessionHandle));

      const status = await callTool(client, "get_onboarding_status");
      assert.equal(status.isError, false, status.text);
      const statusRequest = requests.find(
        (request) => parseUrl(request).pathname === `/api/onboard/agent/trials/${TRIAL_HANDLE}`,
      );
      assert.equal(statusRequest.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        "/api/onboard/agent/start": () => {
          startCalls += 1;
          return startCalls === 1
            ? { status: 202, json: START_RESPONSE }
            : {
                status: 502,
                json: {
                  access_token: rejectedAccessToken,
                  sessionHandle: rejectedSessionHandle,
                },
              };
        },
        [`/api/onboard/agent/trials/${TRIAL_HANDLE}`]: () => ({
          status: 200,
          json: STATUS_RESPONSE,
        }),
      }),
    },
  );
});

test("the onboard CLI redacts session-bearing progress and catch output", async () => {
  await withMockApi(
    async (_client, _requests, baseUrl) => {
      const result = await spawnServer(
        ["onboard", "https://example.com", "--base-url", baseUrl],
        {
          scrub: [
            "LAYERS_API_KEY",
            "LAYERS_BASE_URL",
            "LAYERS_ORGANIZATION",
            "LAYERS_READ_ONLY",
          ],
        },
      );
      assert.equal(result.code, 1);
      assert.match(result.stdout, /\[redacted\]/);
      assert.match(result.stderr, /\[redacted\]/);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(ACCESS_TOKEN));
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SESSION_HANDLE));
    },
    {
      apiKey: null,
      handler: onboardingHandler({
        [`/api/onboard/agent/trials/${TRIAL_HANDLE}`]: () => ({
          status: 200,
          json: {
            buildState: "failed",
            planState: `${ACCESS_TOKEN}:${SESSION_HANDLE}`,
          },
        }),
      }),
    },
  );
});
