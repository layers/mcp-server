// Elle MCP bridge — unit tests with injected clients/transports, so retries and
// credential handling stay hermetic and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OnboardingBridge } from "../dist/onboarding/bridge.js";
import { registerBridgedOnboardingTools } from "../dist/onboarding/bridged-tools.js";

const ACCESS_TOKEN = "access_token_bridge_secret_old";
const REFRESHED_ACCESS_TOKEN = "access_token_bridge_secret_new";
const SESSION_HANDLE = "sessionHandle_bridge_secret";
const TRIAL_HANDLE = "trial_bridge_123";

function session(accessToken = ACCESS_TOKEN) {
  return {
    accessToken,
    expiresAtMs: Date.now() + 3_600_000,
    sessionHandle: SESSION_HANDLE,
    trialHandle: TRIAL_HANDLE,
    claimToken: "claim_bridge_123",
    previewUrl: "https://layers.test/p/bridge",
    claimUrl: "https://layers.test/claim?token=claim_bridge_123",
  };
}

function headerAuthorization(options) {
  return new Headers(options.requestInit?.headers).get("authorization");
}

function fakeClient({ callTool, onConnect, onClose } = {}) {
  return {
    onclose: undefined,
    async connect(transport) {
      await onConnect?.(transport);
    },
    async callTool(params) {
      return await callTool?.(params);
    },
    async close() {
      await onClose?.();
      this.onclose?.();
    },
  };
}

test("bridged tool registration maps ask_elle to Elle's remote name and arguments", async () => {
  const registered = new Map();
  const server = {
    registerTool(name, config, handler) {
      registered.set(name, { config, handler });
    },
  };
  const calls = [];
  const remoteResult = { content: [{ type: "text", text: "remote result" }] };
  const bridge = {
    async callBridged(name, args) {
      calls.push({ name, args });
      return remoteResult;
    },
  };

  registerBridgedOnboardingTools(
    server,
    "https://api.layers.test",
    "https://elle.layers.test",
    bridge,
  );

  assert.deepEqual([...registered.keys()], ["ask_elle"]);
  assert.match(registered.get("ask_elle").config.description, /Elle/i);
  assert.doesNotMatch(registered.get("ask_elle").config.description, /questionnaire/i);
  assert.deepEqual(
    await registered.get("ask_elle").handler({ message: "What should I launch first?" }),
    remoteResult,
  );
  assert.deepEqual(calls, [
    {
      name: "ask_onboardingGuide",
      args: { message: "What should I launch first?" },
    },
  ]);
});

test("a 401 refreshes once, reconnects, and retries with the new bearer token", async () => {
  let currentSession = session();
  let refreshes = 0;
  let toolCalls = 0;
  const transports = [];
  const calls = [];

  const bridge = new OnboardingBridge(
    "https://api.layers.test/base",
    "https://elle.layers.test/base",
    {
      getSession: () => currentSession,
      refreshSession: async (baseUrl) => {
        refreshes += 1;
        assert.equal(baseUrl, "https://api.layers.test/base");
        currentSession = session(REFRESHED_ACCESS_TOKEN);
      },
      createTransport: (url, options) => {
        const transport = {};
        transports.push({ url: url.toString(), options, transport });
        return transport;
      },
      createClient: () =>
        fakeClient({
          callTool: async (params) => {
            toolCalls += 1;
            calls.push(params);
            if (toolCalls === 1) {
              const error = new Error(`401 Unauthorized: ${ACCESS_TOKEN}`);
              error.code = 401;
              throw error;
            }
            return { content: [{ type: "text", text: "Elle answered" }] };
          },
        }),
    },
  );

  const result = await bridge.callBridged("ask_onboardingGuide", {
    message: "Help me position this",
  });

  assert.deepEqual(result, { content: [{ type: "text", text: "Elle answered" }] });
  assert.equal(refreshes, 1);
  assert.equal(toolCalls, 2);
  assert.deepEqual(calls, [
    { name: "ask_onboardingGuide", arguments: { message: "Help me position this" } },
    { name: "ask_onboardingGuide", arguments: { message: "Help me position this" } },
  ]);
  assert.equal(transports.length, 2);
  assert.equal(
    transports[0].url,
    `https://elle.layers.test/api/mcp/onboarding/mcp?trial=${TRIAL_HANDLE}`,
  );
  assert.equal(headerAuthorization(transports[0].options), `Bearer ${ACCESS_TOKEN}`);
  assert.equal(
    headerAuthorization(transports[1].options),
    `Bearer ${REFRESHED_ACCESS_TOKEN}`,
  );
});

