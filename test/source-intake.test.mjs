// The pre-claim intake walk: turn order, answer parsing, the consent
// exclusivity guard, and every path that settles the claim gate.
//
// Hermetic. The transport tests stub `globalThis.fetch` the way the launcher's
// claim tests do; the turn tests drive the runner through its narrow seams so a
// bounded-retry path costs a scheduled callback rather than fifteen seconds.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARD_AGENT_PUBLIC_HEADER_NAMES,
  OnboardAgentProgressResponseSchema,
} from "@layers/onboarding-contracts";

import {
  ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH,
  questionAllowsFreeText,
} from "../dist/onboarding/intake-contract.js";
import {
  ConsentSurface,
  INTAKE_REFUSAL_LIMIT,
  createIntakeWalkRunner,
  intakeAnswerCommands,
  parseIntakeAnswerLine,
} from "../dist/onboarding/intake-walk.js";
import { waitForPreviewAndClaim } from "../dist/onboarding/launcher.js";
import { rememberReservation } from "../dist/onboarding/session.js";
import {
  SourceOnboardingError,
  readIntakeWalk,
  submitIntakeAnswer,
} from "../dist/onboarding/source-api.js";

const BASE_URL = "https://api.layers.test";
const TRIAL_HANDLE = "b".repeat(64);
const RESERVATION_CAPABILITY = "reservation-capability-intake-sentinel";
const RESERVATION_EXPIRES_AT = new Date(
  Date.now() + 7 * 24 * 60 * 60 * 1000,
).toISOString();
const PREVIEW_URL = "https://app.layers.test/p/preview-token";
const ATTEMPT_HANDLE = "h".repeat(43);
const ATTEMPT_CLAIM_URL =
  `https://app.layers.test/claim#token=browser-claim-token&claimAttemptHandle=${ATTEMPT_HANDLE}`;

const MULTI_QUESTION = {
  field: "triedChannels",
  group: "baseline",
  select: "multiple",
  title: "Have you tried any of these growth strategies?",
  options: [
    { value: "social", label: "Posted on social" },
    { value: "ads", label: "Ran paid ads" },
  ],
};

const GOAL_QUESTION = {
  field: "goal",
  group: "direction",
  select: "single",
  title: "What are you trying to grow?",
  subtitle: "Pick the one that matters most right now.",
  options: [
    { value: "installs", label: "More installs" },
    { value: "other", label: "Something else" },
  ],
};

function rememberIntakeReservation(expiresAt = RESERVATION_EXPIRES_AT) {
  rememberReservation({
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    reservationCapability: RESERVATION_CAPABILITY,
    expiresAt,
    state: "awaiting_evidence",
  });
}

function walkResponse(remaining, answered = [], rejected = []) {
  return {
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    complete: remaining.length === 0,
    answersConverged: true,
    answered,
    // Always present on the wire and usually empty. A response the launcher
    // reads as an acknowledgement without looking here is the 1.3.0 bug.
    rejected,
    intake: {
      docks: remaining.length === 0
        ? []
        : [{ group: remaining[0].group, questions: remaining }],
      remaining,
    },
  };
}

/**
 * A walk that behaves the way the route does: answers accumulate, and BOTH
 * methods recompute `remaining` from what is answered.
 *
 * A stub that answers a fixed list regardless of what was written models a
 * server that forgets, which the launcher's final re-read reads as "these
 * questions came back". Modelling the accumulation is what makes the re-read
 * testable at all.
 */
function serverWalk(questions, { onSubmit } = {}) {
  const answered = [];
  const current = () =>
    walkResponse(
      questions.filter((question) => !answered.includes(question.field)),
      [...answered],
    );
  return {
    answered,
    readWalk: async () => current(),
    submitAnswer: async (answer) => {
      onSubmit?.(answer);
      if (!answered.includes(answer.field)) answered.push(answer.field);
      return current();
    },
  };
}

/** An input pipe that replays a script and then goes quiet, as a deadline does. */
function scriptedInput(lines) {
  const queue = [...lines];
  return {
    remaining: () => queue.length,
    nextBefore: async () => (queue.length > 0 ? queue.shift() : null),
  };
}

