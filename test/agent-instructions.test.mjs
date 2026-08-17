// The operating protocol the launcher hands to the agent driving it.
//
// FOUNDER RULING 2026-08-17: the public paste is one sentence, and the rules it
// used to carry are emitted by the process that needs them followed. Two things
// are therefore load-bearing and tested here: that the rules SAY what the paste
// said, and that they arrive FIRST — before the launcher does anything an agent
// would have to drive.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  ONBOARDING_CAPABILITY_READINESS_CHECK_IDS,
  ONBOARD_AGENT_PUBLIC_ROUTE_PATHS,
  OnboardingCapabilityManifestConsumerSchema,
  OnboardingClosedCapabilityManifestSchema,
} from "@layers/onboarding-contracts";

import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_PROTOCOL_VERSION,
  AGENT_INSTRUCTION_COMMANDS,
} from "../dist/onboarding/agent-instructions.js";
import { spawnServer } from "./helpers.mjs";

const CLOSED_MANIFEST = OnboardingClosedCapabilityManifestSchema.parse({
  schemaVersion: 1,
  protocolVersion: null,
  evidenceSchemaVersion: null,
  collectionPolicyVersion: null,
  collectorVersion: null,
  collectorProtocolVersion: null,
  sourceInspectionSchemaVersion: null,
  codebaseDigestSchemaVersion: null,
  supportedSourceKinds: [],
  sameSessionBootstrapCommand: null,
  hostedMcpEndpoint: null,
  compatibility: null,
  schemaReadiness: {
    ready: false,
    checkedAt: null,
    databaseRevision: null,
    requiredChecks: [...ONBOARDING_CAPABILITY_READINESS_CHECK_IDS],
    passedChecks: [],
  },
  sourceAdmission: "closed",
  generatedAt: "2026-08-17T00:00:00.000Z",
});

/**
 * The capability manifest for a server that HAS opened source admission.
 *
 * Used to get past preflight so the ordering of the local collector check
 * against the reservation is observable.
 */
const OPEN_MANIFEST = OnboardingCapabilityManifestConsumerSchema.parse({
  schemaVersion: 1,
  protocolVersion: 1,
  evidenceSchemaVersion: 1,
  collectionPolicyVersion: "v1",
  collectorVersion: "0.1.5",
  collectorProtocolVersion: 1,
  sourceInspectionSchemaVersion: 1,
  codebaseDigestSchemaVersion: 1,
  supportedSourceKinds: ["codebase", "remote_repository", "url"],
  sameSessionBootstrapCommand: "npx --yes @layers/mcp-server@1.3.1 onboard",
  hostedMcpEndpoint: "https://api.layers.test/mcp",
  compatibility: {
    currentProtocolVersion: 1,
    acceptedEvidenceSchemaVersions: [1],
    acceptedCollectionPolicyVersions: ["v1"],
    // Both, so this fixture is about ORDERING rather than about whichever
    // collector release the package happens to pin today.
    acceptedCollectorVersions: ["0.1.4", "0.1.5"],
    minimumMcpServerVersion: "1.3.1",
    minimumBootstrapVersion: "1.3.1",
    recommendedMcpServerVersion: "1.3.1",
    unsafeMismatch: {
      code: "ONBOARD_UPDATE_REQUIRED",
      updateCommand: "npx --yes @layers/mcp-server@1.3.1 onboard",
    },
  },
  schemaReadiness: {
    ready: true,
    checkedAt: "2026-08-17T00:00:00.000Z",
    databaseRevision: "rev-1",
    requiredChecks: [...ONBOARDING_CAPABILITY_READINESS_CHECK_IDS],
    passedChecks: [...ONBOARDING_CAPABILITY_READINESS_CHECK_IDS],
  },
  sourceAdmission: "public",
  generatedAt: "2026-08-17T00:00:00.000Z",
});

