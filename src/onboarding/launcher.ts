import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  ONBOARDING_CONSENT_RETENTION_COPY,
  approveOnboardingCodebaseConsent,
  prepareOnboardingCodebaseConsentDraft,
  type OnboardingCodebaseConsentDraft,
  type OnboardAgentPostclaimResponse,
  type OnboardingSourceInspection,
} from "@layers/onboarding-contracts";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_PROTOCOL_VERSION,
  AGENT_INSTRUCTION_COMMANDS,
} from "./agent-instructions.js";
import {
  OnboardingCollectorHostError,
  openOnboardingCollector,
  type OnboardingCollectorSession,
  type OnboardingCollectorTermination,
} from "./collector-host.js";
import {
  SourceOnboardingError,
  consumeInternalProbeToken,
  createSourceClaimSession,
  preflightSourceOnboarding,
  readSourceProgress,
  type SourceClaimSession,
  uploadSourceEvidence,
} from "./source-api.js";
import {
  ConsentSurface,
  createIntakeWalkRunner,
  type IntakeEvent,
  type IntakeSummary,
  type IntakeWalkGate,
} from "./intake-walk.js";
import { getReservation } from "./session.js";
import { startOnboarding } from "./tools.js";

const PROGRESS_POLL_MS = 5_000;

/**
 * How long this process keeps waiting for a person to click the claim link.
 *
 * WAS 15 MINUTES, WHICH WAS THE WRONG NUMBER COPIED FROM THE WRONG THING. The
 * server caps each claim TRANSPORT ATTEMPT at 15 minutes
 * (`onboard_claim_transport_attempts` enforces `expires_at <= created_at +
 * interval '15 minutes'`), and 1.3.0 clamped its whole wait down to that. So a
 * launcher that minted a link at 16:53 exited at 17:07 reporting
 * `awaiting_claim` — not because anything expired that mattered, but because
 * the transport leg it happened to be holding did, while the trial itself stayed
 * claimable for the rest of the reservation. The human had simply not clicked
 * yet.
 *
 * The attempt is now re-armed instead of ending the wait, so this bound is what
 * it always should have been: how long a person might reasonably take. It is
 * still intersected with the reservation, which is the real outer limit.
 */
const CLAIM_WAIT_MS = 24 * 60 * 60_000;

/**
 * How often the wait says out loud that it is still waiting.
 *
 * A silent process is indistinguishable from a hung one, and the agent driving
 * it has been told not to restart on unchanged output. This gives it something
 * true to report on every poll it makes.
 */
const CLAIM_HEARTBEAT_MS = 5 * 60_000;
const TEMPORARY_WORKSPACE_TERMS =
  "Layers creates an isolated, trial-scoped workspace only to analyze the approved evidence, build the preview, and let you claim or resume it. Depending on the branch, it may include an upload grant and fenced upload-intent generation/lease, evidence and public-validation records, analysis and preview jobs, an anonymous Supabase Auth user, organization, and membership, and—only for a normal new-product preview—a temporary project, SDK record, entitlement, organization/onboarding credits, media, and preview assets. For a public GitHub URL, the same-session bootstrap may inspect policy-eligible files from the pinned revision in a bounded, memory-only local workspace to prepare the receipt; no fetched Git blob, full file, or unapproved repository content is sent to Layers, and only the approved bounded facts and excerpts may be sent after consent. Existing-App-ID previews create no duplicate project before authorization. The browser may also create or sign into your normal Layers account; that account remains yours even if this product claim is denied, and you can delete it through the normal account-deletion flow. Nothing is exposed to another account before an authorized claim.";
const BASE_PROCESSORS = [
  "google_cloud",
  "layers_api",
  "supabase",
  "vertex_ai",
] as const;

/**
 * The launcher's own stdout vocabulary.
 *
 * LOCAL BY DESIGN. `agent_instructions` is emitted by this process and never
 * sent by the server, so it belongs to this union rather than to
 * `@layers/onboarding-contracts`; the pinned contract version is unchanged by
 * its addition.
 */
type LauncherEvent =
  | {
      type: "agent_instructions";
      protocolVersion: typeof AGENT_INSTRUCTIONS_PROTOCOL_VERSION;
      instructions: string;
      commands: typeof AGENT_INSTRUCTION_COMMANDS;
    }
  | { type: "status"; stage: string; message: string }
  | { type: "inspection"; inspection: OnboardingSourceInspection }
  | {
      type: "input_required";
      operation:
        | "select_product"
        | "review_scope"
        | "approve_consent"
        | "resume_inspection";
      commands: string[];
    }
  | IntakeEvent
  | {
      type: "consent_proposal";
      displayEventId: string;
      displayedAt: string;
      canonicalProjection: string;
      canonicalProjectionSha256: string;
    }
  | {
      type: "progress";
      progress: Awaited<ReturnType<typeof readSourceProgress>>;
    }
  | {
      type: "complete";
      previewUrl: string;
      state: "claimed";
      postclaim: OnboardAgentPostclaimResponse;
      intake: IntakeSummary | null;
    }
  | {
      type: "complete";
      previewUrl: string;
      state: "awaiting_claim";
      postclaim: null;
      intake: IntakeSummary | null;
    }
  | {
      type: "error";
      stage: "review_scope" | "approve_consent";
      code: string;
      retryable: boolean;
      evidenceSubmitted: false;
      message: string;
    };

