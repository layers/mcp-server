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
const MAX_ELLE_ENVELOPE_BYTES = 1_048_576;
const MAX_ELLE_REPLY_BYTES = 32_768;
const ENVELOPE_MARKER =
  /(?:systemInstruction|inputTokens|outputTokens|toolCalls|refresh[_-]?token|access[_-]?token|session[_-]?handle|(?:^|\n)\s*Authorization\s*:\s*(?:Bearer|Basic)\s+\S+)/im;

/**
 * The remote guide returns a JSON envelope whose public reply is the top-level
 * `text` field. The rest of that envelope is service metadata and must never
 * enter the host-agent transcript.
 *
 * The human only ever needs Elle's reply — the envelope's top-level `text`.
 * Pull just that out. A bounded plain-text reply remains supported for a server
 * that deliberately returns prose, but malformed object envelopes,
 * code-fenced, oversized, or envelope-like text fails closed.
 */
export function extractElleReply(result: CallToolResult): string | null {
  const parts = Array.isArray(result.content) ? result.content : [];
  for (const part of parts) {
    if (!part || part.type !== "text" || typeof part.text !== "string") continue;
    const trimmed = part.text.trim();
    if (!trimmed) continue;

    const bytes = Buffer.byteLength(part.text, "utf8");
    if (bytes > MAX_ELLE_ENVELOPE_BYTES || trimmed.startsWith("```")) continue;

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const reply = readEnvelopeText(JSON.parse(trimmed));
        if (reply) return reply;
        continue;
      } catch {
        // A malformed object is an invalid remote envelope. A leading `[` is
        // also normal Markdown (`[label](url)`, `[ ] task`), so it may continue
        // through the same size/marker checks as every other plain reply.
        if (trimmed.startsWith("[") && isBoundedReply(part.text)) return part.text;
        continue;
      }
    }

    if (bytes > MAX_ELLE_REPLY_BYTES || ENVELOPE_MARKER.test(trimmed)) continue;
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
 * replies can re-introduce root-relative and project-relative forms, so the
 * bridge enforces them deterministically.
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
 * Some clients render `[Connect your accounts](https://…)` as colored-but-dead
 * text. MCP clients are plain-text surfaces with no guarantee of clickable links, so a
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
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const record = envelope as { text?: unknown; content?: unknown };
  if (typeof record.text === "string" && isBoundedReply(record.text)) return record.text;
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
    if (isBoundedReply(joined)) return joined;
  }
  return null;
}

function isBoundedReply(reply: string): boolean {
  return (
    reply.trim().length > 0 &&
    Buffer.byteLength(reply, "utf8") <= MAX_ELLE_REPLY_BYTES &&
    !ENVELOPE_MARKER.test(reply)
  );
}

/**
 * Attach the onboarding links to the hand-off turn, deterministically.
 *
 * Elle is forbidden from constructing URLs, so the bridge attaches the known
 * preview and claim destinations deterministically.
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
 * `appendOnboardingLinks` covers the pre-claim hand-off. This companion handles
 * the post-claim preview and account destinations.
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
 * trial with a bound project. `previewUrl` is available from onboard_start;
 * `connectAccountsUrl` is resolved only after project binding.
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

type IntakeOption = { value: string; label: string };
type IntakeQuestion = { field: string; title: string; subtitle?: string; options: IntakeOption[] };

/**
 * The intake question the human is on right now, from the trial status
 * response — the CANONICAL set served over HTTP, never a copy in this repo.
 * Null for every not-applicable case: no session, claimed, nothing outstanding,
 * or any failure. Pre-claim only; after the claim Elle drives.
 */
async function fetchPendingIntakeQuestion(baseUrl: string): Promise<IntakeQuestion | null> {
  try {
    const session = getSession();
    if (!session || session.claim) return null;
    const status = (await getOnboardingStatus(baseUrl)) as {
      claimed?: boolean;
      intake?: { remaining?: IntakeQuestion[] };
    } | null;
    if (!status || status.claimed === true) return null;
    const question = status.intake?.remaining?.[0];
    if (!question || !Array.isArray(question.options) || question.options.length === 0) return null;
    return question;
  } catch {
    return null;
  }
}

/**
 * Recompose an intake turn so the PICKER is the only presentation of the
 * options.
 *
 * Elle's numbered list is stripped from the relayed text,
 * and the question rides a per-turn directive block carrying the canonical
 * title and options, so rendering the picker is the only way to present what
 * the reply no longer contains as prose.
 *
 * The block also fixes question fidelity: the managed-account price and
 * consequence live in the canonical subtitle. The directive includes that
 * subtitle and every option label verbatim because this is the moment the
 * human commits.
 *
 * If the agent ignores the directive entirely, the block itself still lists the
 * title and options legibly, so the human is never stranded.
 */
