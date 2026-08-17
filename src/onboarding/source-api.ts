import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ONBOARDING_COLLECTION_POLICY_VERSION,
  ONBOARDING_EVIDENCE_SCHEMA_VERSION,
  ONBOARDING_PROTOCOL_VERSION,
  ONBOARD_AGENT_EVIDENCE_CONTENT_ENCODING,
  ONBOARD_AGENT_EVIDENCE_CONTENT_TYPE,
  ONBOARD_AGENT_EVIDENCE_MAX_BODY_BYTES,
  ONBOARD_AGENT_PUBLIC_HEADER_NAMES,
  ONBOARD_AGENT_PUBLIC_ROUTE_PATHS,
  OnboardAgentClaimAttemptRequestSchema,
  OnboardAgentClaimAttemptResponseSchema,
  OnboardAgentClaimExchangeRequestSchema,
  OnboardAgentClaimExchangeResponseSchema,
  OnboardAgentClaimTransportHeadersSchema,
  OnboardAgentEvidenceUploadResponseSchema,
  OnboardAgentPostclaimHeadersSchema,
  OnboardAgentPostclaimResponseSchema,
  OnboardingCapabilityManifestConsumerSchema,
  OnboardingEvidenceEnvelopeSchema,
  type OnboardAgentPostclaimResponse,
  type OnboardingCapabilityManifest,
  type OnboardingEvidenceEnvelope,
} from "@layers/onboarding-contracts";
import {
  ProgressProjectionSchema,
  type ProgressProjection,
} from "./progress-contract.js";
import {
  IntakeAnswersRequestSchema,
  IntakeAnswersResponseSchema,
  ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH,
  type IntakeAnswer,
  type IntakeAnswersResponse,
} from "./intake-contract.js";
import { getReservation, type OnboardingReservation } from "./session.js";

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * The collector release this launcher runs, checked against the server's
 * `compatibility.acceptedCollectorVersions` before any local inspection.
 *
 * Moving this ahead of the server is a hard preflight stop, not a silent
 * downgrade: `capabilities.ts` in `layers/layers` must accept the new value
 * before a launcher pinned to it can onboard anyone.
 */
const COLLECTOR_VERSION = "0.1.5";
/** The longest server-supplied refusal reason this process will relay. */
const REFUSAL_REASON_MAX_LENGTH = 200;

export class SourceOnboardingError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly status?: number;
  /**
   * The server's own reason for refusing a request, when it sent one.
   *
   * Bounded and stripped of control characters before it is retained, because
   * the only consumer relays it into an agent transcript. A refusal that names
   * what was wrong ("Unknown option for goal: bananas") is what lets a caller
   * re-ask with the offered options instead of abandoning the walk.
   */
  readonly reason?: string;

  constructor(
    message: string,
    retryAfterSeconds?: number,
    status?: number,
    retryable = false,
    reason?: string,
  ) {
    super(message);
    this.name = "SourceOnboardingError";
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * A refusal that happens BEFORE anything is reserved.
 *
 * Carries a machine-readable code so the launcher can emit a real `error` event
 * instead of matching on message text — the messages are prose written for a
 * person, and branching on prose is how a copy edit becomes an outage.
 */
export class OnboardingPreflightError extends SourceOnboardingError {
  readonly code:
    | "ONBOARD_UPDATE_REQUIRED"
    | "ONBOARD_ADMISSION_CLOSED"
    | "ONBOARD_UNREACHABLE";
  /** The exact command that resolves the refusal, when the server names one. */
  readonly updateCommand?: string;

  constructor(
    code: OnboardingPreflightError["code"],
    message: string,
    options: { retryable?: boolean; updateCommand?: string } = {},
  ) {
    super(message, undefined, undefined, options.retryable ?? false);
    this.name = "OnboardingPreflightError";
    this.code = code;
    if (options.updateCommand !== undefined) {
      this.updateCommand = options.updateCommand;
    }
  }
}

/** The `reason` an error envelope carries, made safe to relay. */
function safeRefusalReason(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const reason = (parsed as { reason?: unknown }).reason;
  if (typeof reason !== "string") return undefined;
  return boundedRelayText(reason);
}

/**
 * Server-authored prose, bounded and stripped before anything relays it.
 *
 * The only consumers write this into an agent transcript, so control characters
 * and unbounded length are the two ways a refusal message could do more than
 * explain itself.
 */
export function boundedRelayText(value: string): string | undefined {
  const sanitized = value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, REFUSAL_REASON_MAX_LENGTH);
  return sanitized.length > 0 ? sanitized : undefined;
}

