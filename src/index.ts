#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LayersClient } from "./api.js";
import { registerCoreTools } from "./tools/core.js";
import { registerCreativeTools } from "./tools/creative.js";
import { registerDistributionTools } from "./tools/distribution.js";
import { registerMeasurementTools } from "./tools/measurement.js";
import { registerFrameworkTools } from "./tools/framework.js";
import {
  getOnboardingStatus,
  registerOnboardingTools,
  startOnboarding,
} from "./onboarding/tools.js";
import { registerBridgedOnboardingTools } from "./onboarding/bridged-tools.js";
import { getClaimedApiKey, redact } from "./onboarding/session.js";

// The version clients see in server info. Read from package.json so a release
// bump cannot drift from what the server self-reports (both constructors were
// hardcoded "1.0.0" and shipped that way through 1.1.0).
const SERVER_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Flag-first, env-fallback config, mirroring the Supabase server's install style.
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

const apiKey = flagValue("api-key") ?? process.env.LAYERS_API_KEY;
const baseUrl = flagValue("base-url") ?? process.env.LAYERS_BASE_URL ?? "https://api.layers.com";
const elleMcpBaseUrl = process.env.LAYERS_ELLE_MCP_URL ?? "https://elle.layers.com";
const organization = flagValue("organization") ?? process.env.LAYERS_ORGANIZATION;
const readOnly =
  argv.includes("--read-only") || ["1", "true"].includes(process.env.LAYERS_READ_ONLY ?? "");

// Loaded once into the client's context at initialize — tells the agent what to
// remember between calls (this server is stateless) and the shape of the workflow.
const INSTRUCTIONS = `Wraps the Layers API. The server is STATELESS. It remembers nothing between calls so YOU must track the IDs and cursors it returns.

IDs: every resource returns a prefixed id (prj_, cnt_, inf_, sp_, sa_, adc_, rec_). Store the exact string and pass it back verbatim. Never invent, normalize, or strip it. Responses are the source of truth for ids.

Async work: generate_* , create_influencer, clone_influencer, and refresh_keywords return a 202 job envelope (a jobId, plus containerIds or influencerId depending on the call). The work is NOT done when the call returns. Capture the id and poll the matching read until status is terminal (completed/failed/canceled): get_content_progress for content, get_influencer for an influencer, get_keywords for a keyword refresh.

Typical flow: create_project -> get_hooks -> generate_* -> poll get_content_progress -> approve_content (if the project requires review) -> schedule_content or publish_content -> poll get_scheduled_post.

Pagination: list_* return { items, nextCursor }. To get the next page pass nextCursor back as cursor — don't restart. A null/absent nextCursor means you've reached the end.

Idempotency is automatic per call, so calling a create twice creates two resources. Don't blindly retry a create — read first to check whether the prior call already succeeded.

Errors come back as isError text "Layers API <status> <code>". Branch on the code, not the message: NOT_FOUND (wrong or foreign id), VALIDATION (fix the body), APPROVAL_REQUIRED (approve the container first), BILLING_EXHAUSTED (out of credits), RATE_LIMITED (back off and retry). Quote the requestId in support tickets.

Timestamps are UTC with a Z suffix; scheduledFor is a literal UTC instant — convert from local time yourself.`;

