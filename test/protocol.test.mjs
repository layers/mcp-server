// Process & stdio protocol guarantees — hermetic, no key/network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnServer } from "./helpers.mjs";

test("exits non-zero with a stderr-only message when the API key is missing", async () => {
  const { code, stdout, stderr } = await spawnServer([], { scrub: ["LAYERS_API_KEY"] });
  assert.notEqual(code, 0, "should fail closed without a key");
  assert.equal(stdout, "", "must not write anything to stdout");
  assert.match(stderr, /api key/i, "should explain the missing key on stderr");
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
