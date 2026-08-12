// Protocol-v1 URL-free reservation state — direct, hermetic unit contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getReservation, redact } from "../dist/onboarding/session.js";
import { startOnboarding } from "../dist/onboarding/tools.js";

const RESERVATION_CAPABILITY = "reservation_capability_process_only_123";

test("a URL-free start retains its capability only in process memory", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });

    if (url.endsWith("/api/onboard/agent/challenge")) {
      return Response.json({ nonce: "reservation_test_nonce", difficulty: 1 });
    }

    if (url.endsWith("/api/onboard/agent/start")) {
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: "trial_reservation_test",
          reservationCapability: RESERVATION_CAPABILITY,
          expiresAt: "2026-08-12T12:00:00.000Z",
          state: "awaiting_evidence",
        },
        { status: 202 },
      );
    }

    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const result = await startOnboarding("https://api.layers.test");
    assert.deepEqual(result, {
      protocolVersion: 1,
      trialHandle: "trial_reservation_test",
      expiresAt: "2026-08-12T12:00:00.000Z",
      state: "awaiting_evidence",
    });
    assert.equal(JSON.stringify(result).includes(RESERVATION_CAPABILITY), false);

    assert.deepEqual(getReservation(), {
      protocolVersion: 1,
      trialHandle: "trial_reservation_test",
      reservationCapability: RESERVATION_CAPABILITY,
      expiresAt: "2026-08-12T12:00:00.000Z",
      state: "awaiting_evidence",
    });
    assert.equal(redact(`secret=${RESERVATION_CAPABILITY}`), "secret=[redacted]");

    const submitted = JSON.parse(requests[1].init.body);
    assert.equal(submitted.protocolVersion, 1);
    assert.equal("url" in submitted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