export function presentIntakeQuestion(reply: string, question: IntakeQuestion): string {
  const kept = reply
    .split("\n")
    // Elle's numbered option lines. The directive block below re-lists the
    // options canonically, so dropping these is what makes "asked once" true.
    .filter((line) => !/^\s*\d+[.)]\s/.test(line))
    // Her question sentence too, when it is recognizably the canonical title —
    // the picker's header shows the question, and that is its one appearance.
    .filter((line) => !line.includes(question.title))
    .filter((line) => !question.subtitle || !line.includes(question.subtitle))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  const options = question.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");

  return `${kept}

[INTAKE QUESTION — ask this with your structured question tool (the UI that renders options as a selectable picker), NOT as plain text. Title, subtitle when present, and options VERBATIM: the subtitle can carry a price or consequence; never reword, trim, or invent them. Send the human's choice back through ask_elle as their reply — the option label or its number both work.]
${question.title}
${question.subtitle ? `${question.subtitle}\n` : ""}${options}`;
}

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
 * drift. The canonical subtitle becomes part of the elicitation message,
 * because that is where a price or commitment lives.
 *
 * Returns the chosen value, or null for every "carry on as before" case:
 * a client that does not support elicitation, no question outstanding, a
 * decline, or any failure. Null means the caller relays Elle's prose exactly as
 * it always did — this is an upgrade over a working path, never a replacement
 * that can strand someone.
 */
async function elicitIntakeAnswer(
  server: McpServer,
  question: IntakeQuestion,
): Promise<string | null> {
  try {
    // OFF BY DEFAULT, and that is a UX decision rather than a doubt about the
    // protocol. This client renders elicitation as a FORM — collapsed fields,
    // "expand to edit", Accept/Decline — while the relaying agent's own question
    // UI renders an inline picker with every option visible and
    // one keystroke to choose. Founder call 2026-07-29, after seeing both: the
    // picker wins, so we let the agent ask and keep this ready for the day the
    // form renders as a real select. Flip with LAYERS_ONBOARD_ELICITATION=1.
    //
    // What elicitation would buy back when that day comes: the question is asked
    // deterministically by the server that owns the flow, validated against a
    // schema, and correctly attributed — instead of depending on the model
    // choosing to render a picker at all.
    if (!["1", "true"].includes(process.env.LAYERS_ONBOARD_ELICITATION ?? "")) return null;

    // The client must DECLARE elicitation; the SDK throws otherwise. This is the
    // capability gate, checked per call rather than assumed at startup.
    const caps = server.server.getClientCapabilities();
    if (!caps || !("elicitation" in caps)) return null;

    const result = await server.server.elicitInput({
      // The question itself is the prompt header. The FIELD gets a short label —
      // repeating the question there renders it twice, once as the header and
      // again beside the input.
      message: question.subtitle
        ? `${question.title}\n${question.subtitle}`
        : question.title,
      requestedSchema: {
        type: "object",
        properties: {
          [question.field]: {
            type: "string",
            title: "Select one",
            // `oneOf: [{const, title}]` — TitledSingleSelectEnumSchema. NOT
            // `enum` + `enumNames`: that is LegacyTitledEnumSchema, which the
            // SDK marks for removal and, decisively, leaves OUT of the
            // SingleSelectEnumSchema union. A client validating against that
            // union does not see a select at all — it renders an unset scalar
            // with only Accept/Decline and no way to choose.
            oneOf: question.options.map((o) => ({
              const: o.value,
              title: o.label,
            })),
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
        "Elle's onboarding guide — the conversational heart of onboarding. Route EVERY onboarding turn through this: the greeting and the five Layers intake questions. Those five are the entire pre-claim Q&A; after claim Elle drives experimentation and action. Ask one question at a time in Elle's voice and pass the human's reply as message. Do not skip the intake questions or answer them yourself. Pre-claim, intake questions arrive as an [INTAKE QUESTION …] block at the end of the reply — present that block with your structured question tool, verbatim, exactly as the block instructs; the prose above it deliberately no longer contains the options. Every URL in this tool's reply is ALREADY expanded to plain text on purpose — pass each one through exactly as written, never re-wrapped as [text](url) or 'click here', because most MCP clients render link text as colored, unclickable words and hide the address the human needs. AFTER the claim this is still the route to the claimed workspace — ask Elle here about the project's influencers, videos, keywords, or anything else that was generated. Do NOT reach for a general-purpose Layers project/API tool from another server to inspect it: those authenticate with a key bound to a DIFFERENT organization, and claiming mints a brand-new one, so they answer 'Project not found' for a project that exists and is fine.",
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

        // The intake question the human is on, from the canonical set. Drives
        // BOTH presentation paths: elicitation when the flag is on, and the
        // picker directive below otherwise.
        let question = await fetchPendingIntakeQuestion(apiBaseUrl);
        if (question) {
          // Flag-gated (off by default). When on: put the question to the human
          // as a real structured prompt, hand Elle the answer, and relay her
          // NEXT reply — then re-fetch, since a fresh question may now be
          // outstanding and it needs presenting too.
          const elicited = await elicitIntakeAnswer(server, question);
          if (elicited !== null) {
            result = await callBridge(remoteToolName, { message: elicited });
            question = await fetchPendingIntakeQuestion(apiBaseUrl);
          }
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
        let usable =
          reply === null
            ? ASK_ELLE_FALLBACK
            : appendPostclaimLinks(
                appendOnboardingLinks(
                  exposeLinkTargets(absolutizeAppLinks(reply, getSession())),
                  getSession(),
                ),
                getSession(),
              );
        // Intake turn: strip Elle's prose list and attach the canonical
        // question as a picker directive — the fact version of "ask once".
        if (reply !== null && question) {
          usable = presentIntakeQuestion(usable, question);
        }
        return { content: [{ type: "text", text: redact(usable) }] };
      } catch (error) {
        return resultError(errorMessage(error));
      }
    },
  );

}