function runnerHarness({
  input = scriptedInput([]),
  consent = new ConsentSurface(),
  readWalk,
  submitAnswer,
  reservationDeadlineAtMs = Date.now() + 60 * 60_000,
} = {}) {
  const events = [];
  const controller = new AbortController();
  const runner = createIntakeWalkRunner({
    baseUrl: BASE_URL,
    signal: controller.signal,
    input,
    emit: (event) => events.push(event),
    consent,
    reservationDeadlineAtMs,
    dependencies: {
      readWalk,
      submitAnswer,
      // Bounded retry without the wall-clock wait. The production floor is the
      // progress-poll cadence; the schedule under test is the attempt count.
      delay: async () => {},
    },
  });
  return { runner, events, consent, controller, input };
}

const turnsIn = (events) =>
  events.filter(
    (event) =>
      event.type === "input_required" && event.operation === "answer_intake",
  );
const intakeEventsIn = (events) =>
  events.filter((event) => event.type === "intake");
const settlementOf = (events) =>
  intakeEventsIn(events).find((event) => event.state !== "asking");

test("parses only the answers the question actually offers", () => {
  assert.deepEqual(parseIntakeAnswerLine("answer goal installs", GOAL_QUESTION), {
    ok: true,
    answer: { field: "goal", optionValues: ["installs"] },
  });
  assert.deepEqual(
    parseIntakeAnswerLine("answer goal other selling more hats", GOAL_QUESTION),
    {
      ok: true,
      answer: {
        field: "goal",
        optionValues: ["other"],
        text: "selling more hats",
      },
    },
  );
  assert.deepEqual(
    parseIntakeAnswerLine("answer triedChannels social,ads", MULTI_QUESTION),
    {
      ok: true,
      answer: { field: "triedChannels", optionValues: ["social", "ads"] },
    },
  );
  // Leaving every box unticked is a real answer to a multi-select.
  assert.deepEqual(parseIntakeAnswerLine("answer triedChannels", MULTI_QUESTION), {
    ok: true,
    answer: { field: "triedChannels", optionValues: [] },
  });

  // Not answer commands at all.
  assert.equal(parseIntakeAnswerLine("prepare", GOAL_QUESTION), null);
  assert.equal(parseIntakeAnswerLine("", GOAL_QUESTION), null);
  // Answer commands this question cannot take.
  for (const line of [
    "answer goal bananas",
    "answer goal installs,other",
    "answer goal",
    "answer triedChannels ads,ads",
    "answer businessType saas",
    "answer goal installs some free text",
    "answer triedChannels social freeform",
  ]) {
    assert.deepEqual(
      parseIntakeAnswerLine(
        line,
        line.startsWith("answer triedChannels") ? MULTI_QUESTION : GOAL_QUESTION,
      ),
      { ok: false },
      line,
    );
  }
  assert.deepEqual(
    parseIntakeAnswerLine(`answer goal other ${"x".repeat(201)}`, GOAL_QUESTION),
    { ok: false },
  );
});

test("advertises one exact command per offered option", () => {
  assert.deepEqual(intakeAnswerCommands(GOAL_QUESTION), [
    "answer goal installs",
    "answer goal other",
    "answer goal other <your own words>",
  ]);
  assert.deepEqual(intakeAnswerCommands(MULTI_QUESTION), [
    "answer triedChannels social",
    "answer triedChannels ads",
    "answer triedChannels <value>,<value>",
    "answer triedChannels",
  ]);
  assert.equal(questionAllowsFreeText(GOAL_QUESTION), true);
  assert.equal(questionAllowsFreeText(MULTI_QUESTION), false);
});