function emit(event: LauncherEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * What a terminal server-side failure says out loud.
 *
 * A launcher that ends on `Layers onboarding failed` tells a person nothing they
 * can act on and tells support nothing they can look up. The three facts that
 * are always available are the trial handle (already public on every progress
 * event), the last state this process actually read, and the server's own
 * failure code when the projection carries one.
 *
 * `failure` is `{ retryable, supportCode, retryOperation } | null` on the
 * canonical progress projection, so an absent reason is a real, expected case
 * rather than a bug — and it is reported as an absence rather than papered over
 * with a guess.
 */
function terminalProgressMessage(
  progress: Awaited<ReturnType<typeof readSourceProgress>>,
  summary: string,
): string {
  const reason = progress.failure
    ? `Server failure code: ${progress.failure.supportCode}.`
    : "Server reported no reason.";
  return [
    summary,
    `Trial handle: ${progress.trialHandle}.`,
    `Last progress state: ${progress.state}.`,
    reason,
  ].join(" ");
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Onboarding interrupted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Onboarding interrupted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

class InputLines {
  readonly #reader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  #closed = false;
  #epoch = 0;
  #sequence = 0;
  #lastConsumedSequence = 0;
  #waiter:
    | {
        epoch: number;
        deadlineAtMs: number;
        resolve: (value: string | null) => void;
        reject: (error: Error) => void;
        timeout?: NodeJS.Timeout;
      }
    | undefined;

  constructor() {
    this.#reader.on("line", (value) => {
      const line = {
        value,
        receivedAtMs: Date.now(),
        sequence: ++this.#sequence,
      };
      const waiter = this.#waiter;
      if (!waiter || waiter.epoch !== this.#epoch) {
        // Input is valid only as a reply to the currently advertised prompt.
        // Buffering an unsolicited line could replay a stale prepare or approve
        // command into a later collector generation.
        return;
      }
      // Receipt time and use time are both fenced. After host suspend, a line
      // buffered by the terminal cannot revive an expired collector generation.
      if (
        line.receivedAtMs >= waiter.deadlineAtMs ||
        Date.now() >= waiter.deadlineAtMs
      ) {
        return;
      }
      if (line.sequence <= this.#lastConsumedSequence) return;
      this.#lastConsumedSequence = line.sequence;
      this.#settle(waiter.epoch, line.value.trim());
    });
    this.#reader.once("close", () => {
      this.#closed = true;
      const waiter = this.#waiter;
      if (!waiter) return;
      this.#waiter = undefined;
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.reject(new Error("Onboarding input closed before approval"));
    });
  }

  async nextForCollector(
    session: OnboardingCollectorSession,
  ): Promise<string> {
    const epoch = this.#arm(session.deadlineAtMs);
    session.waitForTermination().then((termination) => {
      const waiter = this.#waiter;
      if (!waiter || waiter.epoch !== epoch) return;
      this.#waiter = undefined;
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.reject(new CollectorGenerationEnded(termination));
    });
    const value = await this.#wait(epoch);
    if (value === null) throw new Error("Onboarding input expired");
    return value;
  }

  async nextBefore(deadlineAtMs: number): Promise<string | null> {
    if (deadlineAtMs <= Date.now()) return null;
    const epoch = this.#arm(deadlineAtMs, true);
    return await this.#wait(epoch);
  }

  #arm(deadlineAtMs: number, resolveOnDeadline = false): number {
    if (this.#closed) throw new Error("Onboarding input closed before approval");
    if (this.#waiter) {
      throw new Error("Onboarding input already has an active prompt");
    }
    const epoch = ++this.#epoch;
    let resolveWaiter: ((value: string | null) => void) | undefined;
    let rejectWaiter: ((error: Error) => void) | undefined;
    const promise = new Promise<string | null>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const waiter = {
      epoch,
      deadlineAtMs,
      resolve: (value: string | null) => resolveWaiter?.(value),
      reject: (error: Error) => rejectWaiter?.(error),
      ...(resolveOnDeadline
        ? {
            timeout: setTimeout(
              () => this.#settle(epoch, null),
              Math.max(0, deadlineAtMs - Date.now()),
            ),
          }
        : {}),
    };
    waiter.timeout?.unref?.();
    this.#waiter = waiter;
    this.#promptPromises.set(epoch, promise);
    return epoch;
  }

  readonly #promptPromises = new Map<number, Promise<string | null>>();

  async #wait(epoch: number): Promise<string | null> {
    const promise = this.#promptPromises.get(epoch);
    if (!promise) throw new Error("Onboarding input prompt is unavailable");
    try {
      return await promise;
    } finally {
      this.#promptPromises.delete(epoch);
    }
  }

  #settle(epoch: number, value: string | null): void {
    const waiter = this.#waiter;
    if (!waiter || waiter.epoch !== epoch) return;
    this.#waiter = undefined;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    waiter.resolve(value);
  }

  close(): void {
    this.#reader.close();
  }
}

class CollectorGenerationEnded extends Error {
  readonly termination: OnboardingCollectorTermination;
  readonly stage: "review_scope" | "approve_consent";

