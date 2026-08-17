/**
 * The progress projection, mirrored locally at the width this launcher acts on.
 *
 * SOURCE OF TRUTH: `OnboardAgentProgressResponseSchema` in
 * `@layers/onboarding-contracts` (`public-launcher.ts`), served by
 * `apps/api/src/routes/onboard/agent/progress.ts`.
 *
 * WHY A MIRROR, when the canonical schema is already a dependency. The
 * canonical one is `.strict()` and enumerates `state`. Both are correct for the
 * server, which owns the projection, and both are a liability for a launcher
 * that is ALREADY INSTALLED on somebody's machine and is polling this route
 * every five seconds through a claim wait that now runs for hours. A field
 * added server-side, or a state added server-side, would fail the read on every
 * poll — and the failure lands after consent, after upload, while a person is
 * mid-claim. The same reasoning already governs `intake-contract.ts`.
 *
 * SO: validate exactly what this process branches on, and let everything else
 * through untouched. `z.looseObject` keeps unknown keys on the parsed value, so
 * the event this launcher emits still carries whatever the server sent —
 * including grounded facts this version has never heard of.
 */
import { z } from "zod";

/**
 * `state` is a plain string ON PURPOSE.
 *
 * The launcher compares it against the states it knows how to end on. A state
 * it does not know is not a state it should end on, so the tolerant reading —
 * keep polling — is also the correct one. Enumerating it here would convert
 * "the server learned a new word" into "every installed launcher stops".
 */
export const ProgressFailureSchema = z.object({
  retryable: z.boolean().optional(),
  supportCode: z.string(),
  retryOperation: z.string().optional(),
});

export const ProgressProjectionSchema = z.looseObject({
  trialHandle: z.string(),
  state: z.string(),
  previewReady: z.boolean(),
  previewUrl: z.string().nullish(),
  claimReady: z.boolean(),
  claimUrl: z.string().nullish(),
  /**
   * Null when nothing failed, and absent on a server that has not sent it yet.
   * `.nullish()` rather than required, so a terminal print falls back to "the
   * server reported no reason" instead of failing the read that would have
   * carried it.
   */
  failure: ProgressFailureSchema.nullish(),
  /**
   * Relayed, never interpreted here. The agent reads `layers_sdk_presence` and
   * `layers_sdk_platform` out of it, so the ELEMENTS must stay untouched — a
   * fact shape this version does not know is exactly the thing that must
   * survive the trip.
   */
  groundedPlayback: z.array(z.unknown()).optional(),
});

export type ProgressProjection = z.infer<typeof ProgressProjectionSchema>;