test("free text follows the wire flag, not the field name", () => {
  // A SERVER-ADDED free-text question. 1.3.0 keyed the rule to `goal`, so this
  // one was offered only a bare-option command the route then refused, and the
  // walk looped on it until the claim gate timed out (layers/mcp-server#19).
  const described = {
    field: "appDescription",
    group: "business",
    select: "single",
    allowsText: true,
    optional: false,
    title: "How would you describe your app?",
    options: [
      { value: "social", label: "A social app" },
      { value: "other", label: "Something else" },
    ],
  };
  assert.equal(questionAllowsFreeText(described), true);
  assert.deepEqual(intakeAnswerCommands(described), [
    "answer appDescription social",
    "answer appDescription other",
    "answer appDescription other <your own words>",
  ]);
  assert.deepEqual(
    parseIntakeAnswerLine("answer appDescription other a running club", described),
    {
      ok: true,
      answer: {
        field: "appDescription",
        optionValues: ["other"],
        text: "a running club",
      },
    },
  );

  // The flag closes the arm as well as opening it: a server that says `goal`
  // no longer takes text is believed over the launcher's old hard-coded rule.
  assert.equal(
    questionAllowsFreeText({ ...GOAL_QUESTION, allowsText: false }),
    false,
  );
  assert.deepEqual(
    parseIntakeAnswerLine("answer goal other selling hats", {
      ...GOAL_QUESTION,
      allowsText: false,
    }),
    { ok: false },
  );

  // ABSENT FLAG KEEPS 1.3.0's BEHAVIOR EXACTLY, so a server that predates it
  // drives an installed launcher the same way it always did.
  assert.equal(questionAllowsFreeText(GOAL_QUESTION), true);
  assert.equal(questionAllowsFreeText(MULTI_QUESTION), false);
  assert.equal(
    questionAllowsFreeText({ ...described, allowsText: undefined }),
    false,
  );

  // A flag with no arm to carry the text advertises no free-text command,
  // rather than one the server could only refuse.
  assert.equal(
    questionAllowsFreeText({
      ...described,
      options: [{ value: "social", label: "A social app" }],
    }),
    false,
  );
});

test("an empty walk settles the gate without asking anything", async () => {
  const harness = runnerHarness({
    readWalk: async () => walkResponse([]),
    submitAnswer: async () => assert.fail("no answer may be written"),
  });
  await harness.runner.run();

  assert.deepEqual(turnsIn(harness.events), []);
  assert.equal(harness.runner.gate.isSettled(), true);
  assert.deepEqual(harness.runner.gate.summary(), {
    state: "not_required",
    complete: true,
    answered: 0,
    remaining: 0,
    answersConverged: true,
  });
  assert.equal(settlementOf(harness.events).state, "not_required");
});

test("asks one question at a time and reports an explicit completion", async () => {
  const submitted = [];
  const walk = serverWalk([MULTI_QUESTION, GOAL_QUESTION], {
    onSubmit: (answer) => submitted.push(answer),
  });
  const harness = runnerHarness({
    input: scriptedInput([
      "answer triedChannels social",
      "answer goal installs",
    ]),
    readWalk: walk.readWalk,
    submitAnswer: walk.submitAnswer,
  });
  await harness.runner.run();

  const turns = turnsIn(harness.events);
  assert.deepEqual(
    turns.map((turn) => turn.question.field),
    ["triedChannels", "goal"],
  );
  assert.deepEqual(submitted, [
    { field: "triedChannels", optionValues: ["social"] },
    { field: "goal", optionValues: ["installs"] },
  ]);
  // The second question is emitted only after the first answer is recorded.
  const firstWriteIndex = harness.events.findIndex(
    (event) => event.type === "intake" && event.answered === 1,
  );
  const secondTurnIndex = harness.events.indexOf(turns[1]);
  assert.ok(firstWriteIndex >= 0 && secondTurnIndex > firstWriteIndex);

  assert.deepEqual(harness.runner.gate.summary(), {
    state: "complete",
    complete: true,
    answered: 2,
    remaining: 0,
    answersConverged: true,
  });
  assert.equal(settlementOf(harness.events).complete, true);
});

