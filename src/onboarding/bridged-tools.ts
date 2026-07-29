import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolResult } from "../api.js";
import { WRITE } from "../api.js";
import { getOnboardingBridge, type OnboardingBridge } from "./bridge.js";
import { getSession, redact } from "./session.js";
import { getOnboardingStatus } from "./tools.js";

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
 * prompt: `[text](https://url)` becomes `text (https://url)`, and a link whose
 * text already IS the URL collapses to the bare URL. Only http(s) targets are
 * unwrapped — anchors/mailto pass through untouched.
 *
 * PARENTHETICAL, not `text: url`. The colon form only reads correctly when the
 * link ends a sentence; Elle links mid-sentence all the time, and there it
 * produced broken prose — "Once your accounts: https://… are linked, we start
 * the loop." The parenthetical reads correctly in BOTH positions and keeps the
 * URL adjacent to its label, which is what makes it copyable.
 *
 * SPACE-BUFFERED inside the parens: `text ( url )`. Terminals auto-linkify bare
 * URLs by scanning to the next whitespace, and their handling of trailing
 * punctuation varies — `(https://…).` can hand the user a URL with `).` glued
 * on. A space on each side means the URL is its own whitespace-delimited token
 * on every client, so no linkifier and no double-click selection can absorb the
 * surrounding punctuation. Costs a little typographic air; buys a link that
 * always works.
 */
export function exposeLinkTargets(reply: string): string {
  return (
    reply
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, text: string, url: string) =>
        text.trim() === url ? ` ${url} ` : `${text.trim()} ( ${url} )`,
      )
      // The collapse branch adds a buffer to text that usually already had one,
      // which doubles the space. Tidy ONLY next to the urls we just emitted —
      // a global whitespace collapse would eat markdown indentation and table
      // alignment elsewhere in the reply.
      .replace(/ {2,}(?=https?:\/\/)/g, ' ')
      .replace(/(https?:\/\/[^\s)]+) {2,}/g, '$1 ')
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

/**
 * Attach the onboarding links to the hand-off turn, deterministically.
 *
 * Elle is forbidden from writing URLs (she has none and would fabricate them),
 * so the relaying agent is supposed to supply them. Twice in live testing it
 * did not: it sent the claim link alone, once even labelling it "open it to
 * preview your workspace" — conflating the two. Instructions were added to the
 * flow, then promoted to golden rules; both were ignored. Meanwhile the
 * link-expansion rules enforced HERE held perfectly in the same runs. That is
 * the whole lesson: on the relay path, a rule the bridge applies is a fact and
 * a rule the prompt asks for is a preference.
 *
 * Fires only on the hand-off turn — pre-claim, preview known, and Elle inviting
 * them to claim (which the guide's prompt makes her do exactly once, at
 * `nextAction: "hand_off"`). Never duplicates a url already present.
 */
export function appendOnboardingLinks(
  reply: string,
  session: { previewUrl?: string; claimUrl?: string; claim?: unknown } | undefined,
): string {
  const previewUrl = session?.previewUrl;
  if (!previewUrl || session?.claim) return reply;
  if (!/\bclaim(ing|ed)?\b/i.test(reply)) return reply;
  if (reply.includes(previewUrl)) return reply;

  const lines = [`Preview your brand: ${previewUrl}`];
  if (session?.claimUrl && !reply.includes(session.claimUrl)) {
    lines.push(`Claim your workspace: ${session.claimUrl}`);
  }
  return `${reply.trimEnd()}\n\n${lines.join("\n")}`;
}