  constructor(
    termination: OnboardingCollectorTermination,
    stage: "review_scope" | "approve_consent" = "review_scope",
  ) {
    super(termination.error.message);
    this.name = "CollectorGenerationEnded";
    this.termination = termination;
    this.stage = stage;
  }
}

class SourceReviewTerminalError extends Error {
  readonly event: Extract<LauncherEvent, { type: "error" }>;

  constructor(event: Extract<LauncherEvent, { type: "error" }>) {
    super(event.message);
    this.name = "SourceReviewTerminalError";
    this.event = event;
  }
}

class CollectorReviewOperationError extends Error {
  readonly cause: OnboardingCollectorHostError;
  readonly stage: "review_scope" | "approve_consent";

  constructor(
    cause: OnboardingCollectorHostError,
    stage: "review_scope" | "approve_consent",
  ) {
    super(cause.message);
    this.name = "CollectorReviewOperationError";
    this.cause = cause;
    this.stage = stage;
  }
}

function terminalReviewError(
  stage: "review_scope" | "approve_consent",
  error: unknown,
): SourceReviewTerminalError {
  const hostError =
    error instanceof CollectorReviewOperationError
      ? error.cause
      : error instanceof OnboardingCollectorHostError
        ? error
        : undefined;
  return new SourceReviewTerminalError({
    type: "error",
    stage,
    code: hostError?.supportCode ?? "ONBOARD_COLLECTOR_FAILED",
    retryable: hostError?.supportCode === "ONBOARD_COLLECTOR_TIMEOUT",
    evidenceSubmitted: false,
    message: "Local source review could not continue; no evidence was sent.",
  });
}

function reservationExpiredError(
  stage: "review_scope" | "approve_consent",
): SourceReviewTerminalError {
  return new SourceReviewTerminalError({
    type: "error",
    stage,
    code: "ONBOARD_RESERVATION_EXPIRED",
    retryable: false,
    evidenceSubmitted: false,
    message: "The source reservation expired; no evidence was sent.",
  });
}

function unsupportedWorkspaceError(
  stage: "review_scope" | "approve_consent" = "review_scope",
): SourceReviewTerminalError {
  return new SourceReviewTerminalError({
    type: "error",
    stage,
    code: "ONBOARD_COLLECTOR_UNSUPPORTED",
    retryable: false,
    evidenceSubmitted: false,
    message:
      "This folder does not contain a supported product workspace; no evidence was sent.",
  });
}

function collectorCleanupFailedError(
  stage: "review_scope" | "approve_consent",
): SourceReviewTerminalError {
  return terminalReviewError(
    stage,
    new OnboardingCollectorHostError(
      "ONBOARD_COLLECTOR_FAILED",
      "The local onboarding collector could not prove cleanup.",
    ),
  );
}

async function nextCollectorCommand(
  lines: InputLines,
  session: OnboardingCollectorSession,
  stage: "review_scope" | "approve_consent",
): Promise<string> {
  try {
    return await lines.nextForCollector(session);
  } catch (error) {
    if (error instanceof CollectorGenerationEnded) {
      throw new CollectorGenerationEnded(error.termination, stage);
    }
    throw error;
  }
}

interface ScopeState {
  excludedPathIds: Set<string>;
  excludedTargetIds: Set<string>;
  selectedTargetIds: Set<string>;
}

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}

async function applyScopeCommand(
  session: OnboardingCollectorSession,
  scope: ScopeState,
  inspection: OnboardingSourceInspection,
  command: string,
  stage: "review_scope" | "approve_consent",
): Promise<OnboardingSourceInspection | null> {
  const [operation, identifier, ...extra] = command.split(/\s+/u);
  if (!identifier || extra.length > 0) return null;

  if (operation === "exclude-path") {
    if (!inspection.consentPathItems.some((item) => item.pathId === identifier))
      return null;
    scope.excludedPathIds.add(identifier);
  } else if (operation === "exclude-target") {
    if (
      !inspection.publicTargets.some(
        (target) => target.candidateId === identifier,
      ) &&
      !scope.excludedTargetIds.has(identifier)
    ) {
      return null;
    }
    scope.excludedTargetIds.add(identifier);
    scope.selectedTargetIds.delete(identifier);
  } else if (operation === "include-target") {
    if (
      !inspection.publicTargets.some(
        (target) => target.candidateId === identifier,
      ) &&
      !scope.excludedTargetIds.has(identifier)
    ) {
      return null;
    }
    scope.selectedTargetIds.add(identifier);
    scope.excludedTargetIds.delete(identifier);
  } else return null;

  let response: Awaited<ReturnType<OnboardingCollectorSession["reinspect"]>>;
  try {
    response = await session.reinspect({
      excludedPathIds: sorted(scope.excludedPathIds),
      excludedTargetIds: sorted(scope.excludedTargetIds),
      selectedTargetIds: sorted(scope.selectedTargetIds),
    });
  } catch (error) {
    if (error instanceof OnboardingCollectorHostError) {
      throw new CollectorReviewOperationError(error, stage);
    }
    throw error;
  }
  return response.projection;
}

