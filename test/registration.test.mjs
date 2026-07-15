// Tool registration & read-only gating — hermetic, no key/network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools, spawnServer, startClient } from "./helpers.mjs";

const LEGACY_FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/legacy-tools.json", import.meta.url), "utf8"),
);

async function legacySnapshot({ apiKey, extraEnv = {} }) {
  const client = await startClient([], { apiKey, extraEnv });
  let tools;
  let instructions;
  try {
    tools = (await client.listTools()).tools;
    instructions = client.getInstructions();
  } finally {
    await client.close();
  }

  const args = apiKey === null ? [] : ["--api-key", apiKey];
  const scrub = ["LAYERS_BASE_URL", "LAYERS_ORGANIZATION", "LAYERS_READ_ONLY"];
  if (apiKey !== null) scrub.push("LAYERS_API_KEY");
  const processResult = await spawnServer(args, {
    extraEnv,
    scrub,
    until: (_stdout, stderr) => /layers mcp server running on stdio/.test(stderr),
  });
  assert.equal(processResult.code, null, "legacy server must remain alive after startup");
  assert.equal(processResult.signal, "SIGTERM");
  const startupLogLine = processResult.stderr
    .split(/\r?\n/)
    .find((line) => line.includes("layers mcp server running on stdio"));
  assert.ok(startupLogLine, "legacy startup log line must be present");

  return {
    sortedToolNames: tools.map((tool) => tool.name).sort(),
    instructionsSha256: createHash("sha256").update(instructions ?? "").digest("hex"),
    startupLogLine,
  };
}

// The complete set of mutating tools. Read-only mode must hide exactly these.
const WRITE_TOOLS = [
  // core
  "create_project", "update_project", "archive_project",
  // creative
  "create_influencer", "clone_influencer", "update_influencer", "delete_influencer",
  "refresh_keywords", "generate_slideshow", "generate_ugc_remix", "generate_video_remix",
  "generate_slideshow_remix", "create_content_upload", "upload_content_from_url",
  "finalize_content_upload", "update_content_caption", "approve_content", "reject_content",
  "update_content_review_policy",
  // distribution
  "publish_content", "schedule_content", "reschedule_post", "cancel_scheduled_post",
  "notify_device", "update_engagement_config",
  // measurement
  "update_ads_content", "update_recommendation",
].sort();

test("registers all 52 tools by default", async () => {
  const tools = await listTools();
  assert.equal(tools.length, 52);
});

test("both API-key forms match the checked-in legacy registration fixture", async () => {
  const fromFlag = await legacySnapshot({ apiKey: "lp_x" });
  const fromEnvironment = await legacySnapshot({
    apiKey: null,
    extraEnv: { LAYERS_API_KEY: "lp_x" },
  });

  assert.deepEqual(fromFlag, LEGACY_FIXTURE);
  assert.deepEqual(fromEnvironment, LEGACY_FIXTURE);
});

test("--read-only exposes exactly the 25 read tools and hides every write tool", async () => {
  const full = (await listTools()).map((t) => t.name);
  const readOnly = (await listTools(["--read-only"])).map((t) => t.name);

  assert.equal(full.length, 52);
  assert.equal(readOnly.length, 25);

  const hidden = full.filter((n) => !readOnly.includes(n)).sort();
  assert.deepEqual(hidden, WRITE_TOOLS, "the hidden set must equal the known write tools");

  for (const w of WRITE_TOOLS) {
    assert.ok(full.includes(w), `${w} should exist in the full tool set`);
    assert.ok(!readOnly.includes(w), `${w} must be hidden in --read-only`);
  }
});

test("advertises substantive usage instructions for context/state guidance", async () => {
  const client = await startClient();
  const instructions = client.getInstructions();
  await client.close();
  assert.ok(instructions && instructions.length > 200, "server should return substantive instructions");
  // the instructions exist to tell the agent what to hold between calls
  assert.match(instructions, /stateless/i);
  assert.match(instructions, /nextCursor/);
});

test("every tool is snake_case with a real description and an input schema", async () => {
  const tools = await listTools();
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `non-snake_case tool name: ${t.name}`);
    assert.ok((t.description ?? "").length >= 20, `${t.name} lacks a substantive description`);
    assert.ok(t.inputSchema && typeof t.inputSchema === "object", `${t.name} lacks an inputSchema`);
  }
});