const endpoint = (baseUrl: string, path: string): URL => new URL(path, baseUrl);

function routePath(
  template: string,
  trialHandle: string,
  attemptHandle?: string,
): string {
  const trialPath = template.replace(
    ":trialHandle",
    encodeURIComponent(trialHandle),
  );
  return attemptHandle === undefined
    ? trialPath
    : trialPath.replace(":attemptHandle", encodeURIComponent(attemptHandle));
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new SourceOnboardingError(
          "Layers returned an oversized onboarding response",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceOnboardingError) throw error;
    throw new SourceOnboardingError(
      "Layers onboarding response was interrupted",
      undefined,
      undefined,
      true,
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SourceOnboardingError(
      "Layers onboarding response was not valid UTF-8",
    );
  } finally {
    bytes.fill(0);
  }
}

async function parseResponse(
  response: Response,
  context: string,
  expectedStatus: number | readonly number[],
): Promise<unknown> {
  const text = await boundedResponseText(response);
  const statusExpected =
    typeof expectedStatus === "number"
      ? response.status === expectedStatus
      : expectedStatus.includes(response.status);
  if (!response.ok || !statusExpected) {
    const retryAfter = response.headers.get(
      ONBOARD_AGENT_PUBLIC_HEADER_NAMES.retryAfter,
    );
    const parsedRetryAfter =
      retryAfter === null ? undefined : Number.parseInt(retryAfter, 10);
    throw new SourceOnboardingError(
      `${context} failed (${response.status})`,
      Number.isSafeInteger(parsedRetryAfter) && (parsedRetryAfter ?? -1) >= 0
        ? parsedRetryAfter
        : undefined,
      response.status,
      response.status === 429 || response.status >= 500,
      safeRefusalReason(text),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceOnboardingError(`${context} returned invalid JSON`);
  }
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

function interruptedError(): SourceOnboardingError {
  return new SourceOnboardingError("Onboarding interrupted");
}

function throwIfCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw interruptedError();
}

interface RequestAbortScope {
  signal: AbortSignal;
  dispose: () => void;
}

function requestAbortScope(callerSignal?: AbortSignal): RequestAbortScope {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) controller.abort();

  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();
  let disposed = false;

  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function requestJson(
  url: URL,
  init: RequestInit,
  context: string,
  expectedStatus: number,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  throwIfCallerAborted(callerSignal);
  const requestAbort = requestAbortScope(callerSignal);
  try {
    const response = await fetch(url, {
      ...init,
      signal: requestAbort.signal,
    });
    const body = await parseResponse(response, context, expectedStatus);
    throwIfCallerAborted(callerSignal);
    return body;
  } catch (error) {
    if (callerSignal?.aborted) throw interruptedError();
    if (error instanceof SourceOnboardingError) throw error;
    throw new SourceOnboardingError(
      "Layers onboarding is temporarily unreachable",
      undefined,
      undefined,
      true,
    );
  } finally {
    requestAbort.dispose();
  }
}

async function requestJsonWithStatuses(
  url: URL,
  init: RequestInit,
  context: string,
  expectedStatuses: readonly number[],
  callerSignal?: AbortSignal,
): Promise<JsonResponse> {
  throwIfCallerAborted(callerSignal);
  const requestAbort = requestAbortScope(callerSignal);
  try {
    const response = await fetch(url, {
      ...init,
      signal: requestAbort.signal,
    });
    const body = await parseResponse(response, context, expectedStatuses);
    throwIfCallerAborted(callerSignal);
    return { status: response.status, body };
  } catch (error) {
    if (callerSignal?.aborted) throw interruptedError();
    if (error instanceof SourceOnboardingError) throw error;
    throw new SourceOnboardingError(
      "Layers onboarding is temporarily unreachable",
      undefined,
      undefined,
      true,
    );
  } finally {
    requestAbort.dispose();
  }
}

function parseSemver(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  return parts.every(Number.isSafeInteger)
    ? ([parts[0]!, parts[1]!, parts[2]!] as const)
    : null;
}

function semverAtLeast(actual: string, required: string): boolean {
  const left = parseSemver(actual);
  const right = parseSemver(required);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

export function consumeInternalProbeToken(): string | undefined {
  const token = process.env.LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN;
  delete process.env.LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN;
  if (token === undefined) return undefined;
  if (token.length === 0 || token.length > 512) {
    throw new SourceOnboardingError(
      "Layers internal probe configuration is invalid",
    );
  }
  return token;
}

export async function preflightSourceOnboarding(
  baseUrl: string,
  launcherVersion: string,
  internalProbeToken: string | undefined,
  signal?: AbortSignal,
): Promise<{ internalProbeToken?: string }> {
  const body = await requestJson(
    endpoint(baseUrl, ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.capabilities),
    {
      headers: { Accept: "application/json" },
    },
    "Layers onboarding capability check",
    200,
    signal,
  );
  const parsed = OnboardingCapabilityManifestConsumerSchema.safeParse(body);
  if (!parsed.success) {
    throw new SourceOnboardingError(
      "Layers onboarding capability response was invalid",
    );
  }
  const manifest = parsed.data as OnboardingCapabilityManifest;

  if (manifest.sourceAdmission === "closed") {
    if (!internalProbeToken) {
      throw new OnboardingPreflightError(
        "ONBOARD_ADMISSION_CLOSED",
        "Layers source onboarding is not open yet",
      );
    }
    return { internalProbeToken };
  }

  const compatibility = manifest.compatibility;
  const compatible =
    manifest.schemaReadiness.ready === true &&
    manifest.supportedSourceKinds.includes("codebase") &&
    manifest.protocolVersion === ONBOARDING_PROTOCOL_VERSION &&
    manifest.evidenceSchemaVersion === ONBOARDING_EVIDENCE_SCHEMA_VERSION &&
    manifest.collectionPolicyVersion === ONBOARDING_COLLECTION_POLICY_VERSION &&
    compatibility.acceptedEvidenceSchemaVersions.includes(
      ONBOARDING_EVIDENCE_SCHEMA_VERSION,
    ) &&
    compatibility.acceptedCollectionPolicyVersions.includes(
      ONBOARDING_COLLECTION_POLICY_VERSION,
    ) &&
    compatibility.acceptedCollectorVersions.includes(COLLECTOR_VERSION) &&
    semverAtLeast(launcherVersion, compatibility.minimumMcpServerVersion) &&
    semverAtLeast(launcherVersion, compatibility.minimumBootstrapVersion);

  if (!compatible) {
    // The update command is server-authored text that this process prints and
    // an agent may relay, so it is bounded and control-stripped like every
    // other server string that reaches a transcript.
    const updateCommand = boundedRelayText(
      compatibility.unsafeMismatch.updateCommand,
    );
    throw new OnboardingPreflightError(
      "ONBOARD_UPDATE_REQUIRED",
      `Layers onboarding requires an update: ${updateCommand ?? "reinstall the latest @layers/mcp-server"}`,
      updateCommand === undefined ? {} : { updateCommand },
    );
  }
  return {};
}

function activeReservation(): OnboardingReservation {
  const reservation = getReservation();
  if (!reservation)
    throw new SourceOnboardingError(
      "Layers onboarding reservation is unavailable",
    );
  const expiresAt = Date.parse(reservation.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new SourceOnboardingError("Layers onboarding reservation expired");
  }
  return reservation;
}

export interface SourceClaimSession {
  readonly claimUrl: string;
  readonly expiresAt: string;
  exchange(signal?: AbortSignal): Promise<
    | { readonly state: "pending"; readonly expiresAt: string }
    | {
        readonly state: "claimed";
        readonly postclaim: OnboardAgentPostclaimResponse;
      }
    /**
     * A well-formed response carrying a state this build does not know.
     *
     * TOLERATED RATHER THAN THROWN. The canonical schema is a strict union, so
     * a state added server-side used to fail the parse and end the run — during
     * a claim wait, after consent, with the workspace already built. It is not
     * `claimed`, so it is not success; the caller retires the transport leg and
     * mints a fresh one instead of ending a person's claim over a new word.
     */
    | { readonly state: "unknown" }
  >;
  dispose(): void;
}

function claimSessionUnavailableError(): SourceOnboardingError {
  return new SourceOnboardingError(
    "Layers claim continuity session is unavailable",
  );
}

function isClaimAttemptReplayable(error: unknown): boolean {
  return (
    error instanceof SourceOnboardingError &&
    error.retryable &&
    (error.status === undefined || error.status >= 500)
  );
}

async function createClaimAttemptWithTransportRetry(
  url: URL,
  init: RequestInit,
  signal?: AbortSignal,
  retrySetup?: (error: SourceOnboardingError) => Promise<boolean>,
): Promise<unknown> {
  let immediateReplayAvailable = true;
  for (;;) {
    try {
      return await requestJson(
        url,
        init,
        "Layers claim continuity setup",
        202,
        signal,
      );
    } catch (error) {
      if (!(error instanceof SourceOnboardingError) || !error.retryable) {
        throw error;
      }
      if (immediateReplayAvailable && isClaimAttemptReplayable(error)) {
        immediateReplayAvailable = false;
        continue;
      }
      if (retrySetup && (await retrySetup(error))) continue;
      throw error;
    }
  }
}

class ProcessPrivateSourceClaimSession implements SourceClaimSession {
  readonly claimUrl: string;
  readonly expiresAt: string;
  readonly #baseUrl: string;
  readonly #trialHandle: string;
  readonly #attemptHandle: string;
  readonly #exchangeRequestId: string;
  readonly #lifecycle = new AbortController();
  #reservationCapabilityBytes: Buffer | undefined;
  #transportCapabilityBytes: Buffer | undefined;
  #codeVerifierBytes: Buffer | undefined;
  #disposed = false;

  constructor({
    baseUrl,
    trialHandle,
    attemptHandle,
    claimUrl,
    expiresAt,
    exchangeRequestId,
    reservationCapabilityBytes,
    transportCapabilityBytes,
    codeVerifierBytes,
  }: {
    baseUrl: string;
    trialHandle: string;
    attemptHandle: string;
    claimUrl: string;
    expiresAt: string;
    exchangeRequestId: string;
    reservationCapabilityBytes: Buffer;
    transportCapabilityBytes: Buffer;
    codeVerifierBytes: Buffer;
  }) {
    this.#baseUrl = baseUrl;
    this.#trialHandle = trialHandle;
    this.#attemptHandle = attemptHandle;
    this.claimUrl = claimUrl;
    this.expiresAt = expiresAt;
    this.#exchangeRequestId = exchangeRequestId;
    this.#reservationCapabilityBytes = reservationCapabilityBytes;
    this.#transportCapabilityBytes = transportCapabilityBytes;
    this.#codeVerifierBytes = codeVerifierBytes;
  }

  async exchange(
    signal?: AbortSignal,
  ): ReturnType<SourceClaimSession["exchange"]> {
    if (this.#disposed) throw claimSessionUnavailableError();
    throwIfCallerAborted(signal);
    const requestSignal = signal
      ? AbortSignal.any([this.#lifecycle.signal, signal])
      : this.#lifecycle.signal;
    let reservationCapability: string | undefined;
    let transportCapability: string | undefined;
    let codeVerifier: string | undefined;
    try {
      const reservationCapabilityBytes = this.#reservationCapabilityBytes;
      const transportCapabilityBytes = this.#transportCapabilityBytes;
      const codeVerifierBytes = this.#codeVerifierBytes;
      if (
        !reservationCapabilityBytes ||
        !transportCapabilityBytes ||
        !codeVerifierBytes
      ) {
        throw claimSessionUnavailableError();
      }

      reservationCapability = reservationCapabilityBytes.toString("utf8");
      transportCapability = transportCapabilityBytes.toString("base64url");
      codeVerifier = codeVerifierBytes.toString("base64url");
      const parsedHeaders = OnboardAgentClaimTransportHeadersSchema.safeParse({
        reservationCapability,
        transportCapability,
      });
      const parsedRequest = OnboardAgentClaimExchangeRequestSchema.safeParse({
        protocolVersion: ONBOARDING_PROTOCOL_VERSION,
        exchangeRequestId: this.#exchangeRequestId,
        codeVerifier,
      });
      if (!parsedHeaders.success || !parsedRequest.success) {
        throw claimSessionUnavailableError();
      }

      const exchange = await requestJsonWithStatuses(
        endpoint(
          this.#baseUrl,
          routePath(
            ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.claimAttemptExchange,
            this.#trialHandle,
            this.#attemptHandle,
          ),
        ),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentType]:
              ONBOARD_AGENT_EVIDENCE_CONTENT_TYPE,
            [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability]:
              parsedHeaders.data.reservationCapability,
            [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.transportCapability]:
              parsedHeaders.data.transportCapability,
          },
          body: JSON.stringify(parsedRequest.data),
        },
        "Layers claim continuity exchange",
        [200, 202],
        requestSignal,
      );
      const parsedExchange =
        OnboardAgentClaimExchangeResponseSchema.safeParse(exchange.body);
      if (!parsedExchange.success) {
        // The envelope still has to be OURS before an unknown state is treated
        // as anything but garbage: right trial, right attempt, and a state that
        // is at least a string. Anything else is an invalid response, as before.
        const body = exchange.body as Record<string, unknown> | null;
        if (
          typeof body === "object" &&
          body !== null &&
          body.trialHandle === this.#trialHandle &&
          body.attemptHandle === this.#attemptHandle &&
          typeof body.state === "string"
        ) {
          return { state: "unknown" };
        }
        throw new SourceOnboardingError(
          "Layers claim continuity exchange returned an invalid response",
        );
      }
      if (
        parsedExchange.data.trialHandle !== this.#trialHandle ||
        parsedExchange.data.attemptHandle !== this.#attemptHandle
      ) {
        throw new SourceOnboardingError(
          "Layers claim continuity exchange returned an invalid response",
        );
      }

      if (exchange.status === 202) {
        if (parsedExchange.data.state !== "pending") {
          throw new SourceOnboardingError(
            "Layers claim continuity exchange returned an invalid response",
          );
        }
        return {
          state: "pending",
          expiresAt: parsedExchange.data.expiresAt,
        };
      }
      if (parsedExchange.data.state !== "claimed") {
        throw new SourceOnboardingError(
          "Layers claim continuity exchange returned an invalid response",
        );
      }

      let postclaimCapability: string | undefined =
        parsedExchange.data.postclaimCapability;
      try {
        const parsedPostclaimHeaders =
          OnboardAgentPostclaimHeadersSchema.safeParse({
            postclaimCapability,
          });
        if (!parsedPostclaimHeaders.success) {
          throw new SourceOnboardingError(
            "Layers postclaim continuity is unavailable",
          );
        }
        const postclaimBody = await requestJson(
          endpoint(
            this.#baseUrl,
            routePath(
              ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.postclaim,
              this.#trialHandle,
            ),
          ),
          {
            headers: {
              Accept: "application/json",
              [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.postclaimCapability]:
                parsedPostclaimHeaders.data.postclaimCapability,
            },
          },
          "Layers postclaim continuity read",
          200,
          requestSignal,
        );
        const parsedPostclaim =
          OnboardAgentPostclaimResponseSchema.safeParse(postclaimBody);
        if (
          !parsedPostclaim.success ||
          parsedPostclaim.data.trialHandle !== this.#trialHandle
        ) {
          throw new SourceOnboardingError(
            "Layers postclaim continuity returned an invalid response",
          );
        }
        return { state: "claimed", postclaim: parsedPostclaim.data };
      } finally {
        postclaimCapability = undefined;
      }
    } finally {
      reservationCapability = undefined;
      transportCapability = undefined;
      codeVerifier = undefined;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle.abort();
    this.#reservationCapabilityBytes?.fill(0);
    this.#transportCapabilityBytes?.fill(0);
    this.#codeVerifierBytes?.fill(0);
    this.#reservationCapabilityBytes = undefined;
    this.#transportCapabilityBytes = undefined;
    this.#codeVerifierBytes = undefined;
  }
}

export async function createSourceClaimSession(
  baseUrl: string,
  signal?: AbortSignal,
  retrySetup?: (error: SourceOnboardingError) => Promise<boolean>,
): Promise<SourceClaimSession> {
  throwIfCallerAborted(signal);
  const reservation = activeReservation();
  const reservationCapabilityBytes = Buffer.from(
    reservation.reservationCapability,
    "utf8",
  );
  const transportCapabilityBytes = randomBytes(32);
  const codeVerifierBytes = randomBytes(32);
  const attemptRequestId = randomUUID();
  const exchangeRequestId = randomUUID();
  let transportCapability: string | undefined;
  let codeVerifier: string | undefined;
  let retained = false;
  try {
    transportCapability = transportCapabilityBytes.toString("base64url");
    codeVerifier = codeVerifierBytes.toString("base64url");
    const parsedHeaders = OnboardAgentClaimTransportHeadersSchema.safeParse({
      reservationCapability: reservation.reservationCapability,
      transportCapability,
    });
    const parsedRequest = OnboardAgentClaimAttemptRequestSchema.safeParse({
      protocolVersion: ONBOARDING_PROTOCOL_VERSION,
      attemptRequestId,
      codeChallenge: createHash("sha256")
        .update(codeVerifier, "ascii")
        .digest("base64url"),
      codeChallengeMethod: "S256",
    });
    if (!parsedHeaders.success || !parsedRequest.success) {
      throw new SourceOnboardingError(
        "Layers claim continuity setup is unavailable",
      );
    }
    const responseBody = await createClaimAttemptWithTransportRetry(
      endpoint(
        baseUrl,
        routePath(
          ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.claimAttempts,
          reservation.trialHandle,
        ),
      ),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentType]:
            ONBOARD_AGENT_EVIDENCE_CONTENT_TYPE,
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability]:
            parsedHeaders.data.reservationCapability,
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.transportCapability]:
            parsedHeaders.data.transportCapability,
        },
        body: JSON.stringify(parsedRequest.data),
      },
      signal,
      retrySetup,
    );
    const parsedResponse =
      OnboardAgentClaimAttemptResponseSchema.safeParse(responseBody);
    if (
      !parsedResponse.success ||
      parsedResponse.data.trialHandle !== reservation.trialHandle
    ) {
      throw new SourceOnboardingError(
        "Layers claim continuity setup returned an invalid response",
      );
    }

    const session = new ProcessPrivateSourceClaimSession({
      baseUrl,
      trialHandle: reservation.trialHandle,
      attemptHandle: parsedResponse.data.attemptHandle,
      claimUrl: parsedResponse.data.claimUrl,
      expiresAt: parsedResponse.data.expiresAt,
      exchangeRequestId,
      reservationCapabilityBytes,
      transportCapabilityBytes,
      codeVerifierBytes,
    });
    retained = true;
    return session;
  } finally {
    transportCapability = undefined;
    codeVerifier = undefined;
    if (!retained) {
      reservationCapabilityBytes.fill(0);
      transportCapabilityBytes.fill(0);
      codeVerifierBytes.fill(0);
    }
  }
}