/**
 * Attach the POST-claim destinations, deterministically.
 *
 * `appendOnboardingLinks` covers the hand-off turn and then stops firing the
 * moment a claim lands — so the very next turn, where Elle points at "your
 * accounts page" and "your preview page", went back to naming destinations in
 * prose with no address attached (observed live 2026-07-29). Same failure as
 * before, one turn later: a page the human is told to visit but cannot reach.
 *
 * The lesson from the pre-claim version applies unchanged — on the relay path a
 * rule the bridge APPLIES is a fact and a rule the prompt asks for is a
 * preference — so both links are enforced here rather than requested upstream.
 *
 * Fires only when the reply actually raises the subject, so a turn about
 * something else does not collect a footer of links. Never duplicates a url the
 * reply already contains.
 */
export function appendPostclaimLinks(
  reply: string,
  session:
    | { previewUrl?: string; connectAccountsUrl?: string; claim?: unknown }
    | undefined,
): string {
  // Post-claim only. Before the claim, appendOnboardingLinks owns this job and
  // running both would double up the preview link on the hand-off turn.
  if (!session?.claim) return reply;

  const lines: string[] = [];

  const connectUrl = session.connectAccountsUrl;
  if (
    connectUrl &&
    !reply.includes(connectUrl) &&
    /\b(connect|link|linked|linking)\b/i.test(reply) &&
    /\b(account|accounts|tiktok|instagram|social)\b/i.test(reply)
  ) {
    lines.push(`Connect your accounts: ${connectUrl}`);
  }

  // The preview page is where the post-claim assets actually appear, so a turn
  // that says they are generating owes the human the address, not the noun.
  const previewUrl = session.previewUrl;
  if (
    previewUrl &&
    !reply.includes(previewUrl) &&
    /\b(generating|generate|preview|asset|assets|influencer|video|keyword)/i.test(reply)
  ) {
    lines.push(`Your preview page: ${previewUrl}`);
  }

  if (lines.length === 0) return reply;
  return `${reply.trimEnd()}\n\n${lines.join("\n")}`;
}

/**
 * Make sure the post-claim destinations are KNOWN before we try to attach them.
 *
 * `connectAccountsUrl` does not exist until the status route has seen a claimed
 * trial with a bound project — it is gated on exactly that. `previewUrl` has
 * been in the session since onboard_start, which is why the preview link
 * attached on the first post-claim turn and the connect link did not (observed
 * live 2026-07-29): the bridge had nothing to attach and correctly refused to
 * invent a URL.
 *
 * So refresh once, on the first post-claim turn that still lacks it. Bounded by
 * the `connectAccountsUrl` check, so this is a single extra call across the whole
 * session rather than a poll. Best-effort: a relay turn must never fail because
 * a link could not be resolved.
 */
async function ensurePostclaimLinks(baseUrl: string): Promise<void> {
  const session = getSession();
  if (!session?.claim || session.connectAccountsUrl) return;
  try {
    await getOnboardingStatus(baseUrl);
  } catch {
    // The reply still relays; it just goes out without the connect link.
  }
}

type IntakeOption = { value: string; label: string; blurb?: string };
type IntakeQuestion = { field: string; title: string; options: IntakeOption[] };

/**
 * Ask the outstanding intake question as a REAL structured prompt.
 *
 * Until now the question reached the human as prose and the picker they saw was
 * the relaying client choosing, of its own accord, to render one — so the
 * experience depended on the model's discretion and the question could arrive
 * twice, once as text and once as a picker. Eliciting makes it deterministic,
 * schema-validated and correctly attributed to the server that owns the flow.
 *
 * The questions come from the trial status response, which serves the CANONICAL
 * set — never a copy in this repo, so the browser, Elle and this surface cannot
 * drift. Each option's `blurb` becomes part of its label, because that is where
 * a price or commitment lives and this is the moment the human commits to it.
 *
 * Returns the chosen value, or null for every "carry on as before" case:
 * a client that does not support elicitation, no question outstanding, a
 * decline, or any failure. Null means the caller relays Elle's prose exactly as
 * it always did — this is an upgrade over a working path, never a replacement
 * that can strand someone.
 */