async function resolveInspection(
  session: OnboardingCollectorSession,
  lines: InputLines,
  initial: OnboardingSourceInspection,
  stage: "review_scope" | "approve_consent" = "review_scope",
): Promise<OnboardingSourceInspection> {
  let inspection = initial;
  while (true) {
    emit({ type: "inspection", inspection });
    if (inspection.status === "needs_url") {
      throw unsupportedWorkspaceError(stage);
    }
    if (inspection.status === "needs_product_selection") {
      emit({
        type: "input_required",
        operation: "select_product",
        commands: ["select <candidateId>", "cancel"],
      });
      const command = await nextCollectorCommand(
        lines,
        session,
        stage,
      );
      if (command === "cancel") throw new Error("Onboarding canceled");
      const match = /^select\s+(\S+)$/u.exec(command);
      if (!match) continue;
      try {
        inspection = (await session.select(match[1]!)).projection;
      } catch (error) {
        if (error instanceof OnboardingCollectorHostError) {
          throw new CollectorReviewOperationError(error, stage);
        }
        throw error;
      }
      continue;
    }
    return inspection;
  }
}

async function collectApproval(
  session: OnboardingCollectorSession,
  lines: InputLines,
  initialInspection: OnboardingSourceInspection,
  consentSurface: ConsentSurface,
): Promise<unknown> {
  let inspection = await resolveInspection(session, lines, initialInspection);
  const scope: ScopeState = {
    excludedPathIds: new Set(
      inspection.consentPathItems
        .filter((item) => !item.included)
        .map((item) => item.pathId),
    ),
    excludedTargetIds: new Set(),
    selectedTargetIds: new Set(
      inspection.publicTargets
        .filter((target) => target.disposition === "user_selected")
        .map((target) => target.candidateId),
    ),
  };
  let draft: OnboardingCodebaseConsentDraft | undefined;
  let displayEventId: string | undefined;
  let displayedAt: string | undefined;

  while (true) {
    if (!draft) {
      emit({
        type: "input_required",
        operation: "review_scope",
        commands: [
          "prepare",
          "exclude-path <pathId>",
          "exclude-target <candidateId>",
          "include-target <candidateId>",
          "cancel",
        ],
      });
      const command = await nextCollectorCommand(
        lines,
        session,
        "review_scope",
      );
      if (command === "cancel") throw new Error("Onboarding canceled");
      const nextInspection = await applyScopeCommand(
        session,
        scope,
        inspection,
        command,
        "review_scope",
      );
      if (nextInspection) {
        inspection = await resolveInspection(session, lines, nextInspection);
        continue;
      }
      if (command !== "prepare") continue;

      let prepared: Awaited<ReturnType<OnboardingCollectorSession["prepare"]>>;
      try {
        prepared = await session.prepare();
      } catch (error) {
        if (error instanceof OnboardingCollectorHostError) {
          throw new CollectorReviewOperationError(error, "review_scope");
        }
        throw error;
      }
      draft = prepareOnboardingCodebaseConsentDraft({
        prepared,
        receiptId: randomUUID(),
        createdAt: new Date().toISOString(),
        // Body-derived public targets require their own later incremental
        // proposal. The source receipt names only processors that receive the
        // approved source envelope itself.
        processorCategoriesAndPublicServices: [...BASE_PROCESSORS],
        temporaryWorkspaceTerms: TEMPORARY_WORKSPACE_TERMS,
        retentionAndDeletionTerms: ONBOARDING_CONSENT_RETENTION_COPY,
        sha256,
      });
      displayEventId = randomUUID();
      displayedAt = new Date().toISOString();
      // The proposal is on screen from here until it is approved or discarded.
      // Nothing else may prompt in that window.
      consentSurface.display();
      emit({
        type: "consent_proposal",
        displayEventId,
        displayedAt,
        canonicalProjection: draft.canonicalProjection,
        canonicalProjectionSha256: draft.canonicalProjectionSha256,
      });
    }

    emit({
      type: "input_required",
      operation: "approve_consent",
      commands: [
        `approve ${displayEventId} ${draft.canonicalProjectionSha256}`,
        "exclude-path <pathId>",
        "exclude-target <candidateId>",
        "include-target <candidateId>",
        "cancel",
      ],
    });
    const command = await nextCollectorCommand(
      lines,
      session,
      "approve_consent",
    );
    if (command === "cancel") throw new Error("Onboarding canceled");
    if (
      command === `approve ${displayEventId} ${draft.canonicalProjectionSha256}`
    ) {
      consentSurface.clear();
      return approveOnboardingCodebaseConsent({
        draft,
        displayEventId: displayEventId!,
        displayedAt: displayedAt!,
        displaySequence: 1,
        approvalRecordId: randomUUID(),
        approvingInteractionId: randomUUID(),
        approvedAt: new Date().toISOString(),
        approvalSequence: 2,
        displaySurface: "terminal",
        sha256,
      });
    }

    // Make the prior approval surface and its excerpt-bearing draft
    // unreachable before asking the collector to mutate scope.
    consentSurface.clear();
    draft = undefined;
    displayEventId = undefined;
    displayedAt = undefined;
    const nextInspection = await applyScopeCommand(
      session,
      scope,
      inspection,
      command,
      "approve_consent",
    );
    if (!nextInspection) continue;
    inspection = await resolveInspection(
      session,
      lines,
      nextInspection,
      "approve_consent",
    );
  }
}

