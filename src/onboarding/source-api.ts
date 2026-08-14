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
  OnboardAgentProgressResponseSchema,
  OnboardingCapabilityManifestConsumerSchema,
  OnboardingEvidenceEnvelopeSchema,
  type OnboardAgentPostclaimResponse,
  type OnboardingCapabilityManifest,
  type OnboardingEvidenceEnvelope,
  type OnboardingProgressProjection,
} from "@layers/onboarding-contracts";
import { getReservation, type OnboardingReservation } from "./session.js";

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const COLLECTOR_VERSION = "0.1.3";

export class SourceOnboardingError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly status?: number;

  constructor(
    message: string,
    retryAfterSeconds?: number,
    status?: number,
    retryable = false,
  ) {
    super(message);
    this.name = "SourceOnboardingError";
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
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
      throw new SourceOnboardingError(
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
    throw new SourceOnboardingError(
      `Layers onboarding requires an update: ${compatibility.unsafeMismatch.updateCommand}`,
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
      if (
        !parsedExchange.success ||
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
): Promise<OnboardingProgressProjection> {
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
  const parsed = OnboardAgentProgressResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.trialHandle !== reservation.trialHandle) {
    throw new SourceOnboardingError(
      "Layers onboarding progress returned an invalid response",
    );
  }
  return parsed.data;
}