const ONBOARDING_INSTRUCTIONS = `You are guiding a human through keyless Layers onboarding. Keep it warm and concise, and let Elle carry the personality — route the conversation through her (the ask_elle tool) rather than narrating a dry checklist. The server is STATELESS across restarts; it holds only the short-lived onboarding session needed to continue.

Golden rules — do not break these:
- NEVER guess, default, or invent any input. If the human has not given you a link to their product, ASK for it warmly and with examples — a website URL (like yourbrand.com) or an Apple App Store link. Only those two are supported today, so do NOT invite GitHub or Google Play links. Never substitute your own domain, layers.ai/layers.com, or an example URL.
- NEVER infer the human's email. When it is time to claim, ASK which email to use. Do not reuse a signed-in, account, or profile email you happen to know.
- The human reads the six-digit claim code from their OWN inbox. NEVER read, search, or open the human's email yourself, and NEVER use any other tool (for example a Gmail tool) to fetch the code — just ask them to read it to you.
- NEVER narrate the plumbing. Do not tell the human about session state, trial bindings, retries, timers, or internal hiccups — no "quick heads-up," no "Elle's side isn't seeing the trial." Just relay Elle's messages in her voice. You CANNOT pass a trial handle to ask_elle (the trial is bound automatically), so never say you'll "retry with the trial handle." If an ask_elle turn looks off — Elle re-greets, or does not acknowledge the answer — silently call ask_elle again with the human's same reply and keep going. Make sure all FIVE intake answers are captured before moving past them; never let a hiccup drop a question.
- Do not NAME Elle before she has introduced herself. Her first ask_elle reply carries the introduction; until the human has read it, "Elle" is a stranger's first name dropped into their onboarding ("now let's get Elle to walk through the questions" — who?). In your own narration before her opening line has been relayed, name the role, not the person — "let me get a few things set up" or "our marketing expert" — and after her introduction, use her name freely.
- NEVER compress or replace Elle's OPENING. Her first reply introduces her — "I'm Elle, your Layers marketing expert, here to help you along the way" — and that one line is the human's only context for who they are suddenly talking to and why. Relay it as she wrote it. Collapsing it to your own shorthand ("Elle here") drops a stranger's first name on someone who has not been told Layers has a marketing expert, let alone that this is her. Verbatim, every time; she introduces herself exactly once, so there is no second chance.
- The preview link is HALF the payoff, and the easiest thing in this flow to forget, because it becomes shareable a minute before it is needed. The moment buildState is preview_ready you owe the human BOTH links — the preview (what Layers found about their brand) and the claim (how they keep it). Sending only the claim link asks them to commit to a workspace they have never seen. If you are about to invite them to claim and have not shared previewUrl, you are not ready to invite them.
- POST-CLAIM, THE ADDRESSES ARE ATTACHED FOR YOU. The bridge appends the preview page and the connect-accounts page whenever your reply raises those subjects. Do NOT hunt for the URLs, paste them from an earlier turn, or apologise for their absence — name the destination in plain prose ("watch them land on your preview page", "connect your TikTok and Instagram accounts") and the address arrives beneath it. A turn that never mentions either destination gets no links.
- INTAKE QUESTIONS GO THROUGH YOUR QUESTION TOOL — ALWAYS, not optionally. Pre-claim, every ask_elle reply that carries an intake question ends with an [INTAKE QUESTION …] block: the canonical title and options, already stripped from the prose above it. That block is the question's single source. Present it with your structured question tool (the picker that renders options as selectable choices), title and options VERBATIM — the option descriptions carry prices and consequences, so never reword, trim, or invent them, and never fall back to printing the options as a plain-text list. Relay Elle's voice from the prose, let the picker carry the question, and send the human's choice back through ask_elle as their reply — the option label or its number both work.
- NEVER rewrite a URL Elle gives you into a markdown link, a "click here", or link text of any kind. ask_elle returns every URL already expanded as plain text, exactly as the human must see it. Reproduce it that way — bare, complete, on its own — even when you are shortening the rest of her message. Writing [your generations page](https://…) instead of "your generations page: https://…" renders in most MCP clients as colored, UNCLICKABLE words with the address hidden, which strands the human at the one moment they need to act. This is the single most common way a good turn is ruined: relay Elle's links verbatim.

Flow:
1. Make sure you have a product link from the human — a website URL or an Apple App Store link. If you don't, ask for it warmly with those examples, then call onboard_start.
2. Right away, WITHOUT waiting for the build, start the guided conversation through ask_elle — it IS Elle's onboarding guide. Elle greets and asks the five Layers intake questions while the preview builds in the background (this both captures setup info and covers the ~1-2 min the build takes). The five intake questions are the ENTIRE pre-claim Q&A; after claim, Elle switches to experimentation and action. Route each of those turns through ask_elle: the greeting and the five intake questions. Pass the human's reply as the message. Relay Elle's response faithfully and let her voice carry the conversation — do NOT add your own greeting, re-summarize what she already said, or append your own version of her question. When Elle asks something, present it once and wait for the human; stay in the background while she drives. Do not skip questions or end a turn on a duplicate.
3. While the conversation runs, poll get_onboarding_status in the background. Do NOT share the preview link before it is ready. Once buildState is preview_ready (usually by the time the intake questions are done), share previewUrl and claimUrl and tell the human the preview link shows their brand brief.
4. When the five intake questions are done, Elle gives a short brand summary and the setup is COMPLETE — she will not ask anything else, and neither should you. At that point STOP asking questions and move the human to claiming: make sure you have shared previewUrl and claimUrl, then warmly invite them to claim their workspace. Tell them that claiming is what kicks off their influencer, first video and keyword research.
5. Claiming happens on the WEB — this is the default and the path you should steer toward. The claim link opens a page where the human enters their own email and Layers sends them the six-digit code right there; the whole email + code step happens on that page, not in this chat. So: share the claimUrl, tell them to open it and claim there, and that they should come right back to this chat afterward — then WAIT. Do NOT ask them for their email here, and do NOT call onboard_claim_begin, as part of the normal flow; the web page handles it. When they return, do NOT summarize and stop: tell them their influencer, first video and keyword research are generating, and give them previewUrl in full as the place to watch those assets land over the next few minutes. If get_onboarding_status shows continuity "same_account", immediately continue through ask_elle and relay Elle's next step. If it shows continuity "browser", use the browser handoff.
6. ONLY if the human explicitly says they would rather claim inside this chat instead of on the web: ask which email to use, call onboard_claim_begin with it, have the HUMAN read the six-digit code from their inbox, then call onboard_claim_verify with that code and the same email. After onboard_claim_verify succeeds, its postclaimAssets object has generationStatus, postclaimState, estimatedDuration, and message; prefer relaying postclaimAssets.message verbatim. Do NOT say the assets are ready or waiting: they are generating, and the preview page is where they appear. Relay that message WITH previewUrl beside it (golden rule) — the response deliberately carries no URL, so it is on you to supply the one they need. If continuity is "same_account", immediately continue through ask_elle and relay Elle's next step instead of closing with congratulations. If continuity is "browser", use the browser handoff. (This chat-side path asks their client to approve the email tool — the web claim avoids that, so prefer the web link unless they ask.)

Post-claim:
7. After a successful same-account claim, ask_elle IS the full Elle coordinator with project context, not the restricted onboarding guide. Keep routing through ask_elle and relay Elle's voice faithfully while she guides the human through the next steps: watch assets appear on the preview page, connect social accounts, and choose a first experiment. Never end a post-claim turn on "enjoy Layers!" with no next beat.
8. Relay Elle's workspace, account connection, or preview links from ask_elle as returned; the bridge absolutizes app links, expands them to plain text, and post-claim attaches the preview and connect-accounts addresses itself. You almost never need to add a link by hand — if you do, take it verbatim from the latest get_onboarding_status (workspaceUrl, connectAccountsUrl, previewUrl) and never invent or reconstruct one. Every URL must appear as visible plain text the human can copy — never hidden behind markdown link text, a "click here", or an emoji button. Many chat clients cannot render clickable links; a hidden URL is a button that cannot be pressed.
9. If get_onboarding_status or onboard_claim_verify shows continuity "browser", keep the existing browser handoff: the human continues in the workspace they claimed in their browser, and you surface only links you already hold.

The post-claim payoff is the generated assets and the first experiment: the influencer, first video, and keyword research appear on the preview page when ready. Responses are the source of truth for every handle and ID. NEVER invent, normalize, or guess IDs.`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runOnboardCli(): Promise<void> {
  const url = argv[1];
  if (!url || url.startsWith("--")) {
    throw new Error("Usage: layers-mcp-server onboard <url>");
  }

  console.log(redact("Starting keyless Layers onboarding..."));
  const started = await startOnboarding(baseUrl, url);
  console.log(redact("Onboarding started; waiting for the preview..."));

  const deadline = Date.now() + 180_000;
  let lastProgress = "";
  while (Date.now() < deadline) {
    const status = await getOnboardingStatus(baseUrl, started.trialHandle);
    if (!status || typeof status !== "object") {
      throw new Error("Onboarding status returned an invalid response");
    }

    const record = status as Record<string, unknown>;
    const buildState = typeof record.buildState === "string" ? record.buildState : "unknown";
    const planState = typeof record.planState === "string" ? record.planState : "unknown";
    const progress = `build: ${buildState}; plan: ${planState}`;
    if (progress !== lastProgress) {
      console.log(redact(progress));
      lastProgress = progress;
    }

    if (buildState === "preview_ready") break;
    if (buildState === "failed" || buildState === "expired") {
      throw new Error(`Onboarding ${buildState} (${progress})`);
    }
    await sleep(5_000);
  }

  console.log(redact(`previewUrl: ${started.previewUrl}`));
  console.log(redact(`claimUrl: ${started.claimUrl}`));
  console.log(
    redact("to claim: reconnect with onboard_claim_begin/verify or open the claim URL"),
  );
}

