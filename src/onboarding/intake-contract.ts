/**
 * The pre-claim intake walk, mirrored from the Layers API contract.
 *
 * SOURCE OF TRUTH: `packages/shared-types/src/http/onboard-agent/routes.ts` in
 * `layers/layers` — `OnboardAgentIntakeOptionSchema`,
 * `OnboardAgentIntakeQuestionSchema`, `OnboardAgentIntakeDockSchema`,
 * `OnboardAgentIntakeWalkSchema`, `OnboardAgentIntakeAnswerSchema`,
 * `OnboardAgentIntakeAnswersRequestSchema` and
 * `OnboardAgentIntakeAnswersResponseSchema`; the route itself is
 * `apps/api/src/routes/onboard/agent/intake-answers.ts`.
 *
 * WHY A LOCAL MIRROR rather than a dependency bump. The canonical schemas ship
 * in `@layers/onboarding-contracts`, which this package pins at `0.1.4`.
 * Upstream, the contract artifact and the six native collector binaries are
 * stamped from one version number, so bumping the contract package to reach
 * these schemas would force republishing all six collector packages for a
 * collector that did not change. The mirror is deliberately minimal: request
 * shape, response shape, and the route path.
 *
 * DRIFT POLICY. The mirrored question fields that this launcher only relays
 * (`group`, `channel`, `mode`) are typed as plain strings rather than as the
 * canonical enums, so a server that adds a growth channel or an intake group
 * cannot brick a launcher that is already installed on somebody's machine.
 * `select` stays an enum because it decides how many option values an answer
 * may carry — a value this launcher does not understand must fail the read
 * (and fail the claim gate open) rather than be guessed at.
 */
import { ONBOARDING_PROTOCOL_VERSION } from "@layers/onboarding-contracts";
import { z } from "zod";

/**
 * `GET`/`POST /api/onboard/agent/trials/:trialHandle/intake-answers`.
 *
 * Declared here rather than read from `ONBOARD_AGENT_PUBLIC_ROUTE_PATHS`
 * because the pinned `0.1.4` contract artifact predates the route and does not
 * carry the key.
 */
export const ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH =
  "/api/onboard/agent/trials/:trialHandle/intake-answers";

/**
 * The option arm free text rides on, and the question it rode on before the
 * wire said so.
 *
 * THE OPTION VALUE IS THE RULE. The server resolves `allowsText` from the
 * canonical definition — a `<field>Other` companion plus an option committing
 * `<field>: 'other'` — so the arm that carries text is always the `other`
 * option, whatever question it belongs to.
 *
 * THE FIELD IS THE FALLBACK, not the rule. `1.3.0` hard-coded `goal` because the
 * wire carried no flag; a walk served without `allowsText` still reads that way,
 * so an older server keeps its exact behavior. A walk that carries the flag is
 * believed instead, which is what lets the server add a second free-text
 * question without stranding launchers already installed on people's machines.
 */
export const INTAKE_FREE_TEXT_ARM = {
  field: "goal",
  optionValue: "other",
} as const;

/** The longest free-text answer the route accepts. */
export const INTAKE_FREE_TEXT_MAX_LENGTH = 200;

export const IntakeOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const IntakeQuestionSchema = z.object({
  field: z.string(),
  group: z.string(),
  channel: z.string().optional(),
  mode: z.string().optional(),
  select: z.enum(["single", "multiple"]),
  /**
   * Whether this question has an arm that accepts free text.
   *
   * Server source of truth, resolved there from the canonical definition. It is
   * `.optional()` HERE and only here because a server that predates the flag
   * must not fail this launcher's read; `questionAllowsFreeText()` falls back to
   * the `goal`/`other` rule when it is absent.
   */
  allowsText: z.boolean().optional(),
  /**
   * Whether no answer is a valid answer. On a multi-select this means the empty
   * set commits. Relayed for completeness; the empty pick is advertised for
   * every multi-select either way and a server refusal re-prompts.
   */
  optional: z.boolean().optional(),
  title: z.string(),
  /**
   * The canonical one-liner under the title, present only when the question
   * carries one. On `managedInterest` it is the only place the managed-account
   * price appears, so a surface rendering those options must carry it verbatim.
   */
  subtitle: z.string().optional(),
  options: z.array(IntakeOptionSchema),
});