export async function uploadSourceEvidence(
  baseUrl: string,
  rawEnvelope: unknown,
  signal?: AbortSignal,
): Promise<{ evidenceId: string; trialHandle: string }> {
  throwIfCallerAborted(signal);
  const reservation = activeReservation();
  const envelope = OnboardingEvidenceEnvelopeSchema.parse(
    rawEnvelope,
  ) as OnboardingEvidenceEnvelope;
  const body = JSON.stringify(envelope);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes <= 0 || bodyBytes > ONBOARD_AGENT_EVIDENCE_MAX_BODY_BYTES) {
    throw new SourceOnboardingError(
      "Approved onboarding evidence exceeds the upload limit",
    );
  }

  const submissionRequestId = randomUUID();
  const url = endpoint(
    baseUrl,
    routePath(
      ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence,
      reservation.trialHandle,
    ),
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfCallerAborted(signal);
    const requestAbort = requestAbortScope(signal);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentType]:
            ONBOARD_AGENT_EVIDENCE_CONTENT_TYPE,
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentEncoding]:
            ONBOARD_AGENT_EVIDENCE_CONTENT_ENCODING,
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentLength]: String(bodyBytes),
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability]:
            reservation.reservationCapability,
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.submissionRequestId]:
            submissionRequestId,
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.evidenceKind]: envelope.kind,
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.evidenceSchemaVersion]: String(
            ONBOARDING_EVIDENCE_SCHEMA_VERSION,
          ),
          [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.collectionPolicyVersion]:
            ONBOARDING_COLLECTION_POLICY_VERSION,
        },
        body,
        signal: requestAbort.signal,
      });
      const responseBody = await parseResponse(
        response,
        "Layers evidence upload",
        202,
      );
      const parsed =
        OnboardAgentEvidenceUploadResponseSchema.safeParse(responseBody);
      if (
        !parsed.success ||
        parsed.data.trialHandle !== reservation.trialHandle
      ) {
        throw new SourceOnboardingError(
          "Layers evidence upload returned an invalid response",
        );
      }
      throwIfCallerAborted(signal);
      return {
        evidenceId: parsed.data.evidenceId,
        trialHandle: parsed.data.trialHandle,
      };
    } catch (error) {
      lastError = signal?.aborted ? interruptedError() : error;
      const retryable =
        lastError instanceof SourceOnboardingError
          ? lastError.retryable
          : true;
      if (!retryable || attempt === 1) break;
      // The request is idempotent by the fixed submission id. One transport
      // retry can only replay the same accepted evidence, never create a second.
    } finally {
      requestAbort.dispose();
    }
  }
  if (lastError instanceof SourceOnboardingError) throw lastError;
  throw new SourceOnboardingError("Layers evidence upload is unreachable");
}

