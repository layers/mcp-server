import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LayersClient, READ_ONLY } from "../api.js";

export function registerFrameworkTools(server: McpServer, client: LayersClient, _readOnly: boolean) {
  server.registerTool(
    "list_audit_log",
    {
      title: "List audit log",
      annotations: READ_ONLY,
      description:
        "Partner-visible audit trail for the org: one event per material action (api.request, auth.key_rejected, content.approved, scheduled_post.cancelled, ...). Newest first, cursor-paginated. Useful for compliance review, leaked-key forensics (filter apiKeyId), and incident response.",
      inputSchema: {
        eventType: z
          .string()
          .optional()
          .describe('Filter to one event type, e.g. "api.request" or "auth.key_rejected"'),
        projectId: z.string().optional().describe("Filter to events scoped to one project"),
        apiKeyId: z.string().optional().describe("Filter to events attributed to one API key"),
        since: z.string().optional().describe("Inclusive lower bound on occurredAt (ISO 8601 UTC Z)"),
        until: z.string().optional().describe("Inclusive upper bound on occurredAt (ISO 8601 UTC Z)"),
        cursor: z
          .string()
          .optional()
          .describe("Opaque base64-url keyset cursor from a previous response's nextCursor"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200"),
      },
    },
    async (args) => client.run("GET", "/v1/audit-log", { query: args }),
  );
}
