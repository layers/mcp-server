// Test helpers for the Layers MCP server.
//
// Everything here is hermetic: tests spawn the built server as a child process
// and either drive it over stdio or point it at a throwaway localhost mock — no
// Layers API key and no outbound network are required.
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = path.join(ROOT, "dist", "index.js");

/** Connect an MCP client to a freshly spawned server. Caller must client.close().
 *  Pass apiKey: null for keyless mode; extraEnv can exercise env-key resolution. */
export async function startClient(
  extraArgs = [],
  { apiKey = "lp_test_dummy", baseUrl, extraEnv = {} } = {},
) {
  const args = [SERVER];
  if (apiKey !== null) args.push("--api-key", apiKey);
  if (baseUrl) args.push("--base-url", baseUrl);
  args.push(...extraArgs);
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  for (const key of [
    "LAYERS_API_KEY",
    "LAYERS_BASE_URL",
    "LAYERS_ORGANIZATION",
    "LAYERS_READ_ONLY",
  ]) {
    delete env[key];
  }
  Object.assign(env, extraEnv);
  const transport = new StdioClientTransport({ command: process.execPath, args, env });
  const client = new Client({ name: "layers-mcp-tests", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** List the server's registered tools, then tear the client down. */
export async function listTools(extraArgs = [], options = {}) {
  const client = await startClient(extraArgs, options);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

/** Call a tool and flatten its result to { isError, text }.
 *  Text-result tools only — non-text content parts are ignored (the server
 *  emits text-only results today). */
export async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  return { isError: !!res.isError, text };
}

/**
 * Run `fn(client, requests)` with the server pointed at a localhost recorder.
 * `requests` accumulates every captured { method, url, headers, body }.
 * `handler(req, captured)` may return { status, json, text, headers } or { destroy: true };
 * the default is a 200 with an empty list page.
 */
export async function withMockApi(
  fn,
  { extraArgs = [], apiKey = "lp_test_x", extraEnv = {}, handler } = {},
) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const captured = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(captured);
      try {
        const out = (await handler?.(req, captured)) ?? {
          status: 200,
          json: { ok: true, items: [], nextCursor: null },
        };
        if (out.destroy) {
          req.socket.destroy();
          return;
        }
        res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
        res.end(out.text ?? JSON.stringify(out.json));
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "mock handler failed" }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = await startClient(extraArgs, { apiKey, baseUrl, extraEnv });
  try {
    return await fn(client, requests, baseUrl);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
  }
}

/** Parse a recorded request URL into a URL object (for pathname / searchParams). */
export const parseUrl = (req) => new URL(req.url, "http://mock.local");

/**
 * Spawn the server directly for process-level checks (exit code, raw stdout/stderr).
 * `scrub` deletes env vars before launch; `stdin` is written (not closed).
 * For a long-running server, pass `until(stdout, stderr) => boolean` to stop as
 * soon as the expected output has arrived (event-driven, not a fixed sleep);
 * `killAfterMs` is the hard fallback cap.
 */
export function spawnServer(args = [], { extraEnv = {}, scrub = [], stdin, until, killAfterMs = 5000 } = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of scrub) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], { env });
    let stdout = "", stderr = "", settled = false, cap;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      resolve({ code, signal, stdout, stderr });
    };
    const maybeStop = () => { if (until?.(stdout, stderr)) child.kill(); };
    child.stdout.on("data", (d) => { stdout += d; maybeStop(); });
    child.stderr.on("data", (d) => { stderr += d; maybeStop(); });
    child.on("exit", (code, signal) => finish(code, signal));
    if (stdin !== undefined) child.stdin.write(stdin);
    cap = setTimeout(() => child.kill(), killAfterMs);
    cap.unref?.();
  });
}
