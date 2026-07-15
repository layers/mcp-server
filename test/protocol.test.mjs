// Process & stdio protocol guarantees — hermetic, no key/network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnServer } from "./helpers.mjs";

test("keyless startup runs the onboarding server until it is killed", async () => {
  const { code, signal, stdout, stderr } = await spawnServer([], {
    scrub: ["LAYERS_API_KEY"],
    until: (_out, err) => /keyless onboarding/.test(err),
  });
  assert.equal(code, null, "keyless onboarding server must not exit on its own");
  assert.equal(signal, "SIGTERM", "the test helper should be what stops the live server");
  assert.equal(stdout, "", "an idle MCP server must not write non-protocol output to stdout");
  assert.match(stderr, /keyless onboarding/, "startup banner must identify keyless onboarding");
});

test("writes only JSON-RPC frames to stdout; diagnostics go to stderr", async () => {
  const initialize =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n";

  // Stop as soon as both signals have arrived: a JSON-RPC frame on stdout and
  // the startup banner on stderr — no fixed sleep, so it can't flake on slow CI.
  const { stdout, stderr } = await spawnServer(["--api-key", "lp_test_dummy"], {
    stdin: initialize,
    until: (out, err) => out.includes("\n") && /running on stdio/.test(err),
  });

  const frames = stdout.split("\n").filter(Boolean);
  assert.ok(frames.length >= 1, "server should answer initialize on stdout");
  for (const frame of frames) {
    const msg = JSON.parse(frame); // throws if any stdout line is not JSON
    assert.equal(msg.jsonrpc, "2.0", "every stdout line must be a JSON-RPC message");
  }
  assert.match(stderr, /running on stdio/, "startup banner belongs on stderr");
  assert.doesNotMatch(stdout, /running on stdio/, "startup banner must never touch stdout");
});