export async function readSourceProgress(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ProgressProjection> {
  throwIfCallerAborted(signal);
  const reservation = activeReservation();
  const body = await requestJson(
    endpoint(
      baseUrl,
      routePath(
        ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.progress,
        reservation.trialHandle,
      ),
    ),
    {
      headers: {
        Accept: "application/json",
        [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability]:
          reservation.reservationCapability,
      },
    },
    "Layers onboarding progress",
    200,
    signal,
  );
  // Parsed through the LOCAL mirror, not the pinned canonical schema: that one
  // is `.strict()` with an enumerated `state`, so a field or state added
  // server-side would fail this read on every poll of an hours-long claim wait.
  const parsed = ProgressProjectionSchema.safeParse(body);
  if (!parsed.success || parsed.data.trialHandle !== reservation.trialHandle) {
    throw new SourceOnboardingError(
      "Layers onboarding progress returned an invalid response",
    );
  }
  return parsed.data;
}

/**
 * The pre-claim intake walk, read on the reservation capability alone.
 *
 * Authorized exactly like the progress poll above — the same
 * `x-layers-onboard-capability` header, hashed and matched server-side, so the
 * plaintext capability never reaches a query, a log line, or this process's
 * stdout. That is why the LAUNCHER walks intake and the agent driving it never
 * could: the capability is deliberately absent from everything the agent reads.
 */
function intakeAnswersEndpoint(trialHandle: string): string {
  return routePath(ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH, trialHandle);
}

function parseIntakeResponse(
  body: unknown,
  trialHandle: string,
): IntakeAnswersResponse {
  const parsed = IntakeAnswersResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.trialHandle !== trialHandle) {
    throw new SourceOnboardingError(
      "Layers onboarding intake returned an invalid response",
    );
  }
  return parsed.data;
}

