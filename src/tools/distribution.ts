import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LayersClient, clean } from "../api.js";

const cursor = z
  .string()
  .optional()
  .describe("Opaque pagination cursor from a previous response's nextCursor");

const target = z.object({
  socialAccountId: z.string().describe("Account id from list_social_accounts, connected to the same project"),
  mode: z
    .enum(["publish", "draft", "managed"])
    .describe(
      "publish: Layers posts automatically. draft: push to the creator's mobile app (TikTok inbox / IG SMS) to finish by hand. managed: dispatch via the project's managed-distribution provider",
    ),
  captionOverride: z.string().max(4000).optional().describe("Replace the container's caption for this target only"),
  firstCommentOverride: z.string().max(4000).optional(),
  tiktokPostSettings: z
    .object({
      privacyLevel: z
        .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
        .optional(),
      disableComment: z.boolean().optional(),
      disableDuet: z.boolean().optional(),
      disableStitch: z.boolean().optional(),
      isBrandOrganic: z.boolean().optional().describe('"Your Brand" promotional-content label'),
      isBrandedContent: z
        .boolean()
        .optional()
        .describe("Paid Partnership label — required by TikTok ToS / FTC for paid promotions"),
    })
    .optional()
    .describe("TikTok-only knobs; ignored on Instagram targets and managed mode"),
  tiktokMusic: z
    .object({
      mode: z.enum(["none", "auto", "manual"]),
      trackId: z.string().optional().describe("Required when mode=manual; from list_tiktok_music"),
    })
    .optional()
    .describe("TikTok music for image/slideshow posts. 422 if set on a draft target. manual degrades to auto on direct publish; managed honors it"),
  shareReelToFeed: z
    .boolean()
    .optional()
    .describe(
      "Instagram Reels placement: true (default) = Reels tab + profile grid; false = Reels tab only. 422 on non-Instagram targets, non-video containers, or modes other than publish",
    ),
});

const targets = z
  .array(target)
  .min(1)
  .max(50)
  .describe("One entry per destination account. Max 50; validation is all-or-nothing across the batch");

