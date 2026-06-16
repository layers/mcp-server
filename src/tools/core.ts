import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LayersClient, clean, READ_ONLY, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE } from "../api.js";

const cursor = z
  .string()
  .optional()
  .describe("Opaque pagination cursor from a previous response's nextCursor");

const brandVoice = z.enum(["authentic", "witty", "professional", "warm", "casual", "educational"]);
const targetGender = z.enum(["all", "female", "male"]);

export function registerCoreTools(server: McpServer, client: LayersClient, readOnly: boolean) {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      annotations: READ_ONLY,
      description:
        "Resolve the API key to its Layers organization: organizationId, organizationName, scopes, rateLimitTier, and creditBalance. Cheap liveness/auth check.",
      inputSchema: {},
    },
    async () => client.run("GET", "/v1/whoami"),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      annotations: READ_ONLY,
      description:
        "List the organization's projects, newest first. Cursor-paginated: returns { items, nextCursor }.",
      inputSchema: {
        cursor,
        limit: z.number().int().min(1).max(200).optional().describe("Page size, 1-200 (default 25)"),
        status: z.enum(["active", "archived"]).optional(),
        search: z.string().optional().describe("Case-insensitive substring match on project name"),
        customerExternalId: z
          .string()
          .optional()
          .describe("Return the projects for this customer ID"),
      },
    },
    async (args) => client.run("GET", "/v1/projects", { query: args }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      annotations: READ_ONLY,
      description:
        "Fetch the full project record: brand context, ingest state, platform bundle IDs, metadata.",
      inputSchema: { projectId: z.string().describe("Project ID (prj_<uuid> or bare UUID)") },
    },
    async ({ projectId }) => client.run("GET", `/v1/projects/${projectId}`),
  );

  server.registerTool(
    "get_credits",
    {
      title: "Get credits",
      annotations: READ_ONLY,
      description:
        "Org wallet snapshot: balance, included vs prepaid, billing-period usage, and estimated credits per content format. Call before generating to gate on budget.",
      inputSchema: {},
    },
    async () => client.run("GET", "/v1/credits"),
  );

  server.registerTool(
    "list_credit_events",
    {
      title: "List credit events",
      annotations: READ_ONLY,
      description:
        "Per-event credit ledger (charges, refunds, grants, purchases, adjustments, sub-org allocations), newest first. Org-level events (grants, purchases, adjustments, allocations) have projectId null and are excluded when filtering by projectId.",
      inputSchema: {
        projectId: z.string().optional().describe("Filter to events attributed to one project"),
        eventType: z
          .enum(["usage", "refund", "grant", "purchase", "adjustment", "allocation"])
          .optional()
          .describe("allocation = a credit transfer between you and a child org"),
        since: z.string().optional().describe("ISO 8601 UTC with Z suffix (offset forms rejected)"),
        until: z.string().optional().describe("ISO 8601 UTC with Z suffix"),
        cursor,
        limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100 (default 25)"),
      },
    },
    async (args) => client.run("GET", "/v1/credits/events", { query: args }),
  );

  if (readOnly) return;

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      annotations: WRITE,
      description:
        "Create a project to hold brand context, influencers, social accounts, and content. Synchronous. Supplying appDescription auto-kicks two background workflows: keyword research (~4-5 min, observe via get_keywords) and a first influencer (observe via list_influencers).",
      inputSchema: {
        name: z.string().min(3).max(30).describe("Internal display name"),
        timezone: z.string().describe('IANA timezone (use "UTC" if no preference)'),
        customerExternalId: z
          .string()
          .optional()
          .describe("Your internal customer handle; unique per organization"),
        ownerEmail: z.string().optional().describe("Notification email (defaults to key owner)"),
        primaryLanguage: z.string().optional().describe("BCP-47 tag, e.g. en, pt-BR (default en)"),
        appName: z
          .string()
          .min(3)
          .max(30)
          .optional()
          .describe("Product name the generator anchors hooks/captions on; required before get_hooks works"),
        appDescription: z
          .string()
          .min(100)
          .max(1000)
          .optional()
          .describe("Product pitch for the planner, 100-1000 chars; strongest lever on content quality"),
        tagline: z.string().max(80).optional().describe("Short one-liner used in end-cards/overlays"),
        brandVoice: brandVoice.optional().describe("Caption tone preset (default authentic)"),
        targetGender: targetGender.optional().describe("Audience gender; drives influencer defaults"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Opaque JSON, max 8KB, round-tripped"),
      },
    },
    async (args) => client.run("POST", "/v1/projects", { body: clean(args) }),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Patch user-editable project fields; omitted fields stay unchanged. Changing appDescription to a new value re-kicks background keyword research. metadata is replaced in full, not deep-merged. Returns the full updated record.",
      inputSchema: {
        projectId: z.string(),
        name: z.string().min(3).max(30).optional(),
        status: z
          .enum(["active", "archived"])
          .optional()
          .describe("Archiving stops scheduled posts and generation; does not delete data"),
        ownerEmail: z.string().optional(),
        timezone: z.string().optional().describe("IANA timezone; takes effect on next scheduler tick"),
        primaryLanguage: z.string().optional().describe("BCP-47 tag"),
        customerExternalId: z.string().optional().describe("Must remain unique within the org"),
        appName: z.string().optional().describe("3-30 chars; pass null via update in UI to clear"),
        appDescription: z.string().optional().describe("100-1000 chars"),
        tagline: z.string().max(80).optional(),
        brandVoice: brandVoice.optional(),
        targetGender: targetGender.optional(),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Replaces existing object in full"),
      },
    },
    async ({ projectId, ...fields }) =>
      client.run("PATCH", `/v1/projects/${projectId}`, { body: clean(fields) }),
  );

  server.registerTool(
    "archive_project",
    {
      title: "Archive project",
      annotations: DESTRUCTIVE,
      description:
        "Soft-archive a project (DELETE /v1/projects/:id): flips status to archived, cancels pending scheduled posts, pauses generation. Data is retained and the archive is reversible via update_project with status=active.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => client.run("DELETE", `/v1/projects/${projectId}`),
  );
}