test("re-asks with the offered options when the server refuses an answer", async () => {
  let calls = 0;
  const walk = serverWalk([GOAL_QUESTION]);
  const harness = runnerHarness({
    input: scriptedInput(["answer goal other custom", "answer goal installs"]),
    readWalk: walk.readWalk,
    submitAnswer: async (answer, abort) => {
      calls += 1;
      if (calls === 1) {
        throw new SourceOnboardingError(
          "Layers onboarding intake answer failed (400)",
          undefined,
          400,
          false,
          "goal does not take free text",
        );
      }
      assert.deepEqual(answer, { field: "goal", optionValues: ["installs"] });
      return await walk.submitAnswer(answer, abort);
    },
  });
  await harness.runner.run();

  const turns = turnsIn(harness.events);
  assert.equal(turns.length, 2, "the refusal re-asks rather than failing");
  assert.equal(turns[0].refusal, undefined);
  assert.equal(turns[1].refusal, "goal does not take free text");
  assert.deepEqual(turns[1].question.options, GOAL_QUESTION.options);
  assert.equal(harness.runner.gate.summary().state, "complete");
});

test("a refused answer is retried, not resent, and the gate opens after the cap", async () => {
  let calls = 0;
  const harness = runnerHarness({
    input: scriptedInput(
      Array.from({ length: INTAKE_REFUSAL_LIMIT + 2 }, () => "answer goal installs"),
    ),
    readWalk: async () => walkResponse([GOAL_QUESTION]),
    submitAnswer: async () => {
      calls += 1;
      throw new SourceOnboardingError(
        "Layers onboarding intake answer failed (400)",
        undefined,
        400,
        false,
        "Unknown option for goal: installs",
      );
    },
  });
  await harness.runner.run();

  // A 400 is not retryable, so each refusal costs exactly one request.
  assert.equal(calls, INTAKE_REFUSAL_LIMIT);
  assert.equal(turnsIn(harness.events).length, INTAKE_REFUSAL_LIMIT);
  const settlement = settlementOf(harness.events);
  assert.equal(settlement.state, "skipped");
  assert.equal(settlement.complete, false);
  assert.equal(settlement.reason, "http_400");
  assert.equal(harness.runner.gate.isSettled(), true);
});

test("a 200 that refuses the answer re-asks instead of reading as recorded", async () => {
  const submitted = [];
  const walk = serverWalk([GOAL_QUESTION]);
  let calls = 0;
  const harness = runnerHarness({
    input: scriptedInput([
      "answer goal other selling more hats",
      "answer goal installs",
    ]),
    readWalk: walk.readWalk,
    submitAnswer: async (answer, abort) => {
      submitted.push(answer);
      calls += 1;
      if (calls === 1) {
        // THE 1.3.0 DEAD END. The route commits what it can and reports what it
        // could not, so a refusal is a 200 carrying `rejected`, never a throw.
        return walkResponse([GOAL_QUESTION], [], [
          {
            field: "goal",
            reason: "free_text_not_accepted",
            message: "goal does not take free text right now.",
            options: GOAL_QUESTION.options,
          },
        ]);
      }
      return await walk.submitAnswer(answer, abort);
    },
  });
  await harness.runner.run();

  const turns = turnsIn(harness.events);
  assert.equal(turns.length, 2, "the refusal re-asks the same question");
  assert.equal(turns[0].refusal, undefined);
  assert.equal(turns[1].refusal, "goal does not take free text right now.");
  assert.deepEqual(turns[1].question.options, GOAL_QUESTION.options);
  // The refusal must never be reported as an accepted answer.
  assert.equal(
    harness.events.some(
      (event) => event.type === "intake" && event.message === "Answer recorded.",
    ),
    false,
  );
  assert.equal(harness.runner.gate.summary().state, "complete");
  assert.equal(submitted.length, 2);
});

test("a rejection that keeps coming back opens the claim gate", async () => {
  const rejection = {
    field: "goal",
    reason: "option_not_offered",
    message: "Unknown option for goal.",
    options: GOAL_QUESTION.options,
  };
  let calls = 0;
  const harness = runnerHarness({
    input: scriptedInput(
      Array.from({ length: INTAKE_REFUSAL_LIMIT + 2 }, () => "answer goal installs"),
    ),
    readWalk: async () => walkResponse([GOAL_QUESTION]),
    submitAnswer: async () => {
      calls += 1;
      return walkResponse([GOAL_QUESTION], [], [rejection]);
    },
  });
  await harness.runner.run();

  assert.equal(calls, INTAKE_REFUSAL_LIMIT);
  assert.equal(turnsIn(harness.events).length, INTAKE_REFUSAL_LIMIT);
  const settlement = settlementOf(harness.events);
  assert.equal(settlement.state, "skipped");
  assert.equal(settlement.complete, false);
  assert.equal(settlement.reason, "refused");
  assert.equal(harness.runner.gate.isSettled(), true);
});