async function withManifestApi(manifest, fn) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://mock.local").pathname;
    requests.push(pathname);
    const isCapabilities =
      pathname === ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.capabilities;
    response.writeHead(isCapabilities ? 200 : 404, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(isCapabilities ? manifest : { error: "unexpected request" }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const run = await fn(`http://127.0.0.1:${server.address().port}`);
    return { run, requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const withClosedAdmissionApi = (fn) => withManifestApi(CLOSED_MANIFEST, fn);
const withOpenAdmissionApi = (fn) => withManifestApi(OPEN_MANIFEST, fn);

test("the instructions are ASCII and name no address to go read", () => {
  const nonAscii = [...AGENT_INSTRUCTIONS].filter((character) => {
    const code = character.codePointAt(0);
    return code > 126 || (code < 32 && character !== "\n");
  });
  assert.deepEqual(nonAscii, [], "the instructions must stay plain ASCII");
  // A URL inside agent-driving text is an instruction to go read something
  // else, which is the exact failure this event exists to remove.
  assert.equal(/https?:\/\/|www\./iu.test(AGENT_INSTRUCTIONS), false);
});

test("the instructions carry the consent gate and the SDK offer gate", () => {
  // THE CONSENT GATE. Printing the projection is not the rule; STOPPING is.
  assert.match(AGENT_INSTRUCTIONS, /canonicalProjection verbatim in a fenced code block/u);
  assert.match(AGENT_INSTRUCTIONS, /END YOUR TURN and wait for the human's explicit approval/u);
  assert.match(AGENT_INSTRUCTIONS, /Never invent an ID or a hash, and never synthesize consent/u);

  // THE SDK OFFER GATE. Offer, then wait; never open the pull request first,
  // and never invent the App ID that would make it look real.
  assert.match(AGENT_INSTRUCTIONS, /OFFER to open a pull request/u);
  assert.match(AGENT_INSTRUCTIONS, /only after they say yes/u);
  assert.match(AGENT_INSTRUCTIONS, /rather than inventing one/u);
  assert.match(AGENT_INSTRUCTIONS, /undetermined, or you never saw the fact, say nothing/u);

  // The polling contract the classifier and the launcher both depend on.
  assert.match(AGENT_INSTRUCTIONS, /block: true and timeout: 15000, and never use a longer wait/u);
  assert.match(AGENT_INSTRUCTIONS, /do not cancel or restart merely because output is unchanged/u);

  // The launcher gates the claim link itself; the wording that keys the agent's
  // behaviour on it has its own test below.
  assert.match(AGENT_INSTRUCTIONS, /this process holds it until the setup questions have SETTLED and the preview is ready/u);
  assert.match(AGENT_INSTRUCTIONS, /Stop only at a 'complete' event whose state is claimed/u);
});

test("the advertised command vocabulary covers every turn the launcher prompts", () => {
  assert.deepEqual(Object.values(AGENT_INSTRUCTION_COMMANDS), [
    "select <candidateId>",
    "exclude-path <pathId>",
    "exclude-target <candidateId>",
    "include-target <candidateId>",
    "prepare",
    "approve <displayEventId> <canonicalProjectionSha256>",
    "resume",
    "answer <field> <value>",
    "cancel",
  ]);
});

test(
  "agent_instructions is the launcher's first line, ahead of the reservation",
  { timeout: 30_000 },
  async () => {
    const { run } = await withClosedAdmissionApi((baseUrl) =>
      spawnServer(["onboard", "--base-url", baseUrl], {
        // Without the operator token, closed admission ends the run inside the
        // preflight — BEFORE the reservation status is emitted. Whatever reached
        // stdout by then is what an agent is guaranteed to receive.
        scrub: [
          "LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN",
          "LAYERS_API_KEY",
          "LAYERS_BASE_URL",
          "LAYERS_ORGANIZATION",
          "LAYERS_READ_ONLY",
        ],
        killAfterMs: 20_000,
      }),
    );

    const events = run.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.ok(events.length >= 1, "the launcher printed no events");
    assert.equal(events[0].type, "agent_instructions");
    assert.equal(
      events[0].protocolVersion,
      AGENT_INSTRUCTIONS_PROTOCOL_VERSION,
    );
    assert.equal(events[0].instructions, AGENT_INSTRUCTIONS);
    assert.deepEqual(events[0].commands, AGENT_INSTRUCTION_COMMANDS);

    // Emitted ONCE, and ahead of everything else this process says.
    assert.equal(
      events.filter((event) => event.type === "agent_instructions").length,
      1,
    );
    assert.equal(
      events.some(
        (event) => event.type === "status" && event.stage === "reservation",
      ),
      false,
      "the reservation must not precede the instructions",
    );
    assert.match(run.stderr, /Layers source onboarding is not open yet/u);
  },
);

test("the instructions key the claim link on the walk having settled", () => {
  // `skipped` reports complete:false ON PURPOSE — the question service failed
  // open rather than holding a finished workspace hostage. Wording that says
  // "withhold until the questions are complete" therefore tells the agent to
  // withhold the link forever in exactly the case the fail-open exists for.
  assert.equal(/until it reports the questions complete/u.test(AGENT_INSTRUCTIONS), false);
  assert.match(AGENT_INSTRUCTIONS, /state complete, not_required or skipped/u);
  assert.match(AGENT_INSTRUCTIONS, /skipped reports complete false on purpose/u);
  // The launcher gates the link itself, so anything the agent actually sees is
  // safe to hand over.
  assert.match(
    AGENT_INSTRUCTIONS,
    /any claimUrl you actually see on a progress event is safe to give the human/u,
  );
});

test("the instructions cover the re-minted claim link and the stderr channel", () => {
  assert.match(AGENT_INSTRUCTIONS, /claim_link_refreshed/u);
  assert.match(AGENT_INSTRUCTIONS, /take the new claim link from the NEXT progress event/u);
  assert.match(AGENT_INSTRUCTIONS, /stage awaiting_claim every few minutes/u);
  // Preflight failures and the exit message live on stderr; an agent that reads
  // only stdout would otherwise report silence.
  assert.match(AGENT_INSTRUCTIONS, /Anything this process has to say that is not one of those lines is on STDERR/u);
  assert.match(AGENT_INSTRUCTIONS, /stage is preflight means nothing was reserved/u);
});

test("closed admission is one stdout error event, and reserves nothing", async () => {
  const { run, requests } = await withClosedAdmissionApi((baseUrl) =>
    spawnServer(["onboard", "--base-url", baseUrl], {
      scrub: [
        "LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN",
        "LAYERS_API_KEY",
        "LAYERS_BASE_URL",
        "LAYERS_ORGANIZATION",
        "LAYERS_READ_ONLY",
      ],
      killAfterMs: 20_000,
    }),
  );

  const events = run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  // THE POINT: a preflight refusal used to be a stderr line and an exit code,
  // so an agent reading the JSONL stream watched the process die with nothing
  // to report.
  const errors = events.filter((event) => event.type === "error");
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    type: "error",
    stage: "preflight",
    code: "ONBOARD_ADMISSION_CLOSED",
    retryable: false,
    evidenceSubmitted: false,
    message: "Layers source onboarding is not open yet",
  });
  // It follows the instructions and precedes nothing else.
  assert.equal(events[0].type, "agent_instructions");
  assert.equal(events.at(-1).type, "error");

  // NOTHING WAS RESERVED. The whole reason preflight runs first.
  assert.equal(
    requests.some((pathname) => pathname.endsWith("/start")),
    false,
    "a refused preflight must not reserve a trial",
  );
  // stderr and the exit code are unchanged; the event is an added channel.
  assert.match(run.stderr, /Layers source onboarding is not open yet/u);
  assert.equal(run.code, 1);
});

test("the local collector is verified before anything is reserved", async () => {
  // ORDERING, asserted on the events rather than on a fault: a local artifact
  // problem is knowable from this machine alone, so paying for a trial row and
  // a reservation before checking is spending server state on a run that can
  // never proceed.
  const collectorCheck = AGENT_INSTRUCTIONS.length; // keep the import honest
  assert.ok(collectorCheck > 0);

  const { run } = await withOpenAdmissionApi((baseUrl) =>
    spawnServer(["onboard", "--base-url", baseUrl], {
      scrub: [
        "LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN",
        "LAYERS_API_KEY",
        "LAYERS_BASE_URL",
        "LAYERS_ORGANIZATION",
        "LAYERS_READ_ONLY",
      ],
      killAfterMs: 20_000,
    }),
  );

  const events = run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const stageIndex = (stage) =>
    events.findIndex(
      (event) => event.type === "status" && event.stage === stage,
    );
  const checkIndex = stageIndex("collector_check");
  assert.ok(checkIndex >= 0, "the collector check announced itself");
  const reservationIndex = stageIndex("reservation");
  // Either the reservation never happened (the collector check stopped it), or
  // it happened strictly after the check.
  assert.ok(
    reservationIndex === -1 || reservationIndex > checkIndex,
    "the collector is verified before the reservation",
  );
});
