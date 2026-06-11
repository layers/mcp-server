#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Parse CLI flags so it installs like the Supabase server
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const apiKey  = flag("api-key")  ?? process.env.LAYERS_API_KEY;
const baseUrl = flag("base-url") ?? "https://api.layers.com/v1";

if (!apiKey) {
  console.error("Missing --api-key (or LAYERS_API_KEY env var)");
  process.exit(1);
}

const server = new McpServer({ name: "layers", version: "0.1.0" });

server.registerTool(
  "list_influencers",
  {
    title: "List influencers",
    description: "List social accounts / influencers on the Layers platform",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  },
  async ({ limit }) => {
    const res = await fetch(`${baseUrl}/influencers?limit=${limit}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `Layers API ${res.status}: ${await res.text()}` }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(await res.json(), null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — see note below
console.error("layers mcp server running on stdio");