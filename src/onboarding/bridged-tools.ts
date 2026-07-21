import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolResult } from "../api.js";
import { READ_ONLY, WRITE } from "../api.js";
import { getOnboardingBridge, type OnboardingBridge } from "./bridge.js";
import { redact } from "./session.js";

const resultError = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: redact(text) }],
});

const errorMessage = (error: unknown): string =>
  redact(error instanceof Error ? error.message : String(error));

const ASK_ELLE_FALLBACK =
  "Sorry — I didn't quite catch that. Could you say it once more?";

/**
 * Elle's onboarding guide is hosted as an MCP agent-as-tool, so
 * `ask_onboardingGuide` returns Mastra's ENTIRE `generate()` envelope — every
 * step, the full system prompt, token usage, and raw request bodies — JSON
 * stringified into a single text block (tens of KB). Relaying that to the
 * driver is doubly bad: it blows the tool-result size limit (the driver spills
 * it to a file and shell-executes to parse it, surfacing a scary approval
 * prompt to the human) and it leaks Elle's system prompt into the transcript.
 *
 * The human only ever needs Elle's reply — the envelope's top-level `text`.
 * Pull just that out; on anything unexpected return null so the caller shows a
 * safe fallback rather than dumping the envelope.
 */
export function extractElleReply(result: CallToolResult): string | null {
  const parts = Array.isArray(result.content) ? result.content : [];
  for (const part of parts) {
    if (!part || part.type !== "text" || typeof part.text !== "string") continue;
    const trimmed = part.text.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const reply = readEnvelopeText(JSON.parse(trimmed));
        if (reply) return reply;
        // Parsed as the envelope but no reply text — never fall back to the raw
        // JSON, that is exactly the dump we are removing.
        continue;
      } catch {
        // Not actually JSON; treat it as a plain-text reply.
      }
    }
    return part.text;
  }
  return null;
}

function readEnvelopeText(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== "object") return null;
  const record = envelope as { text?: unknown; content?: unknown };
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  // Fallback: stitch assistant text parts if the aggregate `text` is empty.
  if (Array.isArray(record.content)) {
    const joined = record.content
      .filter(
        (p): p is { type: string; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("")
      .trim();
    if (joined) return joined;
  }
  return null;
}

export function registerBridgedOnboardingTools(
  server: McpServer,
  apiBaseUrl: string,
  elleMcpBaseUrl: string,
  bridge?: Pick<OnboardingBridge, "callBridged">,
): void {
  const callBridge = (remoteToolName: string, args: Record<string, unknown>) =>
    (bridge ?? getOnboardingBridge(apiBaseUrl, elleMcpBaseUrl)).callBridged(
      remoteToolName,
      args,
    );

  server.registerTool(
    "ask_elle",
    {
      title: "Ask Elle",
      annotations: WRITE,
      description:
        "Elle's onboarding guide — the conversational heart of onboarding. Route EVERY onboarding turn through this: the greeting, the marketing-plan questions, and the five Layers intake questions. Ask one question at a time in Elle's voice and pass the human's reply as message. Do not skip the intake questions or answer them yourself.",
      inputSchema: {
        message: z.string().describe("The human's onboarding reply or turn to pass to Elle"),
      },
    },
    async ({ message }) => {
      try {
        const result = await callBridge("ask_onboardingGuide", { message });
        // Relay ONLY Elle's reply — never the raw generate() envelope.
        const reply = extractElleReply(result);
        return { content: [{ type: "text", text: redact(reply ?? ASK_ELLE_FALLBACK) }] };
      } catch (error) {
        return resultError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "get_marketing_plan",
    {
      title: "Get marketing plan",
      annotations: READ_ONLY,
      description:
        "Fetch your reveal-gated marketing plan: a teaser before claim and the full plan after claim.",
      inputSchema: {},
    },
    async () => {
      try {
        return await callBridge("getMarketingPlan", {});
      } catch (error) {
        return resultError(errorMessage(error));
      }
    },
  );
}