export async function readIntakeWalk(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<IntakeAnswersResponse> {
  throwIfCallerAborted(signal);
  const reservation = activeReservation();
  const body = await requestJson(
    endpoint(baseUrl, intakeAnswersEndpoint(reservation.trialHandle)),
    {
      headers: {
        Accept: "application/json",
        [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability]:
          reservation.reservationCapability,
      },
    },
    "Layers onboarding intake read",
    200,
    signal,
  );
  return parseIntakeResponse(body, reservation.trialHandle);
}

/**
 * One answer, recorded, answering with the RECOMPUTED walk.
 *
 * One answer per call rather than a batch: the walk is emitted one question at
 * a time, so a batch would mean holding answers the person already gave while
 * asking for more, and losing all of them to one failed request.
 */
export async function submitIntakeAnswer(
  baseUrl: string,
  answer: IntakeAnswer,
  signal?: AbortSignal,
): Promise<IntakeAnswersResponse> {
  throwIfCallerAborted(signal);
  const reservation = activeReservation();
  const parsedRequest = IntakeAnswersRequestSchema.safeParse({
    protocolVersion: ONBOARDING_PROTOCOL_VERSION,
    answers: [answer],
  });
  if (!parsedRequest.success) {
    throw new SourceOnboardingError(
      "Layers onboarding intake answer is invalid",
      undefined,
      400,
    );
  }
  const body = await requestJson(
    endpoint(baseUrl, intakeAnswersEndpoint(reservation.trialHandle)),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentType]:
          ONBOARD_AGENT_EVIDENCE_CONTENT_TYPE,
        [ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability]:
          reservation.reservationCapability,
      },
      body: JSON.stringify(parsedRequest.data),
    },
    "Layers onboarding intake answer",
    200,
    signal,
  );
  return parseIntakeResponse(body, reservation.trialHandle);
}
