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
const readOnly =
  argv.includes("--read-only") || ["1", "true"].includes(process.env.LAYERS_READ_ONLY ?? "");

if (!apiKey) {
  // stderr only — stdout is the JSON-RPC channel
  console.error("Missing API key. Pass --api-key lp_... or set LAYERS_API_KEY.");
  process.exit(1);
}

const server = new McpServer({ name: "layers", version: "0.1.0" });
const client = new LayersClient(apiKey, baseUrl);

registerCoreTools(server, client, readOnly);
registerCreativeTools(server, client, readOnly);
registerDistributionTools(server, client, readOnly);
registerMeasurementTools(server, client, readOnly);
registerFrameworkTools(server, client, readOnly);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `layers mcp server running on stdio (base: ${baseUrl}${readOnly ? ", read-only" : ""})`,
);