/**
 * Wait for the preview, then hand off the attempt-bound browser claim.
 *
 * THE CLAIM LINK NOW WAITS FOR TWO THINGS: the preview being ready, and intake
 * being settled. Whichever arrives second releases it. Handing over the claim
 * link while questions are still outstanding is what the browser door does not
 * do, and it ends the conversation — a person who has claimed their workspace
 * has left, and the questions that shape their first plan go unanswered.
 *
 * `intakeGate` is optional so the exported function keeps working for callers
 * that run no walk at all; a missing gate is an open gate.
 */
export async function waitForPreviewAndClaim(
  baseUrl: string,
  signal: AbortSignal,
  reservationExpiresAt: string,
  emitEvent: (event: LauncherEvent) => void = emit,
  intakeGate?: IntakeWalkGate,
): Promise<void> {
  const reservationDeadline = Date.parse(reservationExpiresAt);
  if (!Number.isFinite(reservationDeadline)) {
    throw new Error("Layers returned an invalid reservation expiry");
  }
  let previous = "";
  /**
   * How long this process is willing to wait, total. Set once, when the claim
   * handoff actually begins, and never shortened by a transport leg.
   */
  let waitDeadline: number | undefined;
  /**
   * When the CURRENT transport attempt dies. Shorter than `waitDeadline` by
   * design; reaching it retires the attempt rather than the wait.
   */
  let attemptDeadline: number | undefined;
  let latestPreviewUrl: string | undefined;
  let claimSession: SourceClaimSession | undefined;
  let claimLinksMinted = 0;
  let lastHeartbeatAtMs = 0;
  /**
   * Set when re-arming cannot help, so the wait ends on the next check.
   *
   * The one case is an attempt that arrives ALREADY expired: minting another
   * would produce another dead link, and a loop that mints dead links is worse
   * than stopping. A healthy attempt reaching its expiry is not this case.
   */
  let cannotRearm = false;
  const intakeSummary = (): IntakeSummary | null =>
    intakeGate ? intakeGate.summary() : null;
  const attemptExpired = (): boolean =>
    attemptDeadline !== undefined && Date.now() >= attemptDeadline;
  const finishAwaitingClaimIfExpired = (): boolean => {
    const exhausted = waitDeadline !== undefined && Date.now() >= waitDeadline;
    if (!exhausted && !cannotRearm) return false;
    if (!latestPreviewUrl) {
      throw new Error("Claim handoff is missing its preview URL");
    }
    // STOPPING IS NOT THE SAME AS EXPIRING, and the difference is the whole
    // reason a person walks away thinking they lost their workspace. Say which
    // one this is before the terminal event, in terms the agent can relay.
    emitEvent({
      type: "status",
      stage: "claim_still_open",
      message:
        `This process stopped waiting for the browser claim, but the Layers workspace is still built and still claimable until ${reservationExpiresAt}. ` +
        "The claim link last printed here is bound to a browser attempt that expires 15 minutes after it was printed, so if the human has not opened it by now it needs to be minted again. " +
        "Tell them the workspace was not lost and nothing was cancelled.",
    });
    emitEvent({
      type: "complete",
      previewUrl: latestPreviewUrl,
      state: "awaiting_claim",
      postclaim: null,
      intake: intakeSummary(),
    });
    return true;
  };
  const boundedRetryDelay = (requestedMs: number): number =>
    waitDeadline === undefined
      ? requestedMs
      : Math.max(1, Math.min(requestedMs, waitDeadline - Date.now()));
  try {
    while (true) {
      if (signal.aborted) throw new Error("Onboarding interrupted");
      if (finishAwaitingClaimIfExpired()) return;
      let progress: Awaited<ReturnType<typeof readSourceProgress>>;
      try {
        progress = await readSourceProgress(baseUrl, signal);
      } catch (error) {
        if (error instanceof SourceOnboardingError && error.retryable) {
          const delayMs = Math.min(
            10_000,
            Math.max(
              PROGRESS_POLL_MS,
              (error.retryAfterSeconds ?? 0) * 1000,
            ),
          );
          await delay(boundedRetryDelay(delayMs), signal);
          if (finishAwaitingClaimIfExpired()) return;
          continue;
        }
        throw error;
      }
      if (signal.aborted) throw new Error("Onboarding interrupted");

      if (progress.state === "failed" || progress.state === "expired") {
        throw new Error(
          terminalProgressMessage(
            progress,
            `Layers onboarding ${progress.state}.`,
          ),
        );
      }
      if (progress.state === "needs_clarification") {
        throw new Error(
          terminalProgressMessage(
            progress,
            "Layers onboarding needs clarification before this session can continue.",
          ),
        );
      }
      if (progress.previewUrl) latestPreviewUrl = progress.previewUrl;

      // RETIRE AN EXPIRED TRANSPORT ATTEMPT, KEEP THE WAIT. The exchange below
      // already had the last word on this attempt in the previous iteration, so
      // reaching here with it expired means nobody clicked in time. The server
      // lazily expires the stale attempt when the next one is created, so a
      // fresh mint is all this takes.
      if (claimSession && attemptExpired() && progress.state !== "claimed") {
        claimSession.dispose();
        claimSession = undefined;
        attemptDeadline = undefined;
      }

      // BOTH conditions, or no claim attempt exists to surface. The attempt is
      // what mints the browser URL, so gating its creation is what gates the
      // link — the progress projection below can only publish a URL that a
      // live attempt already produced.
      if (
        !claimSession &&
        progress.claimReady &&
        progress.previewReady &&
        progress.previewUrl &&
        (intakeGate === undefined || intakeGate.isSettled())
      ) {
        waitDeadline ??= Math.min(
          Date.now() + CLAIM_WAIT_MS,
          reservationDeadline,
        );
        if (Date.now() >= waitDeadline) {
          throw new SourceOnboardingError(
            "Layers claim continuity setup expired",
          );
        }
        claimSession = await createSourceClaimSession(
          baseUrl,
          signal,
          async (error) => {
            if (waitDeadline === undefined || Date.now() >= waitDeadline) {
              return false;
            }
            const delayMs = Math.min(
              10_000,
              Math.max(
                PROGRESS_POLL_MS,
                (error.retryAfterSeconds ?? 0) * 1000,
              ),
            );
            await delay(boundedRetryDelay(delayMs), signal);
            return Date.now() < waitDeadline;
          },
        );
        const attemptExpiresAt = Date.parse(claimSession.expiresAt);
        if (!Number.isFinite(attemptExpiresAt)) {
          throw new Error("Layers returned an invalid claim-attempt expiry");
        }
        attemptDeadline = attemptExpiresAt;
        claimLinksMinted += 1;
        // BORN DEAD. Nobody can open this link, and minting another would only
        // produce one more of the same. Publish it (the URL is still what the
        // projection carries) and let the wait end rather than spin.
        if (attemptExpiresAt <= Date.now()) cannotRearm = true;
        // A REPLACED LINK MUST BE ANNOUNCED. The URL changes, so the agent's
        // previously relayed link is now dead and re-sharing is not optional.
        if (claimLinksMinted > 1) {
          emitEvent({
            type: "status",
            stage: "claim_link_refreshed",
            message:
              "The previous browser claim link expired before it was opened. A fresh claim link rides on the next progress event; give the human that one and discard the earlier link.",
          });
        }
      }

      if (progress.state === "claimed" && !claimSession) {
        throw new Error(
          "Layers workspace was claimed outside this same-session handoff",
        );
      }

      // The progress projection contains the portable legacy claim URL. The
      // same-session command exposes only the attempt-bound URL created with
      // this process's private PKCE transport capability.
      const safeClaimUrl =
        progress.claimReady && claimSession ? claimSession.claimUrl : null;
      const safeProgress = {
        ...progress,
        claimReady: safeClaimUrl !== null,
        claimUrl: safeClaimUrl,
      };
      const fingerprint = JSON.stringify(safeProgress);
      if (fingerprint !== previous) {
        emitEvent({ type: "progress", progress: safeProgress });
        previous = fingerprint;
      }
      // Once a private claim attempt exists, publish its safe browser URL
      // before any deadline path can dispose the process-only session.
      if (
        progress.state !== "claimed" &&
        finishAwaitingClaimIfExpired()
      ) {
        return;
      }

      if (claimSession) {
        let exchange: Awaited<ReturnType<SourceClaimSession["exchange"]>>;
        try {
          exchange = await claimSession.exchange(signal);
        } catch (error) {
          if (error instanceof SourceOnboardingError && error.retryable) {
            const delayMs = Math.min(
              10_000,
              Math.max(
                PROGRESS_POLL_MS,
                (error.retryAfterSeconds ?? 0) * 1000,
              ),
            );
            if (finishAwaitingClaimIfExpired()) return;
            await delay(boundedRetryDelay(delayMs), signal);
            if (finishAwaitingClaimIfExpired()) return;
            continue;
          }
          throw error;
        }

        if (exchange.state === "claimed") {
          if (!latestPreviewUrl) {
            throw new Error("Claimed workspace is missing its preview URL");
          }
          emitEvent({
            type: "complete",
            previewUrl: latestPreviewUrl,
            state: "claimed",
            postclaim: exchange.postclaim,
            intake: intakeSummary(),
          });
          return;
        }

        const exchangeExpiresAt = Date.parse(exchange.expiresAt);
        if (!Number.isFinite(exchangeExpiresAt)) {
          throw new Error("Layers returned an invalid claim-exchange expiry");
        }
        // The exchange's view of THIS attempt's expiry, which is the transport
        // leg — never the wait. Clamping the wait to it is the 1.3.0 bug.
        attemptDeadline = Math.min(
          attemptDeadline ?? exchangeExpiresAt,
          exchangeExpiresAt,
        );
        if (finishAwaitingClaimIfExpired()) return;

        // Say the quiet part out loud on a cadence, so an agent polling a
        // process that is deliberately doing nothing has something to report.
        if (Date.now() - lastHeartbeatAtMs >= CLAIM_HEARTBEAT_MS) {
          lastHeartbeatAtMs = Date.now();
          emitEvent({
            type: "status",
            stage: "awaiting_claim",
            message:
              "Still waiting for the human to open the claim link in their browser. This process stays alive and keeps the claim link fresh; do not restart it.",
          });
        }
      }

      // While intake still holds the gate, the poll sleep also waits on it, so
      // the claim link appears in the same beat as the final answer instead of
      // up to one poll interval later.
      if (intakeGate && !intakeGate.isSettled()) {
        // The swallowed rejection is the abort, which the top of the next
        // iteration raises anyway. Left unhandled it would surface as an
        // unhandled rejection whenever the gate won the race.
        const sleep = delay(PROGRESS_POLL_MS, signal).catch(() => undefined);
        await Promise.race([sleep, intakeGate.settled]);
      } else {
        await delay(PROGRESS_POLL_MS, signal);
      }
    }
  } finally {
    claimSession?.dispose();
  }
}

