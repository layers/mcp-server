/**
 * The pre-claim intake walk, driven one question at a time over the launcher's
 * FIFO stdin protocol while the preview builds in the background.
 *
 * WHY IT LIVES HERE. The agent door has to ask the SAME canonical questions the
 * browser door asks, at the same point in the flow (founder directive
 * 2026-08-16). The window for that is the build window: consent has been
 * approved, the approved evidence is on its way, and the preview takes a minute
 * or two to appear. Asking then costs the person nothing, because they would be
 * waiting anyway.
 *
 * THE ORDER IS THE CONTRACT. One question is on screen at a time, carrying its
 * exact canonical title, its offered options verbatim, and the exact command
 * that answers it. The next question is emitted only after the previous answer
 * is recorded server-side, because the server recomputes the walk on every write
 * — a launcher that pre-emitted the rest of the list would be reading from a
 * walk that no longer exists.
 *
 * IT NEVER SHARES THE SCREEN WITH CONSENT. The sequence already guarantees it
 * (the walk starts after approval), and `IntakeConsentSurface` guarantees it
 * again, because a guarantee that lives only in call order is one refactor away
 * from being untrue.
 *
 * IT NEVER STRANDS A FINISHED PREVIEW. Every path out of this module settles the
 * claim gate: answered, nothing to ask, the question service is unreachable, or
 * the walk was left unanswered past its bounded window. A broken question
 * service must cost a person their questions, never their workspace.
 */
import {
  INTAKE_FREE_TEXT_ARM,
  INTAKE_FREE_TEXT_MAX_LENGTH,
  type IntakeAnswer,
  type IntakeAnswersResponse,
  type IntakeQuestion,
  questionAllowsFreeText,
} from "./intake-contract.js";
import {
  SourceOnboardingError,
  readIntakeWalk,
  submitIntakeAnswer,
} from "./source-api.js";

/**
 * How long the whole walk may hold the claim gate.
 *
 * Deliberately the same 15 minutes the claim handoff itself waits: intake runs
 * inside the window a person is already sitting in, and a walk nobody answers
 * must not outlive the thing it is delaying.
 */
export const INTAKE_WALK_WAIT_MS = 15 * 60_000;

/** Attempts per intake request — one call plus three bounded retries. */
export const INTAKE_REQUEST_ATTEMPTS = 4;

/**
 * Consecutive server refusals of ONE question before the gate fails open.
 *
 * A refusal re-prompts rather than fails, because the honest reading of "the
 * server would not take that answer" is that the person should pick again. A
 * caller that keeps sending the same rejected answer is not walking the
 * question set, and holding the claim link hostage to that loop helps nobody.
 */
export const INTAKE_REFUSAL_LIMIT = 5;

/** Retry floor, matching the launcher's progress-poll cadence. */
const INTAKE_RETRY_FLOOR_MS = 5_000;
const INTAKE_RETRY_CEILING_MS = 10_000;

export type IntakeState = "asking" | "complete" | "not_required" | "skipped";

export interface IntakeSummary {
  state: IntakeState;
  /**
   * The explicit intake-complete signal, reported the same way `previewReady`
   * is: a boolean the agent can read rather than a state it has to infer.
   * True once every outstanding question is answered, and true when there was
   * nothing to ask. False while questions remain and false when the walk was
   * skipped.
   */
  complete: boolean;
  answered: number;
  remaining: number;
  /**
   * Whether the server reports the stored answers present in the project.
   * Relayed, never gated on: the trial holds the durable copy either way.
   * Null before any successful read.
   */
  answersConverged: boolean | null;
}

export type IntakeEvent =
  | ({ type: "intake"; message: string; reason?: string } & IntakeSummary)
  | {
      type: "input_required";
      operation: "answer_intake";
      question: {
        field: string;
        title: string;
        subtitle?: string;
        select: "single" | "multiple";
        allowsFreeText: boolean;
        options: Array<{ value: string; label: string }>;
      };
      answered: number;
      remaining: number;
      commands: string[];
      /** The server's reason for refusing the previous answer, when there was one. */
      refusal?: string;
    };

