import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LayersClient, clean } from "../api.js";

const cursor = z
  .string()
  .optional()
  .describe("Opaque pagination cursor from a previous response's nextCursor");

export function registerMeasurementTools(server: McpServer, client: LayersClient, readOnly: boolean) {
  server.registerTool(
    "get_metrics",
    {
      title: "Get metrics",
      description:
        "Organic metrics for a post, social account, project layer, project, or organization. Returns both a bucketed time series and window totals. Engagement rate is weighted-cumulative (sum engagements / sum views). Paid metrics (spend/CPA/ROAS) are NOT here. Windows and buckets are UTC.",
      inputSchema: {
        projectId: z.string().describe("Project ID (path scope)"),
        scope: z.enum(["platform_post", "social_account", "project", "project_layer", "organization"]),
        id: z
          .string()
          .describe(
            "Id of the scoped entity (e.g. the project_id for scope=project, org id from whoami for scope=organization)",
          ),
        metrics: z
          .array(
            z.enum([
              "views",
              "reach",
              "impressions",
              "likes",
              "comments",
              "shares",
              "saves",
              "watch_time_ms",
              "engagement_rate",
              "followers",
              "follower_delta",
              "posts_published",
            ]),
          )
          .optional()
          .describe("Omit for the default bundle for the scope"),
        since: z.string().optional().describe("Window start, inclusive (ISO 8601 UTC Z). Default 30 days ago"),
        until: z.string().optional().describe("Window end, exclusive (ISO 8601 UTC Z). Default now"),
        granularity: z.enum(["hour", "day", "week"]).optional().describe("Default day; hour clamped beyond 90-day windows"),
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/metrics`, { query }),
  );

  server.registerTool(
    "get_top_performers",
    {
      title: "Get top performers",
      description:
        "Top-N creatives in a project ranked by one metric over a 7d/30d/90d window, with organic and paid signals attached. Pre-sorted; one item per creative across platforms. Paid metrics (conversions, roas) only rank promoted creatives. By default only eligibility-gated creatives are included.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        metric: z.enum(["views", "engagement_rate", "conversions", "roas", "watch_time_ms"]),
        window: z.enum(["7d", "30d", "90d"]).optional().describe("Default 30d; no all-time"),
        sourceType: z.array(z.enum(["content_container", "platform_post", "manual"])).optional(),
        platform: z
          .array(z.enum(["instagram", "tiktok", "youtube", "meta_ads", "tiktok_ads", "apple_ads"]))
          .optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
        includeIneligible: z
          .boolean()
          .optional()
          .describe("true bypasses the organic_score >= 4.0 eligibility gate"),
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/top-performers`, { query }),
  );

  server.registerTool(
    "list_ads_content",
    {
      title: "List ads content",
      description:
        "Scored creatives for a project: organicScore (0-10; >= 4.0 is ad-eligible), scoringPool (generated/ugc/manual), eligibility, and override state. Returns { items, nextCursor }. adsContentId is a raw UUID — pass it back unprefixed to update_ads_content.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        scoringPool: z.array(z.enum(["generated", "ugc", "manual"])).optional(),
        minScore: z.number().min(0).max(10).optional().describe("Keep rows with organicScore >= minScore"),
        override: z.enum(["include", "exclude", "none"]).optional(),
        eligible: z.boolean().optional().describe("Keep only items clearing the 4.0 threshold or override=include"),
        sort: z.enum(["score_desc", "score_asc", "scored_at_desc"]).optional().describe("Default score_desc"),
        cursor,
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/ads-content`, { query }),
  );

  server.registerTool(
    "list_recommendations",
    {
      title: "List recommendations",
      description:
        "Ranked Layers-generated suggestions for a project (kinds today: value_propositions, refresh_fatigued). Each item carries a rationale, evidence, confidence (>= 0.7 = act; < 0.5 = show a human), and a machine-executable suggestedAction (relative endpoint + body). Reading changes nothing.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        kind: z.array(z.enum(["value_propositions", "refresh_fatigued"])).optional(),
        status: z.array(z.enum(["open", "acknowledged", "dismissed", "acted_on"])).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        sort: z.enum(["confidence_desc", "created_desc"]).optional().describe("Default confidence_desc"),
        cursor,
        limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
      },
    },
    async ({ projectId, ...query }) =>
      client.run("GET", `/v1/projects/${projectId}/recommendations`, { query }),
  );

  if (readOnly) return;

  server.registerTool(
    "update_ads_content",
    {
      title: "Update ads content override",
      description:
        "Pin a creative in (include) or out (exclude) of ad eligibility, bypassing the organicScore gate; null clears the override and returns to score-based gating. Does not pause already-running ads. Idempotent.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        adsContentId: z.string().describe("Raw UUID from list_ads_content (no prefix)"),
        override: z
          .enum(["include", "exclude"])
          .nullable()
          .describe("include / exclude, or null to clear"),
        note: z.string().max(280).optional().describe("Context saved to the audit log"),
      },
    },
    async ({ projectId, adsContentId, ...body }) =>
      client.run("PATCH", `/v1/projects/${projectId}/ads-content/${adsContentId}`, {
        body: clean(body),
      }),
  );

  server.registerTool(
    "update_recommendation",
    {
      title: "Update recommendation status",
      description:
        "Flip a recommendation's status: acknowledged (seen), dismissed (hide from open view), acted_on (handled), or back to open. Idempotent; the optimizer never overwrites a partner-flipped status.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        recommendationId: z.string().describe("rec_<uuid> from list_recommendations"),
        status: z.enum(["open", "acknowledged", "dismissed", "acted_on"]),
        note: z.string().max(1024).optional().describe("Free-text reason, persisted for audit"),
      },
    },
    async ({ projectId, recommendationId, ...body }) =>
      client.run("PATCH", `/v1/projects/${projectId}/recommendations/${recommendationId}`, {
        body: clean(body),
      }),
  );
}
