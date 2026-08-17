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

async function withClosedAdmissionApi(fn) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://mock.local").pathname;
    const body =
      pathname === ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.capabilities
        ? CLOSED_MANIFEST
        : { error: "unexpected request" };
    response.writeHead(
      pathname === ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.capabilities ? 200 : 404,
      { "cache-control": "no-store", "content-type": "application/json" },
    );
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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

  // The claim link is withheld until intake settles and the preview is ready.
  assert.match(AGENT_INSTRUCTIONS, /withhold the claim link until it reports the questions complete and the preview ready/u);
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
    const run = await withClosedAdmissionApi((baseUrl) =>
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