async function approveAndUpload(
  collector: OnboardingCollectorSession,
  lines: InputLines,
  inspection: OnboardingSourceInspection,
  baseUrl: string,
  signal: AbortSignal,
  consentSurface: ConsentSurface,
): Promise<void> {
  let envelope: unknown;
  try {
    envelope = await collectApproval(
      collector,
      lines,
      inspection,
      consentSurface,
    );
  } finally {
    // A proposal abandoned by a throw is no longer on screen either.
    consentSurface.clear();
  }
  // The collector's absolute deadline may expire while an upload is in flight.
  // Finish its private cleanup before starting the network request so a
  // successful evidence submission can never lose the later claim handoff to
  // an already-expired local collector session.
  try {
    await collector.complete();
  } catch (error) {
    if (error instanceof OnboardingCollectorHostError) {
      throw new CollectorReviewOperationError(error, "approve_consent");
    }
    throw error;
  }
  emit({
    type: "status",
    stage: "upload",
    message: "Sending the approved evidence.",
  });
  await uploadSourceEvidence(baseUrl, envelope, signal);
  // Returning from this helper releases the only launcher-level reference to
  // the private evidence envelope before the longer preview/claim wait begins.
}

async function waitForInspectionResume(
  lines: InputLines,
  reservationDeadlineAtMs: number,
  stage: "review_scope" | "approve_consent",
): Promise<void> {
  emit({
    type: "status",
    stage: "source_review_expired",
    message:
      "The prior local inspection expired and was cleared. No evidence was sent.",
  });
  while (true) {
    emit({
      type: "input_required",
      operation: "resume_inspection",
      commands: ["resume", "cancel"],
    });
    const command = await lines.nextBefore(reservationDeadlineAtMs);
    if (command === null) {
      throw reservationExpiredError(stage);
    }
    if (command === "cancel") throw new Error("Onboarding canceled");
    if (command === "resume") return;
  }
}