/** The launcher's input pipe, narrowed to what the walk uses. */
export interface IntakeInput {
  nextBefore(deadlineAtMs: number): Promise<string | null>;
}

/**
 * The consent proposal's on-screen state.
 *
 * The walk asks this before every turn it emits. Consent is a decision a person
 * makes about their own source code; an intake question appearing beside it, or
 * worse in place of it, turns a deliberate approval into a form to click
 * through.
 */
export interface IntakeConsentSurface {
  isDisplayed(): boolean;
  whenIdle(): Promise<void>;
}

/** The concrete surface the launcher brackets its consent proposal with. */
export class ConsentSurface implements IntakeConsentSurface {
  #displayed = false;
  #waiters: Array<() => void> = [];

  display(): void {
    this.#displayed = true;
  }

  clear(): void {
    if (!this.#displayed) return;
    this.#displayed = false;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }

  isDisplayed(): boolean {
    return this.#displayed;
  }

  whenIdle(): Promise<void> {
    if (!this.#displayed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

/**
 * The claim gate.
 *
 * `settled` is what the preview/claim loop waits on, so the claim link appears
 * in the same beat as the final answer rather than on the next poll tick.
 */
export interface IntakeWalkGate {
  readonly settled: Promise<void>;
  isSettled(): boolean;
  summary(): IntakeSummary;
}

export interface IntakeWalkRunner {
  readonly gate: IntakeWalkGate;
  run(): Promise<void>;
}

export interface IntakeWalkDependencies {
  /**
   * Narrow test seams. Production callers omit them and use the real public
   * routes and the real clock-backed delay.
   */
  readWalk?: (signal: AbortSignal) => Promise<IntakeAnswersResponse>;
  submitAnswer?: (
    answer: IntakeAnswer,
    signal: AbortSignal,
  ) => Promise<IntakeAnswersResponse>;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** The commands that answer one question, in the order they are offered. */
export function intakeAnswerCommands(question: IntakeQuestion): string[] {
  const commands = question.options.map(
    (option) => `answer ${question.field} ${option.value}`,
  );
  if (question.select === "multiple") {
    if (question.options.length > 1) {
      commands.push(`answer ${question.field} <value>,<value>`);
    }
    // The empty pick is a real answer to a multi-select — leaving every box
    // unticked commits `[]` rather than nothing (founder ruling 2026-08-06).
    // The wire question carries no `optional` flag, so this is advertised for
    // every multi-select and a server refusal re-prompts.
    commands.push(`answer ${question.field}`);
  }
  if (questionAllowsFreeText(question)) {
    commands.push(
      `answer ${question.field} ${INTAKE_FREE_TEXT_ARM.optionValue} <your own words>`,
    );
  }
  return commands;
}

type ParsedAnswerLine =
  | { ok: true; answer: IntakeAnswer }
  | { ok: false }
  | null;

/**
 * One stdin line, read as an answer to THIS question.
 *
 * `null` means the line is not an answer command at all, and `{ ok: false }`
 * means it is an answer command this question cannot take. Both re-prompt: the
 * existing turns treat an unusable line as a line that was never sent, and a
 * question the person is still looking at is the honest response to one.
 */
export function parseIntakeAnswerLine(
  line: string,
  question: IntakeQuestion,
): ParsedAnswerLine {
  const match = /^answer(?:\s+(\S+)(?:\s+(\S+)(?:\s+([\s\S]+))?)?)?$/u.exec(
    line.trim(),
  );
  if (!match) return null;
  const [, field, rawValues, rawText] = match;
  if (!field || field !== question.field) return { ok: false };

  const optionValues =
    rawValues === undefined
      ? []
      : rawValues
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);

  const offered = new Set(question.options.map((option) => option.value));
  if (optionValues.some((value) => !offered.has(value))) return { ok: false };
  if (new Set(optionValues).size !== optionValues.length) return { ok: false };
  if (question.select === "single" && optionValues.length !== 1) {
    return { ok: false };
  }
  if (question.select === "multiple" && rawValues !== undefined && optionValues.length === 0) {
    return { ok: false };
  }

  const text = rawText?.trim();
  if (text !== undefined && text.length > 0) {
    // Free text has exactly one home in the canonical set. Sending it anywhere
    // else is a 400 rather than a silent drop, so refuse it here instead of
    // spending a request to be told the same thing.
    if (
      !questionAllowsFreeText(question) ||
      optionValues.length !== 1 ||
      optionValues[0] !== INTAKE_FREE_TEXT_ARM.optionValue ||
      text.length > INTAKE_FREE_TEXT_MAX_LENGTH
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      answer: { field: question.field, optionValues, text },
    };
  }

  return { ok: true, answer: { field: question.field, optionValues } };
}

function retryDelayMs(error: SourceOnboardingError): number {
  return Math.min(
    INTAKE_RETRY_CEILING_MS,
    Math.max(INTAKE_RETRY_FLOOR_MS, (error.retryAfterSeconds ?? 0) * 1000),
  );
}

function skipReason(error: unknown): string {
  if (error instanceof SourceOnboardingError) {
    return error.status === undefined
      ? "unreachable"
      : `http_${error.status}`;
  }
  return "unavailable";
}

export function createIntakeWalkRunner(options: {
  baseUrl: string;
  signal: AbortSignal;
  input: IntakeInput;
  emit: (event: IntakeEvent) => void;
  consent: IntakeConsentSurface;
  reservationDeadlineAtMs: number;
  dependencies?: IntakeWalkDependencies;
}): IntakeWalkRunner {
  const {
    baseUrl,
    signal,
    input,
    emit,
    consent,
    reservationDeadlineAtMs,
    dependencies = {},
  } = options;
  const now = dependencies.now ?? Date.now;
  const readWalk =
    dependencies.readWalk ??
    ((abort: AbortSignal) => readIntakeWalk(baseUrl, abort));
  const submitAnswer =
    dependencies.submitAnswer ??
    ((answer: IntakeAnswer, abort: AbortSignal) =>
      submitIntakeAnswer(baseUrl, answer, abort));
  const delay = dependencies.delay ?? defaultDelay;

  let summary: IntakeSummary = {
    state: "asking",
    complete: false,
    answered: 0,
    remaining: 0,
    answersConverged: null,
  };
  let settledResolve: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settledResolve = resolve;
  });
  let isSettled = false;

  const settle = (
    state: Exclude<IntakeState, "asking">,
    message: string,
    reason?: string,
  ): void => {
    if (isSettled) return;
    isSettled = true;
    summary = {
      ...summary,
      state,
      complete: state === "complete" || state === "not_required",
    };
    emit({
      type: "intake",
      message,
      ...(reason === undefined ? {} : { reason }),
      ...summary,
    });
    settledResolve?.();
  };

  const record = (response: IntakeAnswersResponse): IntakeQuestion[] => {
    summary = {
      ...summary,
      answered: response.answered.length,
      remaining: response.intake.remaining.length,
      answersConverged: response.answersConverged,
    };
    return response.intake.remaining;
  };

  async function attempt(
    operation: (abort: AbortSignal) => Promise<IntakeAnswersResponse>,
  ): Promise<IntakeAnswersResponse> {
    let lastError: unknown;
    for (let index = 0; index < INTAKE_REQUEST_ATTEMPTS; index += 1) {
      try {
        return await operation(signal);
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw error;
        const retryable =
          error instanceof SourceOnboardingError && error.retryable;
        if (!retryable || index === INTAKE_REQUEST_ATTEMPTS - 1) throw error;
        await delay(retryDelayMs(error as SourceOnboardingError), signal);
      }
    }
    throw lastError;
  }

  async function walkQuestions(): Promise<void> {
    const walkDeadlineAtMs = Math.min(
      now() + INTAKE_WALK_WAIT_MS,
      reservationDeadlineAtMs,
    );
    {
      // The explicit non-interleaving guard, checked before the walk says
      // anything at all. The sequence already puts this after approval; this
      // makes it true by construction rather than by reading the call order.
      if (consent.isDisplayed()) await consent.whenIdle();

      let remaining: IntakeQuestion[];
      try {
        remaining = record(await attempt(readWalk));
      } catch (error) {
        if (signal.aborted) return;
        settle(
          "skipped",
          "Layers could not read the setup questions, so they were skipped. Nothing else is held up.",
          skipReason(error),
        );
        return;
      }

      if (remaining.length === 0) {
        settle("not_required", "Layers had no setup questions outstanding.");
        return;
      }

      emit({
        type: "intake",
        message:
          "Answering Layers setup questions while the preview builds in the background.",
        ...summary,
      });

      let refusals = 0;
      let refusal: string | undefined;
      while (remaining.length > 0) {
        if (signal.aborted) return;
        // Re-checked per turn: a proposal that reappears mid-walk must silence
        // the questions for exactly as long as it is on screen.
        if (consent.isDisplayed()) await consent.whenIdle();

        const question = remaining[0]!;
        emit({
          type: "input_required",
          operation: "answer_intake",
          question: {
            field: question.field,
            title: question.title,
            ...(question.subtitle === undefined
              ? {}
              : { subtitle: question.subtitle }),
            select: question.select,
            allowsFreeText: questionAllowsFreeText(question),
            options: question.options.map((option) => ({
              value: option.value,
              label: option.label,
            })),
          },
          answered: summary.answered,
          remaining: summary.remaining,
          commands: intakeAnswerCommands(question),
          ...(refusal === undefined ? {} : { refusal }),
        });
        refusal = undefined;

        // A closed pipe is the same fact as an unanswered question: nobody is
        // going to answer this one, and the claim gate must not wait for them.
        const line = await input
          .nextBefore(Math.min(walkDeadlineAtMs, reservationDeadlineAtMs))
          .catch(() => null);
        if (line === null) {
          settle(
            "skipped",
            "The setup questions were left unanswered, so they were skipped. Nothing else is held up.",
            "unanswered",
          );
          return;
        }

        const parsed = parseIntakeAnswerLine(line, question);
        // An unusable line re-prompts the SAME question, exactly as the scope
        // and approval turns re-advertise themselves after a command they
        // cannot apply.
        if (parsed === null || !parsed.ok) continue;

        let response: IntakeAnswersResponse;
        try {
          response = await attempt((abort) => submitAnswer(parsed.answer, abort));
        } catch (error) {
          if (signal.aborted) return;
          if (
            error instanceof SourceOnboardingError &&
            error.status === 400 &&
            refusals + 1 < INTAKE_REFUSAL_LIMIT
          ) {
            // A structured refusal names what was wrong with the pick. Re-ask
            // with the offered options rather than abandoning the walk.
            refusals += 1;
            refusal = error.reason ?? "That answer was not accepted.";
            continue;
          }
          settle(
            "skipped",
            "Layers could not record the setup answers, so the remaining questions were skipped. Nothing else is held up.",
            skipReason(error),
          );
          return;
        }

        refusals = 0;
        remaining = record(response);
        if (remaining.length > 0) {
          emit({
            type: "intake",
            message: "Answer recorded.",
            ...summary,
          });
        }
      }

      settle("complete", "Every Layers setup question is answered.");
    }
  }

  /**
   * The walk, wrapped so it can neither reject nor leave the gate closed.
   *
   * Both properties are load-bearing. A rejection would surface as an unhandled
   * rejection in a process whose stdout is a machine-read event stream, and an
   * unsettled gate would hold a finished preview behind questions nobody is
   * going to answer.
   */
  async function run(): Promise<void> {
    let failure: unknown;
    try {
      await walkQuestions();
    } catch (error) {
      failure = error;
    } finally {
      settle(
        "skipped",
        "The setup questions ended early and were skipped. Nothing else is held up.",
        failure === undefined ? "interrupted" : skipReason(failure),
      );
    }
  }

  return {
    gate: {
      settled,
      isSettled: () => isSettled,
      summary: () => summary,
    },
    run,
  };
}

async function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
