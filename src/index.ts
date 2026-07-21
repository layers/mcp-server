#!/usr/bin/env node
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
import { redact } from "./onboarding/session.js";

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

Flow:
1. Make sure you have a product link from the human — a website URL or an Apple App Store link. If you don't, ask for it warmly with those examples, then call onboard_start.
2. Right away, WITHOUT waiting for the build, start the guided conversation through ask_elle — it IS Elle's onboarding guide. Elle greets and asks the five Layers intake questions while the preview builds in the background (this both captures setup info and covers the ~1-2 min the build takes). The five intake questions are the ENTIRE Q&A — Elle does not run a marketing-plan questionnaire. Route each of those turns through ask_elle: the greeting and the five intake questions. Pass the human's reply as the message. Relay Elle's response faithfully and let her voice carry the conversation — do NOT add your own greeting, re-summarize what she already said, or append your own version of her question. When Elle asks something, present it once and wait for the human; stay in the background while she drives. Do not skip questions or end a turn on a duplicate.
3. While the conversation runs, poll get_onboarding_status in the background. Do NOT share the preview link before it is ready. Once buildState is preview_ready (usually by the time the intake questions are done), share previewUrl and claimUrl and tell the human the preview link shows their brand brief.
4. When the five intake questions are done, Elle gives a short brand summary and the setup is COMPLETE — she will not ask anything else, and neither should you. At that point STOP asking questions and move the human to claiming: make sure you have shared previewUrl and claimUrl, then use get_marketing_plan to reveal the teaser and warmly invite them to claim their workspace to unlock the full plan.
5. Claiming happens on the WEB — this is the default and the path you should steer toward. The claim link opens a page where the human enters their own email and Layers sends them the six-digit code right there; the whole email + code step happens on that page, not in this chat. So: share the claimUrl, tell them to open it and claim there, and that they should come right back to this chat afterward — then WAIT. Do NOT ask them for their email here, and do NOT call onboard_claim_begin, as part of the normal flow; the web page handles it. When they return, call get_marketing_plan again so Elle can reveal the full plan and wrap up. (A brand-new claim continues seamlessly here; if they claimed into an existing Layers account, the journey continues in their browser.)
6. ONLY if the human explicitly says they would rather claim inside this chat instead of on the web: ask which email to use, call onboard_claim_begin with it, have the HUMAN read the six-digit code from their inbox, then call onboard_claim_verify with that code and the same email. (This chat-side path asks their client to approve the email tool — the web claim avoids that, so prefer the web link unless they ask.)

The marketing plan is reveal-gated: only a teaser is available before claim, and full plan content is available after claim. Responses are the source of truth for every handle and ID. NEVER invent, normalize, or guess IDs.`;

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
  const server = new McpServer({ name: "layers", version: "1.0.0" }, { instructions: INSTRUCTIONS });
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
    { name: "layers", version: "1.0.0" },
    { instructions: ONBOARDING_INSTRUCTIONS },
  );
  registerOnboardingTools(server, baseUrl);
  registerBridgedOnboardingTools(server, baseUrl, elleMcpBaseUrl);

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
