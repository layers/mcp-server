import { test } from "node:test";
import assert from "node:assert/strict";
import { OnboardingBridge } from "../dist/onboarding/bridge.js";
import { registerBridgedOnboardingTools } from "../dist/onboarding/bridged-tools.js";
import { registerOnboardingTools, getOnboardingStatus } from "../dist/onboarding/tools.js";
import {
  getClaimedApiKey,
  getSession,
  rememberSession,
  updateSessionAccess,
} from "../dist/onboarding/session.js";

const ACCESS_TOKEN = "access_token_postclaim_old";
const TRANSITION_ACCESS_TOKEN = "access_token_postclaim_transition";
const RETRY_ACCESS_TOKEN = "access_token_postclaim_retry";
const SESSION_HANDLE = "sessionHandle_postclaim_secret";
const TRIAL_HANDLE = "trial_postclaim_123";
const CLAIM_TOKEN = "claim_postclaim_456";
const PREVIEW_URL = "https://layers.test/p/postclaim";
const CLAIM_URL = `https://layers.test/claim?token=${CLAIM_TOKEN}`;
const WORKSPACE_URL = "https://layers.test/project/prj_postclaim/chats";
const CONNECT_ACCOUNTS_URL = "https://layers.test/project/prj_postclaim/social/accounts";
const POSTCLAIM_ASSETS = {
  generationStatus: "generating",
  postclaimState: "running",
  estimatedDuration: "these may take a few minutes",
  message: "Your first assets are generating and will appear on the preview page.",
};

function session(accessToken = ACCESS_TOKEN, continuity, links = {}) {
  return {
    accessToken,
    expiresAtMs: Date.now() + 3_600_000,
    sessionHandle: SESSION_HANDLE,
    trialHandle: TRIAL_HANDLE,
    claimToken: CLAIM_TOKEN,
    previewUrl: PREVIEW_URL,
    claimUrl: CLAIM_URL,
    ...links,
    ...(continuity ? { claim: { continuity } } : {}),
  };
}

function fakeClient({ callTool, onClose } = {}) {
  return {
    onclose: undefined,
    async connect() {},
    async callTool(params) {
      return await callTool?.(params);
    },
    async close() {
      await onClose?.();
      this.onclose?.();
    },
  };
}

function header(options, name) {
  return new Headers(options.requestInit?.headers).get(name);
}

function toolRegistry(register) {
  const registered = new Map();
  register({
    registerTool(name, config, handler) {
      registered.set(name, { config, handler });
    },
  });
  return registered;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("pre-claim ask_elle uses only the onboarding MCP path and trial header", async () => {
  rememberSession(session());
  const transports = [];
  const calls = [];
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession,
    refreshSession: async () => assert.fail("pre-claim ask_elle must not refresh"),
    createTransport: (url, options) => {
      transports.push({ url: url.toString(), options });
      return {};
    },
    createClient: () =>
      fakeClient({
        callTool: async (params) => {
          calls.push(params);
          return { content: [{ type: "text", text: "onboarding reply" }] };
        },
      }),
  });
  const registered = toolRegistry((server) =>
    registerBridgedOnboardingTools(
      server,
      "https://api.layers.test",
      "https://elle.layers.test",
      bridge,
    ),
  );

  const result = await registered.get("ask_elle").handler({ message: "hello" });

  assert.equal(result.content[0].text, "onboarding reply");
  assert.equal(transports.length, 1);
  assert.equal(
    transports[0].url,
    `https://elle.layers.test/api/mcp/onboarding/mcp?trial=${TRIAL_HANDLE}`,
  );
  assert.equal(header(transports[0].options, "authorization"), `Bearer ${ACCESS_TOKEN}`);
  assert.equal(header(transports[0].options, "x-layers-onboard-trial"), TRIAL_HANDLE);
  assert.doesNotMatch(transports[0].url, /\/api\/mcp\/elle\/mcp/);
  assert.deepEqual(calls, [{ name: "ask_onboardingGuide", arguments: { message: "hello" } }]);
  await bridge.close();
});