export const IntakeDockSchema = z.object({
  group: z.string(),
  channel: z.string().optional(),
  mode: z.string().optional(),
  questions: z.array(IntakeQuestionSchema),
});

export const IntakeWalkSchema = z.object({
  docks: z.array(IntakeDockSchema),
  remaining: z.array(IntakeQuestionSchema),
});

/**
 * One answer as the person gave it: the question's field and the option values
 * they picked. Never a typed intake fragment — the server resolves the pick
 * through the canonical question's own update, so a stored answer is always one
 * the walk could have produced.
 */
export const IntakeAnswerSchema = z
  .object({
    field: z.string().min(1).max(64),
    optionValues: z.array(z.string().min(1).max(64)),
    text: z.string().trim().min(1).max(INTAKE_FREE_TEXT_MAX_LENGTH).optional(),
  })
  .strict();

export const IntakeAnswersRequestSchema = z
  .object({
    protocolVersion: z.literal(ONBOARDING_PROTOCOL_VERSION),
    answers: z.array(IntakeAnswerSchema).min(1),
  })
  .strict();

/**
 * One answer the walk could not take, reported so the question can be ASKED
 * AGAIN rather than read as recorded.
 *
 * MIRRORS `OnboardAgentIntakeRejectionSchema`. The route answers a refused
 * answer with 200 and this list, because a person picking something not on the
 * list is a person to re-ask, not a run to kill. A launcher that does not model
 * it reads that 200 as success and loops on the same question until the claim
 * gate times out (layers/mcp-server#19).
 *
 * `reason` stays a plain string rather than the canonical enum, so a server that
 * names a new refusal cannot break a launcher already installed.
 */
export const IntakeRejectionSchema = z.object({
  field: z.string(),
  reason: z.string(),
  message: z.string(),
  options: z.array(IntakeOptionSchema).optional(),
});

/**
 * The answer to both methods on the route.
 *
 * Not `.strict()`: a field added server-side must not break a launcher that is
 * already installed. Unknown keys are dropped, which is the forward-compatible
 * reading of a response this process only consumes.
 */
export const IntakeAnswersResponseSchema = z.object({
  protocolVersion: z.literal(ONBOARDING_PROTOCOL_VERSION),
  trialHandle: z.string(),
  complete: z.boolean(),
  /**
   * Whether every answer the trial holds is present in the project.
   *
   * A convergence report, not a failure: the trial holds the durable copy
   * regardless, and the next read, the next answer, or the claim repairs it.
   * This launcher relays it and never gates on it.
   */
  answersConverged: z.boolean(),
  answered: z.array(z.string()),
  /**
   * Answers in the request the walk could not take. Always sent by a current
   * server and usually empty; defaulted so a response from a server that
   * predates the field still parses as "nothing was refused".
   */
  rejected: z.array(IntakeRejectionSchema).optional().default([]),
  intake: IntakeWalkSchema,
});

export type IntakeOption = z.infer<typeof IntakeOptionSchema>;
export type IntakeQuestion = z.infer<typeof IntakeQuestionSchema>;
export type IntakeRejection = z.infer<typeof IntakeRejectionSchema>;
export type IntakeWalk = z.infer<typeof IntakeWalkSchema>;
export type IntakeAnswer = z.infer<typeof IntakeAnswerSchema>;
export type IntakeAnswersResponse = z.infer<typeof IntakeAnswersResponseSchema>;

/**
 * The option value this question's free text rides on, or `undefined` when it
 * takes none.
 *
 * Two facts have to line up: the question must ALLOW text, and it must offer the
 * arm that has somewhere to put it. A wire flag without the arm would leave a
 * launcher advertising a command the server can only refuse, so the pair is
 * resolved together and read as "no free text here" when it does not hold.
 */
export function intakeFreeTextOptionValue(
  question: IntakeQuestion,
): string | undefined {
  const allowed =
    question.allowsText ?? question.field === INTAKE_FREE_TEXT_ARM.field;
  if (!allowed) return undefined;
  return question.options.some(
    (option) => option.value === INTAKE_FREE_TEXT_ARM.optionValue,
  )
    ? INTAKE_FREE_TEXT_ARM.optionValue
    : undefined;
}

/** Whether this question takes free text on one of its offered arms. */
export function questionAllowsFreeText(question: IntakeQuestion): boolean {
  return intakeFreeTextOptionValue(question) !== undefined;
}
