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
  protocolVersion: z.number().optional(),
  trialHandle: z.string(),
  state: z.string(),
  stageLabel: z.string().optional(),
  completedMilestones: z.array(z.string()).optional(),
  outstandingCorrections: z.array(z.unknown()).optional(),
  publicSurfaceState: z.string().optional(),
  publicSurfaceCandidates: z.array(z.unknown()).optional(),
  publicPagesConfirmation: z.unknown().optional(),
  updatedAt: z.string().optional(),
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

/**
 * What a `progress` event is allowed to say.
 *
 * TOLERANT TO READ IS NOT TOLERANT TO ECHO. The loose parse above exists so a
 * field added server-side cannot fail a poll mid-claim. Spreading that parsed
 * value into the emitted event turned the same tolerance into a relay: every
 * unknown key the server ever adds would land, unreviewed, in an LLM transcript
 * the operator of this process never sees coming. Those are different
 * decisions and they now have different code.
 *
 * The allowlist is the fields this launcher has actually reasoned about. A new
 * server field reaches an agent only once somebody adds it here on purpose.
 *
 * `groundedPlayback` ELEMENTS are the deliberate exception: the agent reads
 * `layers_sdk_presence` and `layers_sdk_platform` out of them, and a fact shape
 * this build has not seen is exactly the thing that must survive. The array is
 * relayed whole; the risk is bounded because the server authors these facts for
 * the agent to read.
 */
export interface EmittedProgress {
  readonly trialHandle: string;
  readonly state: string;
  readonly previewReady: boolean;
  readonly previewUrl: string | null;
  readonly claimReady: boolean;
  readonly claimUrl: string | null;
  readonly failure: unknown;
  readonly [key: string]: unknown;
}

export function emittedProgress(
  projection: ProgressProjection,
  overrides: { claimReady: boolean; claimUrl: string | null },
): EmittedProgress {
  const emitted: Record<string, unknown> = {
    trialHandle: projection.trialHandle,
    state: projection.state,
    previewReady: projection.previewReady,
    previewUrl: projection.previewUrl ?? null,
    claimReady: overrides.claimReady,
    claimUrl: overrides.claimUrl,
    failure: projection.failure ?? null,
  };
  const optional: ReadonlyArray<keyof ProgressProjection> = [
    "protocolVersion",
    "stageLabel",
    "completedMilestones",
    "outstandingCorrections",
    "publicSurfaceState",
    "publicSurfaceCandidates",
    "publicPagesConfirmation",
    "groundedPlayback",
    "updatedAt",
  ];
  for (const key of optional) {
    const value = projection[key];
    if (value !== undefined) emitted[key] = value;
  }
  return emitted as unknown as EmittedProgress;
}
