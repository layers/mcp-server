#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LayersClient } from "./api.js";
import { registerCoreTools } from "./tools/core.js";
import { registerCreativeTools } from "./tools/creative.js";
import { registerDistributionTools } from "./tools/distribution.js";
import { registerMeasurementTools } from "./tools/measurement.js";
import { registerFrameworkTools } from "./tools/framework.js";

// Flag-first, env-fallback config, mirroring the Supabase server's install style.
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

const apiKey = flagValue("api-key") ?? process.env.LAYERS_API_KEY;
const baseUrl = flagValue("base-url") ?? process.env.LAYERS_BASE_URL ?? "https://api.layers.com";
const organization = flagValue("organization") ?? process.env.LAYERS_ORGANIZATION;
const readOnly =
  argv.includes("--read-only") || ["1", "true"].includes(process.env.LAYERS_READ_ONLY ?? "");

if (!apiKey) {
  // stderr only — stdout is the JSON-RPC channel
  console.error("Missing API key. Pass --api-key lp_... or set LAYERS_API_KEY.");
  process.exit(1);
}

// Loaded once into the client's context at initialize — tells the agent what to
// remember between calls (this server is stateless) and the shape of the workflow.
const INSTRUCTIONS = `Wraps the Layers Partner API. The server is STATELESS — it remembers nothing between calls, so YOU must track the IDs and cursors it returns.

IDs: every resource returns a prefixed id (prj_, cnt_, inf_, sp_, sa_, adc_, rec_). Store the exact string and pass it back verbatim — never invent, normalize, or strip it. Responses are the source of truth for ids.

Async work: generate_* , create_influencer, clone_influencer, and refresh_keywords return a 202 job envelope (a jobId, plus containerIds or influencerId depending on the call). The work is NOT done when the call returns — capture the id and poll the matching read until status is terminal (completed/failed/canceled): get_content_progress for content, get_influencer for an influencer, get_keywords for a keyword refresh.

Typical flow: create_project -> get_hooks -> generate_* -> poll get_content_progress -> approve_content (if the project requires review) -> schedule_content or publish_content -> poll get_scheduled_post.

Pagination: list_* return { items, nextCursor }. To get the next page pass nextCursor back as cursor — don't restart. A null/absent nextCursor means you've reached the end.

Idempotency is automatic per call, so calling a create twice creates two resources. Don't blindly retry a create — read first to check whether the prior call already succeeded.

Errors come back as isError text "Layers API <status> <code>". Branch on the code, not the message: NOT_FOUND (wrong or foreign id), VALIDATION (fix the body), APPROVAL_REQUIRED (approve the container first), BILLING_EXHAUSTED (out of credits), RATE_LIMITED (back off and retry). Quote the requestId in support tickets.

Timestamps are UTC with a Z suffix; scheduledFor is a literal UTC instant — convert from local time yourself.`;

const server = new McpServer({ name: "layers", version: "1.0.0" }, { instructions: INSTRUCTIONS });
const client = new LayersClient(apiKey, baseUrl, organization);

registerCoreTools(server, client, readOnly);
registerCreativeTools(server, client, readOnly);
registerDistributionTools(server, client, readOnly);
registerMeasurementTools(server, client, readOnly);
registerFrameworkTools(server, client, readOnly);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `layers mcp server running on stdio (base: ${baseUrl}${organization ? `, org: ${organization}` : ""}${readOnly ? ", read-only" : ""})`,
);