test("a control-laden rejection message is bounded before it is relayed", async () => {
  const harness = runnerHarness({
    input: scriptedInput(["answer goal installs", "answer goal installs"]),
    readWalk: async () => walkResponse([GOAL_QUESTION]),
    submitAnswer: async () =>
      walkResponse([GOAL_QUESTION], [], [
        {
          field: "goal",
          reason: "option_not_offered",
          message: `line one\nlinetwo ${"x".repeat(400)}`,
          options: GOAL_QUESTION.options,
        },
      ]),
  });
  await harness.runner.run();

  const relayed = turnsIn(harness.events)[1].refusal;
  assert.equal(relayed.length <= 200, true, "the relayed reason is bounded");
  assert.equal(/[ -]/u.test(relayed), false);
  assert.match(relayed, /^line one line two x+$/u);
});

test("the walk is re-read once after it empties and asks what the build added", async () => {
  // THE BUILD WINDOW MOVES THE WALK. The first read happens before the analysis
  // binds a project, so questions gated on server-side facts do not exist yet.
  // An agent that answers the baseline set quickly empties `remaining` before
  // they appear, and 1.3.0 settled there and dropped them.
  const late = { ...GOAL_QUESTION, field: "goal" };
  const answered = [];
  let reads = 0;
  const harness = runnerHarness({
    input: scriptedInput(["answer triedChannels social", "answer goal installs"]),
    readWalk: async () => {
      reads += 1;
      // The second read is the launcher's post-empty re-read; only then does
      // the newly applicable question exist.
      const pool = reads === 1 ? [MULTI_QUESTION] : [MULTI_QUESTION, late];
      return walkResponse(
        pool.filter((question) => !answered.includes(question.field)),
        [...answered],
      );
    },
    submitAnswer: async (answer) => {
      if (!answered.includes(answer.field)) answered.push(answer.field);
      const pool = reads === 1 ? [MULTI_QUESTION] : [MULTI_QUESTION, late];
      return walkResponse(
        pool.filter((question) => !answered.includes(question.field)),
        [...answered],
      );
    },
  });
  await harness.runner.run();

  assert.deepEqual(
    turnsIn(harness.events).map((turn) => turn.question.field),
    ["triedChannels", "goal"],
    "the late question was asked",
  );
  assert.deepEqual(answered, ["triedChannels", "goal"]);
  // ONE extra read for the whole walk, not one per emptying: this holds the
  // claim gate, and a walk that keeps re-reading itself holds it for as long as
  // the server keeps finding something to ask.
  assert.equal(reads, 2, "one opening read and exactly one re-read");
  assert.equal(harness.runner.gate.summary().state, "complete");
  assert.equal(harness.runner.gate.summary().complete, true);
});

test("a failed final re-read completes rather than reporting a skip", async () => {
  const walk = serverWalk([GOAL_QUESTION]);
  let reads = 0;
  const harness = runnerHarness({
    input: scriptedInput(["answer goal installs"]),
    readWalk: async (abort) => {
      reads += 1;
      if (reads === 1) return await walk.readWalk(abort);
      throw new SourceOnboardingError(
        "Layers onboarding intake read failed (503)",
        undefined,
        503,
        true,
      );
    },
    submitAnswer: walk.submitAnswer,
  });
  await harness.runner.run();

  // The answer that WAS given is recorded server-side, so the honest report is
  // completion. A failed re-read costs the questions nobody has seen yet.
  const settlement = settlementOf(harness.events);
  assert.equal(settlement.state, "complete");
  assert.equal(settlement.complete, true);
  assert.equal(settlement.answered, 1);
  assert.equal(harness.runner.gate.isSettled(), true);
});

