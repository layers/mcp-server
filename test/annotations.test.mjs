// Tool annotation hints — the canonical classification, asserted so neither a
// misclassification nor a dropped annotation can slip through. Hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "./helpers.mjs";

// Reads — readOnlyHint: true (the 25 read tools).
const READS = [
  "whoami", "list_projects", "get_project", "get_credits", "list_credit_events",
  "list_influencers", "get_influencer", "get_keywords", "list_content", "get_content",
  "get_content_progress", "get_content_asset", "get_hooks", "get_source_recommendations",
  "get_content_review_policy",
  "list_social_accounts", "get_scheduled_post", "list_scheduled_posts", "list_tiktok_music",
  "get_engagement_config",
  "get_metrics", "get_top_performers", "list_ads_content", "list_recommendations",
  "list_audit_log",
].sort();

// Destructive writes — removes/cancels.
const DESTRUCTIVE = ["archive_project", "delete_influencer", "cancel_scheduled_post"].sort();

// Idempotent writes — PATCH/set or state-stable (repeat → same state).
const IDEMPOTENT_WRITES = [
  "update_project", "update_influencer", "finalize_content_upload", "update_content_caption",
  "approve_content", "reject_content", "update_content_review_policy", "reschedule_post",
  "update_engagement_config", "update_ads_content", "update_recommendation",
].sort();

// Additive writes — create/generate/publish; repeating does more (not idempotent).
const ADDITIVE_WRITES = [
  "create_project", "create_influencer", "clone_influencer", "refresh_keywords",
  "generate_slideshow", "generate_ugc_remix", "generate_video_remix", "generate_slideshow_remix",
  "create_content_upload", "upload_content_from_url", "publish_content", "schedule_content",
  "notify_device",
].sort();

test("classification covers all 52 tools exactly once", () => {
  const all = [...READS, ...DESTRUCTIVE, ...IDEMPOTENT_WRITES, ...ADDITIVE_WRITES];
  assert.equal(all.length, 52);
  assert.equal(new Set(all).size, 52, "no tool appears in two buckets");
});

test("every tool carries annotation hints matching its category", async () => {
  const byName = new Map((await listTools()).map((t) => [t.name, t.annotations ?? {}]));
  assert.equal(byName.size, 52);

  for (const name of READS) {
    const a = byName.get(name);
    assert.equal(a.readOnlyHint, true, `${name} should be readOnlyHint:true`);
  }

  const writes = [...DESTRUCTIVE, ...IDEMPOTENT_WRITES, ...ADDITIVE_WRITES];
  for (const name of writes) {
    assert.equal(byName.get(name).readOnlyHint, false, `${name} should be readOnlyHint:false`);
  }

  for (const name of DESTRUCTIVE) {
    assert.equal(byName.get(name).destructiveHint, true, `${name} should be destructiveHint:true`);
    assert.equal(byName.get(name).idempotentHint, true, `${name} should be idempotentHint:true`);
  }
  for (const name of [...IDEMPOTENT_WRITES, ...ADDITIVE_WRITES]) {
    assert.notEqual(byName.get(name).destructiveHint, true, `${name} should not be destructiveHint:true`);
  }
  for (const name of IDEMPOTENT_WRITES) {
    assert.equal(byName.get(name).idempotentHint, true, `${name} should be idempotentHint:true`);
  }
  for (const name of ADDITIVE_WRITES) {
    assert.notEqual(byName.get(name).idempotentHint, true, `${name} should not be idempotentHint:true`);
  }
});
