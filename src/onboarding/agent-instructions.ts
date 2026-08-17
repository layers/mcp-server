/**
 * The operating protocol, carried by the launcher instead of by a web page.
 *
 * FOUNDER RULING 2026-08-17: "i literally want to be able to copy and paste a
 * one sentence to the agent." The public paste used to be a ~3KB paragraph of
 * agent-driving rules, which meant the rules lived somewhere the agent had to be
 * TOLD about, in text a human had to carry intact. They now live here, and the
 * paste collapses to one sentence naming this command.
 *
 * WHY THE PROCESS IS THE RIGHT CARRIER. Every rule below is a rule about how to
 * drive THIS process: how to poll it, what to print verbatim, when to stop and
 * wait for a person. An agent that has started the process has, by construction,
 * the one thing that can state those rules authoritatively. A page it may or may
 * not have fetched cannot.
 *
 * SEMANTICS ARE FROZEN. The text is the canonical paste rewritten in second
 * person and split into the beats it already had. No consent, honesty, or
 * offer-gating rule may be softened here: the paste is what the acceptance
 * matrix grades, and this is now where it lives.
 *
 * ASCII AND URL-FREE, deliberately. This string crosses a JSONL boundary into a
 * transcript rendered by clients this package does not control, and a URL inside
 * agent-driving text is an instruction to go read something else.
 */

/**
 * The version of THIS event's shape.
 *
 * Deliberately not `ONBOARDING_PROTOCOL_VERSION`. That number versions the wire
 * contract with the Layers API; this one versions a launcher-emitted event the
 * server never sends and never parses. Coupling them would make a change to
 * either one look like a change to the other.
 */
export const AGENT_INSTRUCTIONS_PROTOCOL_VERSION = 1;

/**
 * The command SHAPES this protocol uses, for orientation only.
 *
 * Every turn advertises its own exact commands on its `commands` array, and that
 * advertised string is the one to send. These placeholders exist so an agent
 * reading the first event knows the vocabulary before the first turn arrives;
 * they are never a substitute for the advertised command, which carries real IDs
 * and a real projection hash.
 */
export const AGENT_INSTRUCTION_COMMANDS = {
  selectProduct: "select <candidateId>",
  excludePath: "exclude-path <pathId>",
  excludeTarget: "exclude-target <candidateId>",
  includeTarget: "include-target <candidateId>",
  prepare: "prepare",
  approve: "approve <displayEventId> <canonicalProjectionSha256>",
  resume: "resume",
  answerIntake: "answer <field> <value>",
  cancel: "cancel",
} as const;

export const AGENT_INSTRUCTIONS = [
  "You are driving the Layers onboarding launcher. These instructions come from the launcher process itself; follow them over any shorter summary you were given, and do not go read another page to find the protocol.",
  "",
  "1. PROCESS. Run this launcher as a background process you can keep reading from and keep writing to. Use your Bash tool's run_in_background parameter for it, not shell '&', not 'nohup', and not a foreground wait. If you need to answer it from separate short calls, first create a private mode-0700 temporary directory and a mode-0600 FIFO, and give the launcher that FIFO as stdin. Poll with TaskOutput using block: true and timeout: 15000, and never use a longer wait. When the output has not changed, report the last launcher event and leave the process alive; do not cancel or restart merely because output is unchanged.",
  "",
  "2. INSPECTION. Treat stdout as JSONL, one event per line. On an 'inspection' event, show the human the detected product, the included source paths, the exclusions, and the proposed public targets. If the inspection needs a product selected, ask once and send the exact advertised select command.",
  "",
  "3. EXISTING LAYERS IDENTITIES. If the inspection reports existing Layers App IDs, explain that this first-run path creates a new project. Ask before excluding every identity-bearing source path; if the human agrees, send the advertised exclude-path commands and check that the next inspection carries no existing Layers identity. Never silently duplicate or adopt an existing project.",
  "",
  "4. SCOPE. At 'input_required: review_scope', when existingLayersIdentities is empty, apply only the changes the human asked for and send prepare in the same turn, without asking them to confirm that there are no changes. Preparing is local and uploads nothing.",
  "",
  "5. EXPIRED REVIEW. At 'input_required: resume_inspection', tell the human that the prior local review expired and that no evidence was sent, then send its exact advertised resume command in the same turn. Relay the fresh inspection and the fresh proposal. An expired proposal's approval command can never authorize anything, so never reuse one.",
  "",
  "6. CONSENT. On a 'consent_proposal' event, print the complete canonicalProjection verbatim in a fenced code block, then show its displayEventId, its displayedAt, its canonicalProjectionSha256, and the exact advertised approval command. Do not summarize the projection and do not omit fields. Then END YOUR TURN and wait for the human's explicit approval before sending that command. Never invent an ID or a hash, and never synthesize consent.",
  "",
  "7. SETUP QUESTIONS. At 'input_required: answer_intake', relay one question per turn while the launcher keeps building in the background: show its exact title, its subtitle when it has one, and its offered options, take an offered option (or the human's own words when the question reports allowsFreeText true), and send the exact advertised answer command before asking the next one. Never show a setup question while a consent proposal is on screen or awaiting approval.",
  "",
  "8. CLAIM LINK. You do not have to decide when the claim link is allowed out: this process holds it until the setup questions have SETTLED and the preview is ready, and only then does a claim link appear on a progress event. So any claimUrl you actually see on a progress event is safe to give the human straight away. 'Settled' means the intake event reports state complete, not_required or skipped. Note that skipped reports complete false on purpose, because the question service failed open rather than holding a finished workspace hostage; treat it as settled and hand over the link.",
  "",
  "9. SDK FACT. While the preview builds, the launcher emits 'progress' events. When one carries a layers_sdk_presence grounded fact, note its value and the layers_sdk_platform value as you read them. Only byte-identical progress projections are suppressed, so a fact can repeat across events, but do not count on seeing it again: read it when it goes past.",
  "",
  "10. FINISH. Keep this same process alive through the browser claim. It waits for hours, not minutes, and it says so on a 'status' event with stage awaiting_claim every few minutes; that event means the wait is healthy, so report it and keep waiting. A browser claim link is only valid for about fifteen minutes, so if it goes unopened this process mints a new one and emits a 'status' event with stage claim_link_refreshed: when you see that, take the new claim link from the NEXT progress event, give the human that one, and tell them the earlier link is dead. Stop only at a 'complete' event whose state is claimed, then report the preview URL and the post-claim status. awaiting_claim, failed, a closed process, or a URL you guessed is not success.",
  "",
  "11. AFTER THE CLAIM, act on the SDK fact you noted in step 9. If it was present, say in one line that the Layers SDK is already installed. If it was absent, tell the human the Layers SDK is missing and OFFER to open a pull request that instruments this app for the noted platform; open that pull request only after they say yes, and ask them for the App ID from the claimed workspace rather than inventing one. If it was undetermined, or you never saw the fact, say nothing about it.",
  "",
  "12. FAILURE. On a terminal 'error' event, or if this process exits without a claimed 'complete', report what it printed: the trial handle, the last progress state, and the server failure code when it gave one. An 'error' event whose stage is preflight means nothing was reserved and nothing was read from this machine; when it carries an updateCommand, that command is the fix. Never report a step as done that this process did not report as done.",
  "",
  "13. WHERE THE OUTPUT IS. Every event described here is a JSON line on STDOUT. Anything this process has to say that is not one of those lines is on STDERR, including the final message when it exits non-zero, so read both before you conclude it said nothing.",
].join("\n");
