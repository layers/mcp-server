import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LayersClient, clean, READ_ONLY, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE } from "../api.js";

const cursor = z
  .string()
  .optional()
  .describe("Opaque pagination cursor from a previous response's nextCursor");

const gender = z.enum(["male", "female", "non_binary"]);
const ageRange = z.enum(["teen", "young_adult", "adult", "mid_adult", "mature", "senior"]);
const brandVoice = z.enum(["authentic", "witty", "professional", "warm", "casual", "educational"]);
const contentStatus = z.enum(["queued", "processing", "completed", "failed", "canceled"]);
const contentFormat = z.enum(["slideshow-builder", "ugc-remix", "video-remix", "slideshow-remix"]);

const utcTimestamp = (what: string) =>
  z.string().optional().describe(`${what} — ISO 8601 UTC with Z suffix`);

export function registerCreativeTools(server: McpServer, client: LayersClient, readOnly: boolean) {
  // ---- Influencers ----

  server.registerTool(
    "list_influencers",
    {
      title: "List influencers",
      annotations: READ_ONLY,
      description:
        "List a project's influencers (AI personas used as on-camera actors), newest first. Soft-deleted influencers are excluded. Returns { items, nextCursor }.",
      inputSchema: {
        projectId: z.string(),
        cursor,
        limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100 (default 25)"),
        status: z.enum(["pending", "training", "ready", "failed"]).optional(),
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/influencers`, { query }),
  );

  server.registerTool(
    "get_influencer",
    {
      title: "Get influencer",
      annotations: READ_ONLY,
      description:
        "Fetch a full influencer record. Only status=ready influencers are usable for content generation without waiting; imageUrl is null until ready.",
      inputSchema: { influencerId: z.string().describe("Influencer ID (inf_<uuid> or bare UUID)") },
    },
    async ({ influencerId }) => client.run("GET", `/v1/influencers/${influencerId}`),
  );

  // ---- Keywords ----

  server.registerTool(
    "get_keywords",
    {
      title: "Get keywords",
      annotations: READ_ONLY,
      description:
        "Read the project's curated TikTok hashtag bank, sorted by score. Empty with refreshedAt=null when never generated — call refresh_keywords. Hashtags can be passed as keyword to get_source_recommendations.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => client.run("GET", `/v1/projects/${projectId}/keywords`),
  );

  // ---- Content reads ----

  server.registerTool(
    "list_content",
    {
      title: "List content",
      annotations: READ_ONLY,
      description:
        "List a project's content containers, newest first. Filter by generation status, format, creativeType, or time window. Each row carries a preview object renderable directly. Returns { items, nextCursor }.",
      inputSchema: {
        projectId: z.string(),
        status: z.array(contentStatus).optional().describe("Filter on generation status (repeatable)"),
        format: z.array(contentFormat).optional().describe("Filter on format (repeatable)"),
        creativeType: z
          .enum(["generated", "uploaded"])
          .optional()
          .describe("Filter by how the content was created (single value, not repeatable)"),
        since: utcTimestamp("Only containers created at or after"),
        until: utcTimestamp("Only containers created at or before"),
        cursor,
        limit: z.number().int().min(1).max(200).optional().describe("Page size (default 25, max 200)"),
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/content`, { query }),
  );

  server.registerTool(
    "get_content",
    {
      title: "Get content container",
      annotations: READ_ONLY,
      description:
        "Full container record: generation status, approvalStatus, hook, caption, preview, and rendered media assets. Safe to call while generation is in-flight (unpopulated fields are null). For live progress prefer get_content_progress.",
      inputSchema: { containerId: z.string().describe("Container ID (cnt_<uuid> or bare UUID)") },
    },
    async ({ containerId }) => client.run("GET", `/v1/content/${containerId}`),
  );

  server.registerTool(
    "get_content_progress",
    {
      title: "Get content progress",
      annotations: READ_ONLY,
      description:
        "Fine-grained generation progress for a container: status, stage, stageProgress (0-1, resets per stage), etaSeconds. Poll until status is completed, failed, or canceled.",
      inputSchema: { containerId: z.string() },
    },
    async ({ containerId }) => client.run("GET", `/v1/content/${containerId}/progress`),
  );

  server.registerTool(
    "get_content_asset",
    {
      title: "Get content asset",
      annotations: READ_ONLY,
      description:
        "Asset descriptor for one media file on a container: durable public CDN URL, kind, and metadata (mimeType, sizeBytes, durationMs, width/height) when available. assetId comes from the container's assets[] or primaryAsset.",
      inputSchema: {
        containerId: z.string(),
        assetId: z.string().describe("Asset ID from container.assets[].assetId (opaque)"),
      },
    },
    async ({ containerId, assetId }) =>
      client.run("GET", `/v1/content/${containerId}/assets/${assetId}`),
  );

  server.registerTool(
    "get_hooks",
    {
      title: "Get hooks bank",
      annotations: READ_ONLY,
      description:
        "Generate a fresh bank of ~20 short hook strings adapted to the project's brand voice and language; pass a chosen one verbatim as hook to generate_slideshow / generate_ugc_remix. Line breaks are encoded as the literal two-character sequence \\n. Requires appName and appDescription on the project. Free (no credits); not persisted — save the chosen hook yourself.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => client.run("GET", `/v1/projects/${projectId}/content/hooks`),
  );

  server.registerTool(
    "get_source_recommendations",
    {
      title: "Get source recommendations",
      annotations: READ_ONLY,
      description:
        "TikTok source candidates for video-remix / slideshow-remix. Without keyword: the project's pre-discovered portfolio. With keyword: live TikTok search. Items carry tiktokId, kind, stats; pass tiktokId as tiktokVideoId to the remix generators.",
      inputSchema: {
        projectId: z.string(),
        keyword: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Switch to live TikTok keyword search (e.g. a hashtag from get_keywords)"),
        kind: z.enum(["video", "slideshow", "mixed"]).optional().describe("Default mixed"),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
        cursor,
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/content/source-recommendations`, { query }),
  );

  // ---- Approval reads ----

  server.registerTool(
    "get_content_review_policy",
    {
      title: "Get content review policy",
      annotations: READ_ONLY,
      description:
        "Read the project's approval policy (auto_approve | review_first_n | review_all), firstN when applicable, and the live pendingCount.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => client.run("GET", `/v1/projects/${projectId}/content-review-policy`),
  );

  if (readOnly) return;

  // ---- Influencer writes ----

  server.registerTool(
    "create_influencer",
    {
      title: "Create influencer",
      annotations: WRITE,
      description:
        "Start an influencer_create job (async, ~1 min). Layers generates the name, portrait, and persona from the project's brand context plus optional hints — there is no name field; read it back with get_influencer once ready. The returned influencerId is safe to reference in generation calls immediately. Note: supplying appDescription at project creation already auto-creates a first influencer.",
      inputSchema: {
        projectId: z.string(),
        gender: gender.optional().describe("Defaults to the project's targetGender, else female"),
        ageRange: ageRange.optional().describe("Defaults to young_adult"),
        prompt: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe('Free-text visual hint, e.g. "barista energy, soft morning light"'),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("POST", `/v1/projects/${projectId}/influencers`, { body: clean(body) }),
  );

  server.registerTool(
    "clone_influencer",
    {
      title: "Clone influencer",
      annotations: WRITE,
      description:
        "Clone an influencer within its project, preserving identity (the clone looks like the source) with optional per-field overrides — designed for fan-out like Maria-EN / Maria-ES. Async: returns a job envelope; poll get_influencer on the new influencerId.",
      inputSchema: {
        influencerId: z.string().describe("Source influencer ID"),
        name: z.string().min(1).max(128).describe("Display name for the clone"),
        overrides: z
          .object({
            gender: gender.optional(),
            ageRange: ageRange.optional(),
            brandVoice: brandVoice.optional(),
            language: z.string().optional().describe("BCP 47 tag, e.g. es-MX"),
          })
          .optional()
          .describe("Partial identity fields applied on top of the source"),
      },
    },
    async ({ influencerId, ...body }) =>
      client.run("POST", `/v1/influencers/${influencerId}/clone`, { body: clean(body) }),
  );

  server.registerTool(
    "update_influencer",
    {
      title: "Update influencer",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Patch influencer identity fields (at least one). For multi-language characters, clone instead of patching language per content. Returns the full updated record.",
      inputSchema: {
        influencerId: z.string(),
        name: z.string().min(1).max(128).optional(),
        gender: gender.optional().describe("Cannot be cleared"),
        ageRange: ageRange.nullable().optional().describe("Pass null to clear"),
        brandVoice: brandVoice.optional(),
        language: z.string().optional().describe("BCP 47 locale tag"),
      },
    },
    async ({ influencerId, ...fields }) =>
      client.run("PATCH", `/v1/influencers/${influencerId}`, { body: clean(fields) }),
  );

  server.registerTool(
    "delete_influencer",
    {
      title: "Delete influencer",
      annotations: DESTRUCTIVE,
      description:
        "Soft-delete (archive) an influencer. It disappears from reads and future selection; existing content that references it keeps working. There is no undelete via the API.",
      inputSchema: {
        influencerId: z.string(),
        reason: z.string().max(1024).optional().describe("Audit note persisted for compliance"),
      },
    },
    async ({ influencerId, reason }) =>
      client.run("DELETE", `/v1/influencers/${influencerId}`, {
        body: reason !== undefined ? { reason } : undefined,
      }),
  );

  // ---- Keyword writes ----

  server.registerTool(
    "refresh_keywords",
    {
      title: "Refresh keywords",
      annotations: WRITE,
      description:
        "Re-run Layers' keyword research agent against the project's appDescription (required — 422 without it). Async, ~4-5 min end-to-end; poll get_keywords until refreshedAt advances. Auto-triggered by project create/update when appDescription is set, so usually only needed for a forced re-run.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) =>
      client.run("POST", `/v1/projects/${projectId}/keywords/refresh`, { body: {} }),
  );

  // ---- Content generation (one tool per format; format is the URL, not a body field) ----

  server.registerTool(
    "generate_slideshow",
    {
      title: "Generate slideshow",
      annotations: WRITE,
      description:
        "Generate a hook-driven multi-image vertical slideshow (slideshow-builder). Async: returns 202 with jobId + containerIds[0]; poll get_content_progress. Requires the project to have appDescription. Costs credits (~50; check get_credits).",
      inputSchema: {
        projectId: z.string(),
        hook: z
          .string()
          .min(1)
          .max(2000)
          .describe("Used verbatim as the first-slide overlay; from get_hooks or your own"),
        socialAccountId: z
          .string()
          .optional()
          .describe("Connected account — anchors the container on the wired layer and its influencer voice"),
        influencerId: z.string().optional().describe("Explicit influencer override (wins over wired)"),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("POST", `/v1/projects/${projectId}/content/slideshow-builder`, { body: clean(body) }),
  );

  server.registerTool(
    "generate_ugc_remix",
    {
      title: "Generate UGC remix",
      annotations: WRITE,
      description:
        "Generate a UGC-style influencer reaction video (ugc-remix). Async job. One of socialAccountId (with wired influencer) or influencerId is REQUIRED (the on-camera actor). Needs an app-demo media asset on the project (or pass mediaId) — fails with details.code MISSING_APP_DEMO otherwise. Reaction template and music auto-selected. Costs credits (~120).",
      inputSchema: {
        projectId: z.string(),
        socialAccountId: z.string().optional().describe("Connected account with a wired influencer"),
        influencerId: z.string().optional().describe("Explicit influencer (one of the two is required)"),
        hook: z.string().min(1).max(2000).optional().describe("Optional opening overlay text"),
        mediaId: z
          .string()
          .optional()
          .describe("Uploaded app-demo clip (med_<id>); defaults to the project's first app-demo asset"),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("POST", `/v1/projects/${projectId}/content/ugc-remix`, { body: clean(body) }),
  );

  server.registerTool(
    "generate_video_remix",
    {
      title: "Generate video remix",
      annotations: WRITE,
      description:
        "Remix a discovered TikTok video (video-remix): the influencer is face-swapped onto the source and overlays are brand-adapted. Async job. tiktokVideoId comes from get_source_recommendations. One of socialAccountId or influencerId is REQUIRED. No hook — pick a different source for different opening text. Costs credits (~120).",
      inputSchema: {
        projectId: z.string(),
        tiktokVideoId: z.string().describe("Source TikTok video id from get_source_recommendations"),
        socialAccountId: z.string().optional(),
        influencerId: z.string().optional().describe("One of socialAccountId/influencerId is required"),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("POST", `/v1/projects/${projectId}/content/video-remix`, { body: clean(body) }),
  );

  server.registerTool(
    "generate_slideshow_remix",
    {
      title: "Generate slideshow remix",
      annotations: WRITE,
      description:
        "Remix a discovered TikTok slideshow (slideshow-remix): slides are regenerated with the influencer's face and brand-adapted text. Async job. tiktokVideoId is the slideshow post id (use get_source_recommendations with kind=slideshow; NOT_A_SLIDESHOW if it's a video). One of socialAccountId or influencerId is REQUIRED. Costs credits (~50).",
      inputSchema: {
        projectId: z.string(),
        tiktokVideoId: z.string().describe("Source TikTok slideshow id"),
        socialAccountId: z.string().optional(),
        influencerId: z.string().optional().describe("One of socialAccountId/influencerId is required"),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("POST", `/v1/projects/${projectId}/content/slideshow-remix`, { body: clean(body) }),
  );

  // ---- Asset upload (uploaded content — creativeType "uploaded") ----
  // caption is required everywhere it appears here, but may be the empty string —
  // so z.string() (NOT .optional(), NOT .min(1)).
  const uploadCaption = z
    .string()
    .max(2200)
    .describe("Caption, published verbatim. Required, but may be the empty string. Max 2200 chars.");

  server.registerTool(
    "create_content_upload",
    {
      title: "Create content upload (direct transport)",
      annotations: WRITE,
      description:
        "Step 1 of the direct-upload transport for large/private files (bytes go client → storage, never through the API). Declares the files and returns a containerId plus a presigned PUT URL per file (expire in ~15 min, no re-presign). You then PUT each file's bytes to its uploadUrl sending exactly the declared Content-Type — this PUT happens OUTSIDE this server — then call finalize_content_upload once per returned containerId. Caps: 100MB video / 30MB image. For already-hosted media, use upload_content_from_url instead.",
      inputSchema: {
        projectId: z.string(),
        files: z
          .array(
            z.object({
              filename: z.string().max(512).describe("Used for the storage key extension"),
              contentType: z
                .enum(["video/mp4", "video/quicktime", "image/jpeg", "image/png", "image/webp"])
                .describe("Signed into the PUT URL — your PUT must send exactly this Content-Type"),
              sizeBytes: z
                .number()
                .int()
                .describe("Declared size; checked vs the cap here and re-checked against actual bytes at finalize"),
            }),
          )
          .min(1)
          .max(10)
          .describe("One entry per file you will PUT"),
        grouping: z
          .enum(["per-file", "slideshow"])
          .describe(
            "per-file = one content item per file (videos are single-file). slideshow = one image-slideshow item (any video in a slideshow grouping is rejected).",
          ),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("POST", `/v1/projects/${projectId}/content/uploads`, { body }),
  );

  server.registerTool(
    "upload_content_from_url",
    {
      title: "Upload content from URL",
      annotations: WRITE,
      description:
        'Upload already-hosted media by URL (URL-fetch transport). Layers fetches each media[].url server-side, validates and probes it, and returns a completed content item (creativeType "uploaded", adsEnrollment opted_out) — synchronous, no job to poll. One video, one image, or 2-10 images (a slideshow). URLs must be public https; sign private URLs for >= 15 min. Atomic: one bad URL means no item is created. Check platformFit on the response before scheduling.',
      inputSchema: {
        projectId: z.string(),
        media: z
          .array(
            z.object({
              url: z.string().describe("Fetchable https URL resolving to a public IP; sign for >= 15 min"),
            }),
          )
          .min(1)
          .max(10)
          .describe("One entry per file: one video, one image, or 2-10 images (slideshow)"),
        caption: uploadCaption,
      },
    },
    async ({ projectId, ...body }) =>
      client.run("POST", `/v1/projects/${projectId}/content/upload`, { body }),
  );

  server.registerTool(
    "finalize_content_upload",
    {
      title: "Finalize content upload",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Step 3 of the direct-upload transport. Call once per containerId from create_content_upload, after every PUT for that item has succeeded. Verifies the bytes landed, probes the media, and completes the item (returns the full content item). Idempotent by state — safe to blind-retry. 409 UPLOAD_INCOMPLETE if a PUT hasn't landed yet. The caption set here publishes verbatim; the retry body is ignored (first caption wins) — use update_content_caption to fix it later.",
      inputSchema: {
        containerId: z.string().describe("Container ID returned by create_content_upload"),
        caption: uploadCaption,
      },
    },
    async ({ containerId, caption }) =>
      client.run("POST", `/v1/content/${containerId}/finalize-upload`, { body: { caption } }),
  );

  server.registerTool(
    "update_content_caption",
    {
      title: "Update content caption",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Update the caption on an UPLOADED content item (PATCH /v1/content/:containerId). Uploads only — generated content returns 422 VALIDATION (regenerate to change it). Returns the full updated item. The caption publishes byte-for-byte; already-published posts keep the caption they went out with. Media is immutable — upload a new item to change the file.",
      inputSchema: {
        containerId: z.string().describe("Uploaded content item ID (cnt_<uuid> or bare UUID)"),
        caption: uploadCaption,
      },
    },
    async ({ containerId, caption }) =>
      client.run("PATCH", `/v1/content/${containerId}`, { body: { caption } }),
  );

  // ---- Approval writes ----

  server.registerTool(
    "approve_content",
    {
      title: "Approve content",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Flip a container's approvalStatus from pending to approved, unblocking scheduling/publishing. If a schedule was stashed while blocked on approval, it is promoted atomically (see pendingSchedulePromotion in the response). 409 CONFLICT if already approved/rejected or approval is not required.",
      inputSchema: {
        containerId: z.string(),
        note: z.string().max(1024).optional().describe("Audit note"),
      },
    },
    async ({ containerId, note }) =>
      client.run("POST", `/v1/content/${containerId}/approve`, { body: clean({ note }) }),
  );

  server.registerTool(
    "reject_content",
    {
      title: "Reject content",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Flip a container's approvalStatus to rejected — a one-way gate (rejected containers can't be scheduled; approved ones can't be rejected). To get a new take, generate again with a fresh hook. Container must be completed.",
      inputSchema: {
        containerId: z.string(),
        reason: z.string().min(1).max(1024).describe("Rejection note, stored for audit"),
      },
    },
    async ({ containerId, reason }) =>
      client.run("POST", `/v1/content/${containerId}/reject`, { body: { reason } }),
  );

  server.registerTool(
    "update_content_review_policy",
    {
      title: "Update content review policy",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Change the project's approval policy. firstN (1-50) is required when policy is review_first_n and forbidden otherwise. With review_first_n, the gate self-disables once firstN containers have been approved or rejected.",
      inputSchema: {
        projectId: z.string(),
        policy: z.enum(["auto_approve", "review_first_n", "review_all"]),
        firstN: z.number().int().min(1).max(50).optional().describe("Required iff policy=review_first_n"),
      },
    },
    async ({ projectId, ...body }) =>
      client.run("PATCH", `/v1/projects/${projectId}/content-review-policy`, { body: clean(body) }),
  );
}
