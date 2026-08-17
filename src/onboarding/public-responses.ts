import { z } from "zod";

const shortText = z.string().max(10_000);
const longText = z.string().max(100_000);
const identifier = z.string().min(1).max(256);
const publicUrl = z.string().url().max(2_048);

const brandPreviewSchema = z
  .object({
    appName: shortText.nullable(),
    appDescription: longText.nullable(),
    tagline: shortText.nullable(),
    iconUrl: publicUrl.nullable(),
    screenshots: z.array(publicUrl).max(100),
    brandVoice: longText.nullable(),
    primaryLanguage: shortText.nullable(),
    targetGender: shortText.nullable().optional(),
    website: shortText.nullable().optional(),
    endCardUrl: publicUrl.nullable().optional(),
  })
  .strip();

const intakeOptionSchema = z
  .object({
    value: shortText,
    label: shortText,
  })
  .strip();

const intakeQuestionSchema = z
  .object({
    field: identifier,
    group: identifier,
    channel: identifier.optional(),
    mode: identifier.optional(),
    select: z.enum(["single", "multiple"]),
    title: shortText,
    subtitle: shortText.optional(),
    options: z.array(intakeOptionSchema).max(100),
  })
  .strip();

const intakeDockSchema = z
  .object({
    group: identifier,
    channel: identifier.optional(),
    mode: identifier.optional(),
    questions: z.array(intakeQuestionSchema).max(100),
  })
  .strip();

const gtmPhaseSchema = z
  .object({
    name: shortText,
    window: shortText,
    detail: longText,
  })
  .strip();

const gtmChannelMotionSchema = z
  .object({
    platform: shortText,
    motion: longText,
    cadence: shortText,
    expectedContribution: longText,
  })
  .strip();

const costPostureSchema = z
  .object({
    kind: z.enum(["free", "paid"]),
    usesPaid: z.boolean(),
    humanStepCount: z.number().int().min(0),
  })
  .strip();

const gtmPlanOptionSchema = z
  .object({
    proposedBy: shortText,
    strategyName: shortText,
    horizonDays: z.union([z.literal(14), z.literal(30)]),
    phases: z.array(gtmPhaseSchema).max(100),
    channels: z.array(gtmChannelMotionSchema).max(100),
    firstWeekActions: z.array(longText).max(100),
    risks: z.array(longText).max(100),
    costPosture: costPostureSchema.optional(),
  })
  .strip();

const gtmTopRecommendationSchema = gtmPlanOptionSchema
  .extend({
    isTop: z.literal(true),
    rationale: longText,
    backedBy: z.array(shortText).max(100),
  })
  .strip();

const gtmExecutionStepSchema = z
  .object({
    id: identifier.optional(),
    when: shortText,
    owner: shortText,
    actionKind: z.enum(["ateam", "tool", "skill", "human"]),
    ref: shortText,
    channels: z.array(identifier).max(20).optional(),
    description: longText,
    needsApproval: z.boolean(),
  })
  .strip();

const gtmVerdictSchema = z
  .object({
    version: z.literal(1),
    goal: z
      .object({
        statement: longText,
        metric: shortText,
        metricKey: identifier.optional(),
        target: z.number(),
        horizonDays: z.union([z.literal(14), z.literal(30)]),
      })
      .strip(),
    topRecommendation: gtmTopRecommendationSchema,
    alternatives: z.array(gtmPlanOptionSchema).max(20),
    dissent: z
      .array(
        z
          .object({
            topic: shortText,
            positions: z
              .array(
                z
                  .object({
                    deputies: z.array(shortText).max(100),
                    position: longText,
                  })
                  .strip(),
              )
              .max(100),
          })
          .strip(),
      )
      .max(100),
    council: z
      .object({
        deputies: z
          .array(
            z
              .object({
                key: identifier,
                model: shortText,
                ok: z.boolean(),
              })
              .strip(),
          )
          .max(100),
        quorumMet: z.boolean(),
      })
      .strip(),
    narration: longText,
    unrepresentableChannels: z.array(shortText).max(100).optional(),
    groundingDisclosure: longText.optional(),
    executionSteps: z.array(gtmExecutionStepSchema).max(500).optional(),
    protocol: shortText.optional(),
    compiler: shortText.optional(),
    spendPosture: z
      .object({
        posture: z.enum(["free", "test", "scale"]),
        monthlyBudget: z.number().positive().nullable(),
      })
      .strip()
      .optional(),
    source: z.enum(["gtm-council", "onboarding-starter"]).optional(),
  })
  .strip();

const onboardingStatusSchema = z
  .object({
    buildState: z.enum([
      "reserved",
      "minting",
      "dispatching",
      "building",
      "preview_ready",
      "failed",
      "expired",
    ]),
    planState: z.enum(["none", "collecting", "generating", "ready", "failed"]),
    claimState: z.enum([
      "unclaimed",
      "otp_pending",
      "identity_verified",
      "claimed",
      "failed",
    ]),
    postclaimState: z.enum(["n/a", "pending", "dispatched", "running", "complete", "failed"]),
    projectId: identifier.optional(),
    brandPreview: brandPreviewSchema.optional(),
    previewUrl: publicUrl,
    claimUrl: publicUrl,
    workspaceUrl: publicUrl.optional(),
    connectAccountsUrl: publicUrl.optional(),
    claimed: z.boolean(),
    continuity: z.enum(["browser", "same_account"]),
    plan: z
      .object({
        state: z.enum(["none", "collecting", "generating", "ready", "failed"]),
        teaser: longText.optional(),
        content: gtmVerdictSchema.optional(),
      })
      .strip(),
    intake: z
      .object({
        docks: z.array(intakeDockSchema).max(100),
        remaining: z.array(intakeQuestionSchema).max(500),
      })
      .strip()
      .optional(),
  })
  .strip();

const claimBeginSchema = z
  .object({
    status: identifier,
  })
  .strip();

const postclaimAssetsSchema = z
  .object({
    generationStatus: z.enum(["not_started", "generating", "complete", "failed", "unknown"]),
    postclaimState: z
      .enum(["n/a", "pending", "dispatched", "running", "complete", "failed"])
      .nullable(),
    estimatedDuration: z.literal("these may take a few minutes"),
    message: z.string().min(1).max(500),
  })
  .strip();

const claimVerifyPublicSchema = z
  .object({
    status: identifier,
    continuity: z.enum(["browser", "same_account"]),
    /**
     * Optional, because a claim that succeeded is not invalid just because the
     * post-claim asset projection is not ready to describe.
     *
     * Requiring it turned "the assets have not started generating yet" into
     * "Onboarding claim verify returned an invalid public response" — a hard
     * failure reported to a person whose workspace had, in fact, just been
     * claimed. The caller already treats these fields as advisory.
     */
    postclaimAssets: postclaimAssetsSchema.optional(),
  })
  .strip();

function parsePublicResponse<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${context} returned an invalid public response`);
  }
  return parsed.data;
}

export const sanitizeOnboardingStatus = (value: unknown): unknown =>
  parsePublicResponse(onboardingStatusSchema, value, "Onboarding status");

export const sanitizeClaimBegin = (value: unknown): unknown =>
  parsePublicResponse(claimBeginSchema, value, "Onboarding claim begin");

export const sanitizeClaimVerify = (value: unknown): unknown =>
  parsePublicResponse(claimVerifyPublicSchema, value, "Onboarding claim verify");