async function runLegacyServer(key: string): Promise<void> {
  const server = new McpServer({ name: "layers", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const client = new LayersClient(key, baseUrl, organization);

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
}

async function runOnboardingServer(): Promise<void> {
  const server = new McpServer(
    { name: "layers", version: SERVER_VERSION },
    { instructions: ONBOARDING_INSTRUCTIONS },
  );
  registerOnboardingTools(server, baseUrl);
  registerBridgedOnboardingTools(server, baseUrl, elleMcpBaseUrl);

  // The full Layers tool set, bound to whatever workspace this session claims.
  //
  // Onboarding starts keyless, so there is no key to bind at construction — the
  // client resolves `getClaimedApiKey()` PER REQUEST instead, and claim/verify
  // fills it in. Before a claim these tools exist but refuse with a legible
  // "claim a workspace first" rather than sending `Bearer undefined`.
  //
  // Registering them up front (rather than after the claim) is deliberate: MCP
  // advertises its tool list at initialize, and a client that has already seen
  // the list will not necessarily re-read it mid-session. Tools that appear only
  // after a claim would be invisible to exactly the caller who just earned them.
  //
  // This is what closes the gap where a freshly-onboarded user reached for a
  // Layers tool and got 404 "Project not found" — the key they were implicitly
  // using belonged to a different organization entirely.
  const claimedClient = new LayersClient(getClaimedApiKey, baseUrl, organization);
  registerCoreTools(server, claimedClient, readOnly);
  registerCreativeTools(server, claimedClient, readOnly);
  registerDistributionTools(server, claimedClient, readOnly);
  registerMeasurementTools(server, claimedClient, readOnly);
  registerFrameworkTools(server, claimedClient, readOnly);

  // Report what the connected client can do, once it has told us.
  //
  // Capabilities are only known AFTER initialize, so this cannot be read at
  // connect time. It answers a question no amount of code reading can: whether
  // this client supports `elicitation`, i.e. whether the server may ask for
  // structured input (the intake questions as a real picker) or must keep
  // relaying them as prose. The SDK throws if you elicit without support, so
  // this gates that work rather than guessing at it.
  server.server.oninitialized = () => {
    try {
      const caps = server.server.getClientCapabilities();
      const names = caps ? Object.keys(caps).sort() : [];
      console.error(
        `[client] capabilities: ${names.length ? names.join(", ") : "(none declared)"} | elicitation: ${
          caps && "elicitation" in caps ? "SUPPORTED" : "not supported"
        }`,
      );
    } catch {
      console.error("[client] capabilities: unavailable");
    }
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `layers mcp server running on stdio (base: ${baseUrl}, keyless onboarding; no API key)`,
  );
}

if (argv[0] === "onboard") {
  try {
    await runOnboardCli();
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
} else if (apiKey) {
  await runLegacyServer(apiKey);
} else {
  await runOnboardingServer();
}