test("a broken question service fails the claim gate open with an honest event", async () => {
  let reads = 0;
  const harness = runnerHarness({
    readWalk: async () => {
      reads += 1;
      throw new SourceOnboardingError(
        "Layers onboarding intake read failed (503)",
        0,
        503,
        true,
      );
    },
    submitAnswer: async () => assert.fail("no answer may be written"),
  });
  await harness.runner.run();

  assert.equal(reads, 4, "one call plus three bounded retries");
  assert.deepEqual(turnsIn(harness.events), []);
  const settlement = settlementOf(harness.events);
  assert.equal(settlement.state, "skipped");
  assert.equal(settlement.complete, false);
  assert.equal(settlement.reason, "http_503");
  assert.match(settlement.message, /skipped/);
  assert.equal(harness.runner.gate.isSettled(), true);
});

test("an API without the intake route asks nothing and holds nothing", async () => {
  // The launcher can be installed ahead of the API that serves the walk. A 404
  // is not retryable, so it costs one call and the claim gate opens.
  let reads = 0;
  const harness = runnerHarness({
    readWalk: async () => {
      reads += 1;
      throw new SourceOnboardingError(
        "Layers onboarding intake read failed (404)",
        undefined,
        404,
        false,
      );
    },
    submitAnswer: async () => assert.fail("no answer may be written"),
  });
  await harness.runner.run();

  assert.equal(reads, 1);
  assert.deepEqual(turnsIn(harness.events), []);
  assert.equal(settlementOf(harness.events).reason, "http_404");
  assert.equal(harness.runner.gate.isSettled(), true);
});

test("a write that stays unreachable fails open after the remaining questions", async () => {
  let writes = 0;
  const harness = runnerHarness({
    input: scriptedInput(["answer goal installs"]),
    readWalk: async () => walkResponse([GOAL_QUESTION]),
    submitAnswer: async () => {
      writes += 1;
      throw new SourceOnboardingError(
        "Layers onboarding is temporarily unreachable",
        undefined,
        undefined,
        true,
      );
    },
  });
  await harness.runner.run();

  assert.equal(writes, 4);
  const settlement = settlementOf(harness.events);
  assert.equal(settlement.state, "skipped");
  assert.equal(settlement.reason, "unreachable");
  assert.equal(harness.runner.gate.isSettled(), true);
});

test("an unanswered walk stops holding the claim gate", async () => {
  const harness = runnerHarness({
    input: scriptedInput([]),
    readWalk: async () => walkResponse([GOAL_QUESTION]),
    submitAnswer: async () => assert.fail("no answer may be written"),
  });
  await harness.runner.run();

  assert.equal(turnsIn(harness.events).length, 1, "the question was asked once");
  const settlement = settlementOf(harness.events);
  assert.equal(settlement.state, "skipped");
  assert.equal(settlement.reason, "unanswered");
  assert.equal(harness.runner.gate.isSettled(), true);
});

test("no intake turn is emitted while a consent proposal is on screen", async () => {
  const consent = new ConsentSurface();
  consent.display();
  const server = serverWalk([GOAL_QUESTION]);
  const harness = runnerHarness({
    consent,
    input: scriptedInput(["answer goal installs"]),
    readWalk: server.readWalk,
    submitAnswer: server.submitAnswer,
  });

  const walk = harness.runner.run();
  // Give the walk every chance to speak out of turn.
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    harness.events,
    [],
    "the walk must say nothing while consent is displayed",
  );
  assert.equal(harness.runner.gate.isSettled(), false);

  consent.clear();
  await walk;
  assert.equal(turnsIn(harness.events).length, 1);
  assert.equal(harness.runner.gate.summary().state, "complete");
});

