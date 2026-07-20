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
        "Talk to Elle to answer onboarding questions and drive your Layers starter marketing plan.",
      inputSchema: {
        message: z.string().describe("The user's onboarding question or turn for Elle"),
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
