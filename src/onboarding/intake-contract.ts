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
 * in `@layers/onboarding-contracts`, which this package pins at `0.1.4` — the
 * same version the six native collector binaries are pinned to. Bumping the
 * contract package to reach these three schemas would force republishing all
 * six collector packages for a collector that did not change. The mirror is
 * deliberately minimal: request shape, response shape, and the route path.
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
 * The one option arm the server accepts free text on.
 *
 * MIRRORS `resolveAnswer()` in `intake-answers.ts`: text is committed to
 * `goalOther` only when the resolved fragment sets `goal: 'other'`, and is a
 * 400 everywhere else rather than a silent drop. The wire question carries no
 * per-option "free text allowed" flag, so this launcher cannot derive the rule
 * from the walk it is served — it mirrors the rule and stays tolerant, treating
 * a server refusal as a re-prompt rather than a failure.
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
  intake: IntakeWalkSchema,
});

export type IntakeOption = z.infer<typeof IntakeOptionSchema>;
export type IntakeQuestion = z.infer<typeof IntakeQuestionSchema>;
export type IntakeWalk = z.infer<typeof IntakeWalkSchema>;
export type IntakeAnswer = z.infer<typeof IntakeAnswerSchema>;
export type IntakeAnswersResponse = z.infer<typeof IntakeAnswersResponseSchema>;

/** Whether this question's options include the one arm that takes free text. */
export function questionAllowsFreeText(question: IntakeQuestion): boolean {
  return (
    question.field === INTAKE_FREE_TEXT_ARM.field &&
    question.options.some(
      (option) => option.value === INTAKE_FREE_TEXT_ARM.optionValue,
    )
  );
}