test("the walk reads and writes on the reservation capability alone", async () => {
  rememberIntakeReservation();
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(input),
      capability:
        new Headers(init?.headers).get(
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability,
        ),
      body: init?.body,
    });
    return Response.json(walkResponse([GOAL_QUESTION]), { status: 200 });
  };

  try {
    const walk = await readIntakeWalk(BASE_URL, new AbortController().signal);
    assert.deepEqual(walk.intake.remaining, [GOAL_QUESTION]);
    await submitIntakeAnswer(
      BASE_URL,
      { field: "goal", optionValues: ["installs"] },
      new AbortController().signal,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const expectedPath = ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH.replace(
    ":trialHandle",
    TRIAL_HANDLE,
  );
  assert.deepEqual(
    seen.map((request) => request.method),
    ["GET", "POST"],
  );
  for (const request of seen) {
    assert.equal(new URL(request.url).pathname, expectedPath);
    assert.equal(request.capability, RESERVATION_CAPABILITY);
  }
  assert.deepEqual(JSON.parse(seen[1].body), {
    protocolVersion: 1,
    answers: [{ field: "goal", optionValues: ["installs"] }],
  });
});

test("a refusal reason is bounded and stripped before it can be relayed", async () => {
  rememberIntakeReservation();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: "Invalid onboarding intake request.",
        reason: `line\none\ttwo ${"z".repeat(400)}`,
      },
      { status: 400 },
    );

  try {
    await assert.rejects(
      submitIntakeAnswer(
        BASE_URL,
        { field: "goal", optionValues: ["installs"] },
        new AbortController().signal,
      ),
      (error) => {
        assert.equal(error instanceof SourceOnboardingError, true);
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.equal(error.reason.length, 200);
        assert.equal(error.reason.startsWith("line one two zzz"), true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a walk that finishes first still waits for the preview", async () => {
  rememberIntakeReservation();
  const settledGate = runnerHarness({
    readWalk: async () => walkResponse([]),
  });
  await settledGate.runner.run();
  assert.equal(settledGate.runner.gate.isSettled(), true);

  const analyzing = OnboardAgentProgressResponseSchema.parse({
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    state: "analyzing",
    stageLabel: "Understanding the product",
    completedMilestones: [
      "product_selected",
      "scope_approved",
      "evidence_received",
    ],
    outstandingCorrections: [],
    publicSurfaceState: "not_started",
    publicSurfaceCandidates: [],
    publicPagesConfirmation: null,
    groundedPlayback: [],
    previewReady: false,
    previewUrl: null,
    claimReady: false,
    claimUrl: null,
    failure: null,
    updatedAt: "2026-08-16T00:00:00.000Z",
  });
  const ready = OnboardAgentProgressResponseSchema.parse({
    ...analyzing,
    state: "awaiting_claim",
    stageLabel: "Preview ready — waiting for claim",
    completedMilestones: [
      ...analyzing.completedMilestones,
      "analysis_complete",
      "preview_ready",
    ],
    previewReady: true,
    previewUrl: PREVIEW_URL,
    claimReady: true,
    claimUrl: "https://app.layers.test/claim?token=legacy",
  });

  const originalFetch = globalThis.fetch;
  const events = [];
  let progressReads = 0;
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      progressReads += 1;
      return Response.json(progressReads === 1 ? analyzing : ready, {
        status: 200,
      });
    }
    if (pathname.endsWith("/claim-attempts")) {
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl: ATTEMPT_CLAIM_URL,
          // An already-expired attempt terminates the wait as awaiting_claim
          // right after the safe URL is published.
          expiresAt: "2000-01-01T00:00:00.000Z",
          state: "pending",
        },
        { status: 202 },
      );
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await waitForPreviewAndClaim(
      BASE_URL,
      new AbortController().signal,
      RESERVATION_EXPIRES_AT,
      (event) => events.push(event),
      settledGate.runner.gate,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(progressReads, 2, "the settled gate did not skip the wait");
  const claimIndex = events.findIndex(
    (event) =>
      event.type === "progress" && event.progress.claimUrl === ATTEMPT_CLAIM_URL,
  );
  const completion = events.find((event) => event.type === "complete");
  assert.ok(claimIndex >= 0);
  assert.equal(completion.state, "awaiting_claim");
  assert.deepEqual(completion.intake, {
    state: "not_required",
    complete: true,
    answered: 0,
    remaining: 0,
    answersConverged: true,
  });
});