test("a connection-drop error reconnects and retries exactly once", async () => {
  let toolCalls = 0;
  let refreshes = 0;
  let transports = 0;
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession: () => session(),
    refreshSession: async () => {
      refreshes += 1;
    },
    createTransport: () => {
      transports += 1;
      return {};
    },
    createClient: () =>
      fakeClient({
        callTool: async () => {
          toolCalls += 1;
          if (toolCalls === 1) {
            const error = new Error("socket hang up");
            error.code = "ECONNRESET";
            throw error;
          }
          return { content: [{ type: "text", text: "reconnected" }] };
        },
      }),
  });

  const result = await bridge.callBridged("ask_onboardingGuide", { message: "resume" });
  assert.equal(result.content[0].text, "reconnected");
  assert.equal(toolCalls, 2);
  assert.equal(transports, 2);
  assert.equal(refreshes, 0, "a dropped connection must not refresh a valid token");
});

test("a stale MCP session (Elle restarted) reconnects and retries exactly once", async () => {
  let toolCalls = 0;
  let refreshes = 0;
  let transports = 0;
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession: () => session(),
    refreshSession: async () => {
      refreshes += 1;
    },
    createTransport: () => {
      transports += 1;
      return {};
    },
    createClient: () =>
      fakeClient({
        callTool: async () => {
          toolCalls += 1;
          if (toolCalls === 1) {
            // Shape the remote server returns after it forgets the transport.
            const error = new Error(
              'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Session not found"},"id":null}',
            );
            error.code = -32000;
            throw error;
          }
          return { content: [{ type: "text", text: "resumed" }] };
        },
      }),
  });

  const result = await bridge.callBridged("ask_onboardingGuide", { message: "hi" });
  assert.equal(result.content[0].text, "resumed");
  assert.equal(toolCalls, 2);
  assert.equal(transports, 2);
  assert.equal(refreshes, 0, "a stale session must not refresh a valid token");
});

test("a transport-reported close reconnects before the next bridged call", async () => {
  const clients = [];
  let transports = 0;
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession: () => session(),
    refreshSession: async () => assert.fail("closed transport should reconnect without refresh"),
    createTransport: () => {
      transports += 1;
      return {};
    },
    createClient: () => {
      const client = fakeClient({
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      });
      clients.push(client);
      return client;
    },
  });

  await bridge.callBridged("ask_onboardingGuide", { message: "first" });
  clients[0].onclose();
  await bridge.callBridged("ask_onboardingGuide", { message: "second" });

  assert.equal(clients.length, 2);
  assert.equal(transports, 2);
});

test("remote results and errors cannot echo onboarding credentials", async () => {
  const remoteRefreshToken = "opaque-remote-refresh-secret";
  let throwInstead = false;
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession: () => session(),
    refreshSession: async () => assert.fail("redaction errors are not auth retries"),
    createTransport: () => ({}),
    createClient: () =>
      fakeClient({
        callTool: async () => {
          const echoed = `${ACCESS_TOKEN} ${SESSION_HANDLE} refresh_token=${remoteRefreshToken}`;
          if (throwInstead) throw new Error(`remote failure echoed ${echoed}`);
          return {
            content: [{ type: "text", text: echoed }],
            structuredContent: {
              access_token: ACCESS_TOKEN,
              sessionHandle: SESSION_HANDLE,
              refresh_token: remoteRefreshToken,
            },
          };
        },
      }),
  });

  const resultText = JSON.stringify(
    await bridge.callBridged("ask_onboardingGuide", { message: "redact" }),
  );
  for (const secret of [ACCESS_TOKEN, SESSION_HANDLE, remoteRefreshToken]) {
    assert.doesNotMatch(resultText, new RegExp(secret));
  }
  assert.match(resultText, /\[redacted\]/);

  throwInstead = true;
  await assert.rejects(bridge.callBridged("ask_onboardingGuide", { message: "redact" }), (error) => {
    for (const secret of [ACCESS_TOKEN, SESSION_HANDLE, remoteRefreshToken]) {
      assert.doesNotMatch(error.message, new RegExp(secret));
    }
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("a repeated 401 is bounded to one refresh and one retry", async () => {
  let currentSession = session();
  let refreshes = 0;
  let calls = 0;
  const bridge = new OnboardingBridge("https://api.layers.test", "https://elle.layers.test", {
    getSession: () => currentSession,
    refreshSession: async () => {
      refreshes += 1;
      currentSession = session(REFRESHED_ACCESS_TOKEN);
    },
    createTransport: () => ({}),
    createClient: () =>
      fakeClient({
        callTool: async () => {
          calls += 1;
          const error = new Error(`401 still unauthorized ${currentSession.accessToken}`);
          error.code = 401;
          throw error;
        },
      }),
  });

  await assert.rejects(bridge.callBridged("ask_onboardingGuide", { message: "retry" }), (error) => {
    assert.match(error.message, /401 still unauthorized/);
    assert.doesNotMatch(error.message, new RegExp(ACCESS_TOKEN));
    assert.doesNotMatch(error.message, new RegExp(REFRESHED_ACCESS_TOKEN));
    return true;
  });
  assert.equal(refreshes, 1);
  assert.equal(calls, 2);
});
