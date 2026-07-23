import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolResult } from "../api.js";
import { WRITE } from "../api.js";
import { getOnboardingBridge, type OnboardingBridge } from "./bridge.js";
import { getSession, redact } from "./session.js";

const resultError = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: redact(text) }],
});

const errorMessage = (error: unknown): string =>
  redact(error instanceof Error ? error.message : String(error));

const ASK_ELLE_FALLBACK =
  "Sorry — I didn't quite catch that. Could you say it once more?";
const BROWSER_CONTINUITY_HANDOFF =
  "You're all set here. Log into your Layers workspace in the browser to keep going; I'll surface any workspace, preview, or account links I already have when they're useful.";

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

/**
 * Absolutize Layers app links in Elle's reply.
 *
 * Over MCP the reply renders in an external chat client with no site to
 * resolve relative paths against — a relative link is dead. Elle is prompted
 * to emit absolute URLs, but thread-memory mimicry of her earlier web-surface
 * replies keeps re-introducing root-relative and project-relative forms
 * (observed live 2026-07-22), so the bridge enforces them deterministically.
 * Root-relative links resolve against the session origin. Project-relative
 * links resolve only when the workspace URL exposes `/project/<id>`.
 */
export function absolutizeAppLinks(
  reply: string,
  session: { workspaceUrl?: string; claimUrl?: string; previewUrl?: string } | undefined,
): string {
  const base = session?.workspaceUrl ?? session?.claimUrl ?? session?.previewUrl;
  if (!base) return reply;
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return reply;
  }
  const projectBase = projectBaseFromWorkspaceUrl(session?.workspaceUrl);
  return reply.replace(/\]\(([^)\s]*)\)/g, (match, target: string) => {
    if (shouldLeaveLinkTarget(target)) return match;
    if (target.startsWith("/")) return `](${origin}${target})`;
    if (!projectBase || !isProjectRelativeTarget(target)) return match;
    return `](${projectBase}/${target})`;
  });
}

/**
 * Unwrap markdown links so the URL is visible text.
 *
 * The founder's terminal click-through (2026-07-22) showed why: the client
 * rendered `[Connect your accounts](https://…)` as colored-but-dead text — MCP
 * clients are plain-text surfaces with no guarantee of clickable links, so a
 * URL hidden behind link text is a button that cannot be pressed. Like
 * absolutizing above, this is enforced deterministically rather than by
 * prompt: `[text](https://url)` becomes `text: https://url`, and a link whose
 * text already IS the URL collapses to the bare URL. Only http(s) targets are
 * unwrapped — anchors/mailto pass through untouched.
 */
export function exposeLinkTargets(reply: string): string {
  return reply.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, text: string, url: string) => (text.trim() === url ? url : `${text.trim()}: ${url}`),
  );
}

function projectBaseFromWorkspaceUrl(workspaceUrl: string | undefined): string | null {
  if (!workspaceUrl) return null;
  try {
    const url = new URL(workspaceUrl);
    const match = url.pathname.match(/^(.*?\/project\/[^/]+)(?:\/|$)/);
    return match ? `${url.origin}${match[1]}` : null;
  } catch {
    return null;
  }
}

function shouldLeaveLinkTarget(target: string): boolean {
  return (
    target.length === 0 ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

/**
 * A project-relative app path — `social/accounts?kind=connected`,
 * `library/demo-videos` — as the first-experiment playbook emits them.
 *
 * The first segment must NOT look like a hostname. A scheme-less brand link
 * (`](sonos.com)`, which Elle can plausibly write for the brand she is
 * onboarding) starts with an alphanumeric just like an app path does, and
 * rewriting it would produce `…/project/<id>/sonos.com` — a dead link, the
 * exact failure this rewriting exists to prevent. App paths have no dot in
 * their first segment; hostnames do.
 */
function isProjectRelativeTarget(target: string): boolean {
  if (!/^[A-Za-z0-9_]/.test(target)) return false;
  const firstSegment = target.split(/[/?#]/, 1)[0] ?? "";
  return !firstSegment.includes(".");
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
        "Elle's onboarding guide — the conversational heart of onboarding. Route EVERY onboarding turn through this: the greeting and the five Layers intake questions. Those five are the entire pre-claim Q&A; after claim Elle drives experimentation and action. Ask one question at a time in Elle's voice and pass the human's reply as message. Do not skip the intake questions or answer them yourself. Every URL in this tool's reply is ALREADY expanded to plain text on purpose — pass each one through exactly as written, never re-wrapped as [text](url) or 'click here', because most MCP clients render link text as colored, unclickable words and hide the address the human needs.",
      inputSchema: {
        message: z.string().describe("The human's onboarding reply or turn to pass to Elle"),
      },
    },
    async ({ message }) => {
      try {
        const claim = getSession()?.claim;
        if (claim?.continuity === "browser") {
          return { content: [{ type: "text", text: redact(BROWSER_CONTINUITY_HANDOFF) }] };
        }
        const remoteToolName =
          claim?.continuity === "same_account" ? "ask_elle" : "ask_onboardingGuide";
        const result = await callBridge(remoteToolName, { message });
        // Relay ONLY Elle's reply — never the raw generate() envelope.
        const reply = extractElleReply(result);
        const usable =
          reply === null
            ? ASK_ELLE_FALLBACK
            : exposeLinkTargets(absolutizeAppLinks(reply, getSession()));
        return { content: [{ type: "text", text: redact(usable) }] };
      } catch (error) {
        return resultError(errorMessage(error));
      }
    },
  );

}