async function proveCollectorCleanup(
  termination: OnboardingCollectorTermination,
  stage: "review_scope" | "approve_consent",
): Promise<void> {
  try {
    const cleanup = await termination.cleanup;
    if (cleanup === null) {
      throw collectorCleanupFailedError(stage);
    }
  } catch (error) {
    if (error instanceof SourceReviewTerminalError) throw error;
    throw collectorCleanupFailedError(stage);
  }
}

export async function runSourceOnboardCli(input: {
  baseUrl: string;
  launcherVersion: string;
}, dependencies: {
  /**
   * Narrow test seam for deterministic collector-generation expiry. Production
   * callers omit it and always use the verified native collector host.
   */
  openCollector?: typeof openOnboardingCollector;
} = {}): Promise<void> {
  const lines = new InputLines();
  const consentSurface = new ConsentSurface();
  const lifecycle = new AbortController();
  let collector: OnboardingCollectorSession | undefined;
  let submitted = false;
  const stopForSignal = (): void => {
    lifecycle.abort();
    collector?.abort();
    lines.close();
  };
  const stopForStdoutFailure = (): void => stopForSignal();
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);
  process.stdout.once("error", stopForStdoutFailure);
  try {
    // FIRST, BEFORE ANYTHING ELSE, AND EXACTLY ONCE. The agent reads the
    // protocol from the process it just started, so it must be able to read it
    // before the process does anything that needs driving — including the
    // preflight, which can fail and end the run.
    emit({
      type: "agent_instructions",
      protocolVersion: AGENT_INSTRUCTIONS_PROTOCOL_VERSION,
      instructions: AGENT_INSTRUCTIONS,
      commands: AGENT_INSTRUCTION_COMMANDS,
    });

    let internalProbeToken = consumeInternalProbeToken();
    const preflight = await preflightSourceOnboarding(
      input.baseUrl,
      input.launcherVersion,
      internalProbeToken,
      lifecycle.signal,
    );
    internalProbeToken = undefined;

    const startOptions: {
      internalProbeToken?: string;
      signal: AbortSignal;
    } = {
      internalProbeToken: preflight.internalProbeToken,
      signal: lifecycle.signal,
    };
    delete preflight.internalProbeToken;

    emit({
      type: "status",
      stage: "reservation",
      message: "Reserving a Layers preview.",
    });
    let started: Awaited<ReturnType<typeof startOnboarding>>;
    try {
      started = await startOnboarding(input.baseUrl, undefined, startOptions);
    } finally {
      delete startOptions.internalProbeToken;
    }
    if (!("state" in started) || started.state !== "awaiting_evidence") {
      throw new Error("Layers returned an incompatible source reservation");
    }
    const reservation = getReservation();
    if (!reservation)
      throw new Error("Layers source reservation was not retained");
    const reservationDeadlineAtMs = Date.parse(reservation.expiresAt);
    if (
      !Number.isFinite(reservationDeadlineAtMs) ||
      Date.now() >= reservationDeadlineAtMs
    ) {
      throw reservationExpiredError("review_scope");
    }

    for (;;) {
      let stage: "review_scope" | "approve_consent" = "review_scope";
      try {
        if (Date.now() >= reservationDeadlineAtMs) {
          throw reservationExpiredError(stage);
        }
        collector = await (
          dependencies.openCollector ?? openOnboardingCollector
        )({
          deadlineAtMs: reservationDeadlineAtMs,
          signal: lifecycle.signal,
        });
        const initial = (await collector.inspect({ root: process.cwd() }))
          .projection;
        await approveAndUpload(
          collector,
          lines,
          initial,
          input.baseUrl,
          lifecycle.signal,
          consentSurface,
        );
        break;
      } catch (error) {
        const ended =
          error instanceof CollectorGenerationEnded
            ? error
            : error instanceof CollectorReviewOperationError
              ? error
              : undefined;
        if (ended) stage = ended.stage;
        const hostError =
          error instanceof CollectorReviewOperationError
            ? error.cause
            : error instanceof OnboardingCollectorHostError
              ? error
              : undefined;
        let termination =
          error instanceof CollectorGenerationEnded
            ? error.termination
            : undefined;
        if (!termination && hostError && collector) {
          termination = await collector.waitForTermination();
        }
        if (termination) {
          collector = undefined;
          await proveCollectorCleanup(termination, stage);
          if (termination.reason === "expired") {
            if (Date.now() >= reservationDeadlineAtMs) {
              throw reservationExpiredError(stage);
            }
            await waitForInspectionResume(
              lines,
              reservationDeadlineAtMs,
              stage,
            );
            continue;
          }
          throw terminalReviewError(stage, hostError ?? termination.error);
        }
        if (hostError) {
          if (
            hostError.supportCode === "ONBOARD_COLLECTOR_TIMEOUT" &&
            Date.now() >= reservationDeadlineAtMs
          ) {
            throw reservationExpiredError(stage);
          }
          throw terminalReviewError(stage, hostError);
        }
        throw error;
      }
    }
    submitted = true;
    collector = undefined;
    emit({
      type: "status",
      stage: "preview",
      message: "Building the Layers preview.",
    });

    // THE BACKGROUND BUILD WINDOW. The approved evidence has left, the preview
    // takes a minute or two, and the canonical intake questions get asked in
    // exactly that gap — the same questions the browser door asks, at the same
    // point in the flow. The walk runs beside the progress poll rather than
    // before it, so the build is never waiting on a person and the person is
    // never waiting on the build.
    //
    // THE WALK IS READ AT THE START OF THAT WINDOW, which is BEFORE the
    // evidence analysis has bound a project. The server builds the walk from
    // whatever facts exist when it is read, and several questions have
    // variants gated on the detected app type and business type — so a walk
    // read now is the cold variant of those questions, where the browser
    // (asking after its own analysis) would show the detected one. The trial
    // holds the answers either way and the server heals the copy into the
    // project on the next read, so nothing is lost; what differs is which
    // wording of a question the person saw. Moving this read later would buy
    // the tailored wording at the cost of the window itself, which is the one
    // thing this flow exists to use.
    const intake = createIntakeWalkRunner({
      baseUrl: input.baseUrl,
      signal: lifecycle.signal,
      input: lines,
      emit,
      consent: consentSurface,
      reservationDeadlineAtMs,
    });
    const walk = intake.run();
    try {
      await waitForPreviewAndClaim(
        input.baseUrl,
        lifecycle.signal,
        reservation.expiresAt,
        emit,
        intake.gate,
      );
    } finally {
      // The walk owns the input pipe until it settles. Closing the pipe under
      // it is what ends it once the claim handoff is done.
      lines.close();
      await walk;
    }
  } catch (error) {
    let finalError = error;
    if (collector) {
      if (submitted) collector.abort();
      else {
        try {
          await collector.cancel();
        } catch {
          collector.abort();
          if (finalError instanceof SourceReviewTerminalError) {
            // Cleanup proof is a privacy invariant and therefore outranks the
            // earlier terminal classification. Retaining that earlier code
            // would falsely imply the local source generation was cleared.
            finalError = collectorCleanupFailedError(finalError.event.stage);
          }
        }
      }
      collector = undefined;
    }
    if (finalError instanceof SourceReviewTerminalError) {
      emit(finalError.event);
      throw finalError;
    }
    if (finalError instanceof OnboardingCollectorHostError) {
      throw new Error(
        `${finalError.message} (${finalError.supportCode}). ${finalError.retryCommand}`,
      );
    }
    if (finalError instanceof SourceOnboardingError) throw finalError;
    throw finalError;
  } finally {
    process.removeListener("SIGINT", stopForSignal);
    process.removeListener("SIGTERM", stopForSignal);
    process.stdout.removeListener("error", stopForStdoutFailure);
    lines.close();
  }
}