test("onboard_claim_verify same-account claim refreshes before the first full Elle call", async () => {
  rememberSession(session());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/api/onboard/claim/verify");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return jsonResponse({
      status: "claimed",
      organizationId: "org_postclaim",
      continuity: "same_account",
      postclaimAssets: POSTCLAIM_ASSETS,
    });
  };

  try {
    const onboardingTools = toolRegistry((server) =>
      registerOnboardingTools(server, "https://api.layers.test"),
    );
    const verified = await onboardingTools.get("onboard_claim_verify").handler({
      email: "human@example.com",
      code: "123456",
    });
    assert.equal(verified.isError, undefined, verified.content[0].text);
    assert.equal(getSession().claim?.continuity, "same_account");

    const events = [];
    const transports = [];
    let refreshes = 0;
    let toolCalls = 0;
    const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
      getSession,
      refreshSession: async () => {
        refreshes += 1;
        events.push("refresh");
        updateSessionAccess(SESSION_HANDLE, TRANSITION_ACCESS_TOKEN, Date.now() + 3_600_000);
      },
      createTransport: (url, options) => {
        events.push("transport");
        transports.push({ url: url.toString(), options });
        return {};
      },
      createClient: () =>
        fakeClient({
          callTool: async (params) => {
            toolCalls += 1;
            events.push(`call:${params.name}`);
            return { content: [{ type: "text", text: "full reply" }] };
          },
        }),
    });
    const registered = toolRegistry((server) =>
      registerBridgedOnboardingTools(
        server,
        "https://api.layers.test",
        "https://elle.layers.test",
        bridge,
      ),
    );

    const first = await registered.get("ask_elle").handler({ message: "what next?" });
    const second = await registered.get("ask_elle").handler({ message: "and then?" });

    assert.equal(first.content[0].text, "full reply");
    assert.equal(second.content[0].text, "full reply");
    assert.equal(refreshes, 1, "transition refresh runs once");
    assert.equal(toolCalls, 2);
    assert.deepEqual(events, ["refresh", "transport", "call:ask_elle", "call:ask_elle"]);
    assert.equal(transports.length, 1, "the refreshed full connection is reused");
    assert.equal(transports[0].url, "https://elle.layers.test/api/mcp/elle/mcp");
    assert.equal(header(transports[0].options, "authorization"), `Bearer ${TRANSITION_ACCESS_TOKEN}`);
    assert.equal(header(transports[0].options, "x-layers-onboard-trial"), null);
    assert.equal(new URL(transports[0].url).search, "");
    await bridge.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("claim projection failure leaves process claim state untouched", async () => {
  rememberSession(session());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      status: "claimed",
      organizationId: "org_must_not_be_retained",
      continuity: "same_account",
      apiKey: { secret: "lp_live_must_not_be_retained" },
    });

  try {
    const onboardingTools = toolRegistry((server) =>
      registerOnboardingTools(server, "https://api.layers.test"),
    );
    const result = await onboardingTools.get("onboard_claim_verify").handler({
      email: "human@example.com",
      code: "123456",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid public response/);
    assert.equal(getSession().claim, undefined);
    assert.equal(getClaimedApiKey(), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status convergence marks same-account claim and flips ask_elle to the full path", async () => {
  rememberSession(session());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(
      new URL(String(url)).pathname,
      `/api/onboard/agent/trials/${TRIAL_HANDLE}`,
    );
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${ACCESS_TOKEN}`);
    return jsonResponse({
      buildState: "preview_ready",
      planState: "ready",
      claimState: "claimed",
      postclaimState: "running",
      claimed: true,
      continuity: "same_account",
      previewUrl: PREVIEW_URL,
      claimUrl: CLAIM_URL,
      workspaceUrl: WORKSPACE_URL,
      connectAccountsUrl: CONNECT_ACCOUNTS_URL,
      plan: { state: "ready" },
    });
  };

  try {
    await getOnboardingStatus("https://api.layers.test");
    assert.equal(getSession().claim?.continuity, "same_account");
    assert.equal(getSession().workspaceUrl, WORKSPACE_URL);
    assert.equal(getSession().connectAccountsUrl, CONNECT_ACCOUNTS_URL);

    const transports = [];
    const events = [];
    const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
      getSession,
      refreshSession: async () => {
        events.push("refresh");
        updateSessionAccess(SESSION_HANDLE, TRANSITION_ACCESS_TOKEN, Date.now() + 3_600_000);
      },
      createTransport: (url, options) => {
        events.push("transport");
        transports.push({ url: url.toString(), options });
        return {};
      },
      createClient: () =>
        fakeClient({
          callTool: async (params) => {
            events.push(`call:${params.name}`);
            return { content: [{ type: "text", text: "full after status" }] };
          },
        }),
    });
    const registered = toolRegistry((server) =>
      registerBridgedOnboardingTools(
        server,
        "https://api.layers.test",
        "https://elle.layers.test",
        bridge,
      ),
    );

    const result = await registered.get("ask_elle").handler({ message: "I claimed it" });

    assert.equal(result.content[0].text, "full after status");
    assert.deepEqual(events, ["refresh", "transport", "call:ask_elle"]);
    assert.equal(transports[0].url, "https://elle.layers.test/api/mcp/elle/mcp");
    assert.equal(header(transports[0].options, "authorization"), `Bearer ${TRANSITION_ACCESS_TOKEN}`);
    assert.equal(header(transports[0].options, "x-layers-onboard-trial"), null);
    await bridge.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser continuity returns local ask_elle handoff with zero bridge calls", async () => {
  rememberSession(session(ACCESS_TOKEN, "browser", { workspaceUrl: WORKSPACE_URL }));
  let bridgeCalls = 0;
  const registered = toolRegistry((server) =>
    registerBridgedOnboardingTools(
      server,
      "https://api.layers.test",
      "https://elle.layers.test",
      {
        async callBridged() {
          bridgeCalls += 1;
          throw new Error("remote call should not happen");
        },
      },
    ),
  );

  const result = await registered.get("ask_elle").handler({ message: "what now?" });

  assert.equal(bridgeCalls, 0);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Log into your Layers workspace in the browser/i);
  assert.doesNotMatch(result.content[0].text, /https?:\/\//);
});

test("full-path 403 refreshes once, retries once, and redacts full-route tokens", async () => {
  let currentSession = session(ACCESS_TOKEN, "same_account");
  let refreshes = 0;
  let calls = 0;
  const transports = [];
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession: () => currentSession,
    refreshSession: async () => {
      refreshes += 1;
      currentSession = session(
        refreshes === 1 ? TRANSITION_ACCESS_TOKEN : RETRY_ACCESS_TOKEN,
        "same_account",
      );
    },
    createTransport: (url, options) => {
      transports.push({ url: url.toString(), options });
      return {};
    },
    createClient: () =>
      fakeClient({
        callTool: async () => {
          calls += 1;
          if (calls === 1) {
            const error = new Error(`403 anonymous principal: ${TRANSITION_ACCESS_TOKEN}`);
            error.code = 403;
            throw error;
          }
          return {
            content: [
              {
                type: "text",
                text: `recovered ${RETRY_ACCESS_TOKEN} ${SESSION_HANDLE}`,
              },
            ],
          };
        },
      }),
  });

  const result = await bridge.callBridged("ask_elle", { message: "retry" });
  const text = JSON.stringify(result);

  assert.equal(refreshes, 2, "one transition refresh and one 403 retry refresh");
  assert.equal(calls, 2);
  assert.equal(transports.length, 2);
  assert.equal(transports[0].url, "https://elle.layers.test/api/mcp/elle/mcp");
  assert.equal(header(transports[0].options, "authorization"), `Bearer ${TRANSITION_ACCESS_TOKEN}`);
  assert.equal(header(transports[1].options, "authorization"), `Bearer ${RETRY_ACCESS_TOKEN}`);
  assert.doesNotMatch(text, new RegExp(RETRY_ACCESS_TOKEN));
  assert.doesNotMatch(text, new RegExp(SESSION_HANDLE));
  assert.match(text, /\[redacted\]/);
  await bridge.close();
});

test("full-path transition refresh failure degrades to workspace handoff without remote calls", async () => {
  rememberSession(session(ACCESS_TOKEN, "same_account", { workspaceUrl: WORKSPACE_URL }));
  let refreshes = 0;
  let transports = 0;
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession,
    refreshSession: async () => {
      refreshes += 1;
      throw new Error("refresh failed");
    },
    createTransport: () => {
      transports += 1;
      return {};
    },
    createClient: () => fakeClient(),
  });
  const registered = toolRegistry((server) =>
    registerBridgedOnboardingTools(
      server,
      "https://api.layers.test",
      "https://elle.layers.test",
      bridge,
    ),
  );

  const result = await registered.get("ask_elle").handler({ message: "after claim" });

  assert.equal(result.isError, true);
  assert.equal(refreshes, 1);
  assert.equal(transports, 0);
  assert.match(result.content[0].text, /Session ended - continue in your Layers workspace/i);
  assert.match(result.content[0].text, new RegExp(WORKSPACE_URL));
});
