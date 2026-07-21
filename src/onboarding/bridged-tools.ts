import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
        return await callBridge("ask_onboardingGuide", { message });
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