async function elicitIntakeAnswer(
  server: McpServer,
  baseUrl: string,
): Promise<string | null> {
  try {
    // The client must DECLARE elicitation; the SDK throws otherwise. This is the
    // capability gate, checked per call rather than assumed at startup.
    const caps = server.server.getClientCapabilities();
    if (!caps || !("elicitation" in caps)) return null;

    const status = (await getOnboardingStatus(baseUrl)) as {
      claimed?: boolean;
      intake?: { remaining?: IntakeQuestion[] };
    } | null;
    // Intake is the pre-claim Q&A only; after the claim Elle drives.
    if (!status || status.claimed === true) return null;

    const question = status.intake?.remaining?.[0];
    if (!question || !Array.isArray(question.options) || question.options.length === 0) return null;

    const result = await server.server.elicitInput({
      message: question.title,
      requestedSchema: {
        type: "object",
        properties: {
          [question.field]: {
            type: "string",
            title: question.title,
            enum: question.options.map((o) => o.value),
            // The blurb rides the label. A surface may render a question as
            // plain text; it may never drop the field carrying the consequence.
            enumNames: question.options.map((o) =>
              o.blurb ? `${o.label} — ${o.blurb}` : o.label,
            ),
          },
        },
        required: [question.field],
      },
    });

    if (result.action !== "accept") return null;
    const chosen = (result.content as Record<string, unknown> | undefined)?.[question.field];
    return typeof chosen === "string" && chosen.length > 0 ? chosen : null;
  } catch {
    // Any failure falls back to prose. Never break a relay turn over an upgrade.
    return null;
  }
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
        "Elle's onboarding guide — the conversational heart of onboarding. Route EVERY onboarding turn through this: the greeting and the five Layers intake questions. Those five are the entire pre-claim Q&A; after claim Elle drives experimentation and action. Ask one question at a time in Elle's voice and pass the human's reply as message. Do not skip the intake questions or answer them yourself. Every URL in this tool's reply is ALREADY expanded to plain text on purpose — pass each one through exactly as written, never re-wrapped as [text](url) or 'click here', because most MCP clients render link text as colored, unclickable words and hide the address the human needs. AFTER the claim this is still the route to the claimed workspace — ask Elle here about the project's influencers, videos, keywords, or anything else that was generated. Do NOT reach for a general-purpose Layers project/API tool from another server to inspect it: those authenticate with a key bound to a DIFFERENT organization, and claiming mints a brand-new one, so they answer 'Project not found' for a project that exists and is fine.",
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
        let result = await callBridge(remoteToolName, { message });

        // Elle has just asked the next intake question. Put it to the human as a
        // real structured prompt and hand her the answer, so they act on ONE
        // picker instead of reading the question as prose and then answering a
        // copy of it. Returns null whenever that is not possible — no
        // elicitation support, nothing outstanding, or a decline — and then this
        // is exactly the prose flow it has always been.
        const elicited = await elicitIntakeAnswer(server, apiBaseUrl);
        if (elicited !== null) {
          result = await callBridge(remoteToolName, { message: elicited });
        }

        // Resolve the post-claim destinations BEFORE composing the reply, so the
        // first post-claim turn can carry the connect link instead of naming a
        // page it has no address for.
        await ensurePostclaimLinks(apiBaseUrl);
        // Relay ONLY Elle's reply — never the raw generate() envelope.
        const reply = extractElleReply(result);
        // Order matters: append the raw urls LAST, after expansion, so the
        // expander never sees them as markdown and the buffered form we add
        // here survives untouched.
        const usable =
          reply === null
            ? ASK_ELLE_FALLBACK
            : appendPostclaimLinks(
                appendOnboardingLinks(
                  exposeLinkTargets(absolutizeAppLinks(reply, getSession())),
                  getSession(),
                ),
                getSession(),
              );
        return { content: [{ type: "text", text: redact(usable) }] };
      } catch (error) {
        return resultError(errorMessage(error));
      }
    },
  );

}