export function registerDistributionTools(server: McpServer, client: LayersClient, readOnly: boolean) {
  server.registerTool(
    "list_social_accounts",
    {
      title: "List social accounts",
      description:
        "List every social account attached to a project — OAuth-connected and Layers-leased (leased boolean tells them apart). Use the socialAccountId values as targets for publish_content / schedule_content. status reauth_required means the user must re-consent (handled in the Layers UI).",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        platform: z.enum(["tiktok", "instagram"]).optional(),
        status: z.enum(["connected", "reauth_required", "disconnected"]).optional(),
        leased: z.boolean().optional().describe("true: only leased accounts; false: exclude them"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200"),
        cursor,
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/social-accounts`, { query }),
  );

  server.registerTool(
    "get_scheduled_post",
    {
      title: "Get scheduled post",
      description:
        "Read a scheduled post's state: queued, publishing, draft, published (with externalId/externalUrl), failed (with lastError), or canceled. Poll until terminal. Note: Instagram externalUrl can rarely be null even when live.",
      inputSchema: { scheduledPostId: z.string().describe("Scheduled post ID (sp_<uuid>)") },
    },
    async ({ scheduledPostId }) => client.run("GET", `/v1/scheduled-posts/${scheduledPostId}`),
  );

  server.registerTool(
    "list_scheduled_posts",
    {
      title: "List scheduled posts",
      description:
        "Enumerate a project's scheduled posts, sorted by scheduledFor descending. Filter by status (repeatable), account, or a scheduledFor window. Returns { items, nextCursor }.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        status: z
          .array(z.enum(["queued", "publishing", "draft", "published", "failed", "canceled"]))
          .optional()
          .describe("Repeatable status filter"),
        socialAccountId: z.string().optional().describe("Scope to one connected account"),
        since: z.string().optional().describe("Inclusive lower bound on scheduledFor (ISO 8601 UTC Z)"),
        until: z.string().optional().describe("Inclusive upper bound on scheduledFor (ISO 8601 UTC Z)"),
        cursor,
        limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100 (default 50)"),
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/scheduled-posts`, { query }),
  );

  server.registerTool(
    "list_tiktok_music",
    {
      title: "List TikTok music",
      description:
        "Trending TikTok music catalog (refreshed every 12h). Pass a track's id as tiktokMusic.trackId on publish/schedule targets. Note: manual selection only takes effect on managed mode; direct publish degrades to auto.",
      inputSchema: {},
    },
    async () => client.run("GET", "/v1/tiktok-music"),
  );

  server.registerTool(
    "get_engagement_config",
    {
      title: "Get engagement config",
      description:
        "Read the project's Social Engagement layer config: master enabled switch, first-comment policy, and reply-to-comments policy (auto-reply delay, tone, caps, escalation). 404 if the project has no Social Engagement layer.",
      inputSchema: { projectId: z.string().describe("Project ID") },
    },
    async ({ projectId }) => client.run("GET", `/v1/projects/${projectId}/engagement`),
  );

  if (readOnly) return;

  server.registerTool(
    "publish_content",
    {
      title: "Publish content",
      description:
        "Publish a completed container immediately to up to 50 targets (all-or-nothing). Returns scheduledPostIds — poll get_scheduled_post for terminal state. 403 APPROVAL_REQUIRED if the container is pending approval (publish does NOT stash intent — approve first, then re-issue); 409 CONTENT_REJECTED if rejected. The ~30s lead is your cancel window via cancel_scheduled_post.",
      inputSchema: {
        containerId: z.string().describe("Completed container ID"),
        targets,
      },
    },
    async ({ containerId, targets: t }) =>
      client.run("POST", `/v1/content/${containerId}/publish`, { body: { targets: t } }),
  );

  server.registerTool(
    "schedule_content",
    {
      title: "Schedule content",
      description:
        "Schedule a completed container to publish to up to 50 targets at scheduledFor (a literal UTC instant — convert from local time yourself; the project timezone does NOT shift it). If the container is pending approval, returns 202 with gateStatus=blocked_on_approval and the intent is promoted automatically on approve_content. Each target gets its own scheduledPostId.",
      inputSchema: {
        containerId: z.string().describe("Completed container ID"),
        scheduledFor: z
          .string()
          .describe("When to publish — ISO 8601 UTC with Z suffix, must be in the future"),
        targets,
      },
    },
    async ({ containerId, scheduledFor, targets: t }) =>
      client.run("POST", `/v1/content/${containerId}/schedule`, {
        body: { scheduledFor, targets: t },
      }),
  );

  server.registerTool(
    "reschedule_post",
    {
      title: "Reschedule post",
      description:
        "Move a queued scheduled post to a different future time. Only status=queued posts are reschedulable (409 otherwise). Captions/targets are immutable — cancel and re-schedule from the container to change those.",
      inputSchema: {
        scheduledPostId: z.string().describe("Scheduled post ID"),
        scheduledFor: z.string().describe("New publish time — ISO 8601 UTC with Z suffix, in the future"),
      },
    },
    async ({ scheduledPostId, scheduledFor }) =>
      client.run("POST", `/v1/scheduled-posts/${scheduledPostId}/reschedule`, {
        body: { scheduledFor },
      }),
  );

  server.registerTool(
    "cancel_scheduled_post",
    {
      title: "Cancel scheduled post",
      description:
        "Cancel a post that hasn't started publishing (it stays visible with status=canceled for audit). Best-effort once publishing has begun (409 if the upload already went out). Already-published posts can't be pulled back via the API.",
      inputSchema: {
        scheduledPostId: z.string().describe("Scheduled post ID"),
        reason: z.string().max(1024).optional().describe("Audit-log note"),
      },
    },
    async ({ scheduledPostId, reason }) =>
      client.run("DELETE", `/v1/scheduled-posts/${scheduledPostId}`, {
        body: reason !== undefined ? { reason } : undefined,
      }),
  );

  server.registerTool(
    "notify_device",
    {
      title: "Notify device (text the post)",
      description:
        'The "Text me this post" handoff: sends the container\'s media, caption, and AI-written posting instructions to a phone over iMessage/SMS, for manual posting in the native app. Immediate — not a scheduling path. phoneNumber falls back to the API key owner\'s verified phone when omitted; pass it explicitly for creator handoffs.',
      inputSchema: {
        containerId: z.string().describe("Completed container ID"),
        phoneNumber: z
          .string()
          .optional()
          .describe("Destination phone in E.164 format, e.g. +15551234567"),
      },
    },
    async ({ containerId, phoneNumber }) =>
      client.run("POST", `/v1/content/${containerId}/notify-device`, {
        body: clean({ phoneNumber }),
      }),
  );

  server.registerTool(
    "update_engagement_config",
    {
      title: "Update engagement config",
      description:
        "Partially update the project's engagement automation — pass only what changes; sub-objects merge partially. autoReplyDelay is an ISO-8601 duration between PT30S and PT1H. Safety filters are fixed and always applied. 409 if the project has multiple engagement layers and projectLayerId is omitted.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        projectLayerId: z
          .string()
          .optional()
          .describe("Required only if the project has more than one Social Engagement layer"),
        enabled: z.boolean().optional().describe("Master switch — false pauses without dropping config"),
        firstComment: z
          .object({
            targets: z.array(z.enum(["tiktok", "instagram"])).optional(),
            commentTemplate: z
              .string()
              .min(1)
              .max(500)
              .optional()
              .describe("Literal text (strategy=literal) or style examples for the LLM (strategy=generated)"),
            strategy: z.enum(["literal", "generated"]).optional(),
          })
          .optional(),
        replyToComments: z
          .object({
            targets: z.array(z.enum(["tiktok", "instagram"])).optional(),
            autoReplyDelay: z
              .string()
              .optional()
              .describe("ISO-8601 duration, PT30S to PT1H (default PT3M)"),
            tone: z
              .enum(["authentic", "witty", "professional", "warm", "casual", "educational"])
              .optional(),
            maxPerPostPerHour: z.number().int().min(1).max(60).optional(),
            ignoreCommentsMatching: z
              .array(z.string())
              .max(20)
              .optional()
              .describe("Regex sources; comments matching any pattern are skipped"),
            escalateNegativeSentiment: z.boolean().optional(),
          })
          .optional(),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("PATCH", `/v1/projects/${projectId}/engagement`, { body: clean(body) }),
  );
}
