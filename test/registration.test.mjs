// Tool registration & read-only gating — hermetic, no key/network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "./helpers.mjs";

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

test("every tool is snake_case with a real description and an input schema", async () => {
  const tools = await listTools();
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `non-snake_case tool name: ${t.name}`);
    assert.ok((t.description ?? "").length >= 20, `${t.name} lacks a substantive description`);
    assert.ok(t.inputSchema && typeof t.inputSchema === "object", `${t.name} lacks an inputSchema`);
  }
});
