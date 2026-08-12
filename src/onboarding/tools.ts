import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../api.js";
import { READ_ONLY, WRITE } from "../api.js";
import { authedFetch } from "./api.js";
import {
  getClaimedApiKey,
  getSession,
  isClaimContinuity,
  redact,
  rememberSession,
  rememberSessionClaim,
  rememberSessionLinks,
  rememberWorkspaceKey,
} from "./session.js";
import {
  sanitizeClaimBegin,
  sanitizeClaimVerify,
  sanitizeOnboardingStatus,
} from "./public-responses.js";

const POW_ATTEMPT_LIMIT = 2 ** 26;
const ONBOARD_START_SUPPORT_CODE = "ONBOARD_START_INTERNAL";
const SAFE_ONBOARD_START_REQUEST_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|req_[A-Za-z0-9_-]{1,96})$/i;

interface ChallengeResponse {
  nonce: string;
  difficulty: number;
}

interface StartResponse {
  trialHandle: string;
  previewUrl: string;
  claimUrl: string;
  expiresAt: string;
  session: {
    access_token: string;
    expires_in: number;
  };
  sessionHandle: string;
}

export interface OnboardStartResult {
  trialHandle: string;
  previewUrl: string;
  claimUrl: string;
  expiresAt: string;
}

const endpoint = (baseUrl: string, path: string): URL => new URL(path, baseUrl);

const resultOk = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: redact(JSON.stringify(data, null, 2)) }],
});

const resultError = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: redact(text) }],
});

const errorMessage = (error: unknown): string =>
  redact(error instanceof Error ? error.message : String(error));

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rememberStatusMetadata(body: unknown): void {
  const record = asRecord(body);
  if (!record) return;

  rememberSessionLinks({
    previewUrl: optionalString(record, "previewUrl"),
    claimUrl: optionalString(record, "claimUrl"),
    workspaceUrl: optionalString(record, "workspaceUrl"),
    connectAccountsUrl: optionalString(record, "connectAccountsUrl"),
  });

  if (record.claimed === true && isClaimContinuity(record.continuity)) {
    rememberSessionClaim(record.continuity);
  }
}

function rememberVerifiedClaim(body: unknown): void {
  const record = asRecord(body);
  if (record && isClaimContinuity(record.continuity)) {
    // Retain the claimed organization identity for post-claim routing.
    const organizationId =
      typeof record.organizationId === "string" && record.organizationId.length > 0
        ? record.organizationId
        : undefined;
    // The workspace key for the org just created. Returned exactly once by
    // claim/verify and never retrievable again, so if we drop it here the only
    // way back is issuing another. Optional: minting is best-effort server-side,
    // and a claim without a key is still a good claim.
    const claimApiKey = asRecord(record.apiKey);
    const apiKeySecret =
      claimApiKey && typeof claimApiKey.secret === "string" && claimApiKey.secret.length > 0
        ? claimApiKey.secret
        : undefined;
    rememberSessionClaim(record.continuity, organizationId, apiKeySecret);
  }
}

/**
 * The claim/verify tool result, reduced to what the HUMAN's side of the
 * conversation needs: status, continuity, postclaimAssets.
 *
 * The raw API response also carries plumbing and credentials — organizationId,
 * a Supabase session (access + refresh tokens for the claimed user), and the
 * minted workspace key. Process-only fields are captured before the response
 * is projected through the explicit public contract.
 */
async function runTool(operation: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return resultOk(await operation());
  } catch (error) {
    return resultError(errorMessage(error));
  }
}

function countLeadingZeroBits(digest: Uint8Array): number {
  let count = 0;
  for (const byte of digest) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    return count + Math.clz32(byte) - 24;
  }
  return count;
}

function solveProofOfWork(nonce: string, difficulty: number): string {
  if (!Number.isInteger(difficulty) || difficulty <= 0) {
    throw new Error("invalid proof-of-work challenge");
  }

  for (let counter = 0; counter < POW_ATTEMPT_LIMIT; counter += 1) {
    const solution = String(counter);
    const digest = createHash("sha256").update(nonce + solution, "utf8").digest();
    if (countLeadingZeroBits(digest) >= difficulty) return solution;
  }
  throw new Error("proof-of-work too hard");
}

async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    throw new Error("Failed to read onboarding response");
  }
}

const responseBytes = (text: string): number => Buffer.byteLength(text, "utf8");

function supportedStartError(response: Response, text: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const record = asRecord(body);
  const details = record ? asRecord(record.details) : null;
  if (details?.supportCode !== ONBOARD_START_SUPPORT_CODE) return null;

  const requestIdCandidate = response.headers.get("x-request-id")?.trim();
  const requestId =
    requestIdCandidate && SAFE_ONBOARD_START_REQUEST_ID.test(requestIdCandidate)
      ? requestIdCandidate
      : undefined;

  return [
    `Onboarding start failed (${response.status}).`,
    `Support code: ${ONBOARD_START_SUPPORT_CODE}`,
    ...(requestId ? [`Request ID: ${requestId}`] : []),
  ].join("\n");
}

function parseJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${context} returned an invalid JSON response (${responseBytes(text)} bytes)`,
    );
  }
}

async function parseSuccess<T>(response: Response, context: string): Promise<T> {
  const text = await responseText(response);
  if (!response.ok) {
    throw new Error(
      `${context} failed (${response.status}): response body (${responseBytes(text)} bytes)`,
    );
  }
  return parseJson<T>(text, context);
}

function retryAfterText(response: Response): string {
  const seconds = response.headers.get("retry-after");
  return seconds ? ` Retry after ${seconds} seconds.` : " Wait before retrying.";
}

async function postStartWithTransportRetry(
  baseUrl: string,
  body: Record<string, string>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(endpoint(baseUrl, "/api/onboard/agent/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(redact(`Onboarding start request failed: ${errorMessage(lastError)}`));
}

export async function startOnboarding(baseUrl: string, url: string): Promise<OnboardStartResult> {
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch(endpoint(baseUrl, "/api/onboard/agent/challenge"));
  } catch (error) {
    throw new Error(redact(`Onboarding challenge request failed: ${errorMessage(error)}`));
  }
  const challenge = await parseSuccess<ChallengeResponse>(challengeResponse, "Onboarding challenge");
  if (typeof challenge.nonce !== "string" || challenge.nonce.length === 0) {
    throw new Error("Onboarding challenge returned an invalid nonce");
  }

  const startRequestId = randomUUID();
  const startResponse = await postStartWithTransportRetry(baseUrl, {
    url,
    startRequestId,
    powNonce: challenge.nonce,
    powSolution: solveProofOfWork(challenge.nonce, challenge.difficulty),
  });
  const startText = await responseText(startResponse);

  if (startResponse.status === 409) {
    throw new Error(
      "Onboarding start conflict — another start is already in flight or this request conflicts with an earlier attempt. Run onboard_start again.",
    );
  }
  if (startResponse.status === 429) {
    throw new Error(`Onboarding is rate limited.${retryAfterText(startResponse)}`);
  }
  if (startResponse.status !== 202) {
    const supportError = supportedStartError(startResponse, startText);
    if (supportError) throw new Error(supportError);
    throw new Error(
      `Onboarding start failed (${startResponse.status}): response body (${responseBytes(startText)} bytes)`,
    );
  }

  const body = parseJson<StartResponse>(startText, "Onboarding start");
  if (
    typeof body.trialHandle !== "string" ||
    typeof body.previewUrl !== "string" ||
    typeof body.claimUrl !== "string" ||
    typeof body.expiresAt !== "string" ||
    typeof body.sessionHandle !== "string" ||
    typeof body.session?.access_token !== "string" ||
    typeof body.session?.expires_in !== "number" ||
    !Number.isFinite(body.session.expires_in) ||
    body.session.expires_in <= 0
  ) {
    throw new Error("Onboarding start returned an invalid response");
  }

  let claimToken: string | null;
  try {
    claimToken = new URL(body.claimUrl).searchParams.get("token");
  } catch {
    throw new Error("Onboarding start returned an invalid claim URL");
  }
  if (!claimToken) throw new Error("Onboarding start returned a claim URL without a token");

  rememberSession({
    accessToken: body.session.access_token,
    expiresAtMs: Date.now() + body.session.expires_in * 1000,
    sessionHandle: body.sessionHandle,
    trialHandle: body.trialHandle,
    claimToken,
    previewUrl: body.previewUrl,
    claimUrl: body.claimUrl,
  });

  return {
    trialHandle: body.trialHandle,
    previewUrl: body.previewUrl,
    claimUrl: body.claimUrl,
    expiresAt: body.expiresAt,
  };
}

export async function getOnboardingStatus(baseUrl: string, trialHandle?: string): Promise<unknown> {
  const session = getSession();
  if (!session) throw new Error("run onboard_start first");
  const handle = trialHandle ?? session.trialHandle;
  const response = await authedFetch(
    baseUrl,
    `/api/onboard/agent/trials/${encodeURIComponent(handle)}`,
  );
  const body = sanitizeOnboardingStatus(
    await parseSuccess<unknown>(response, "Onboarding status"),
  );
  rememberStatusMetadata(body);
  await ensureWorkspaceKey(baseUrl, handle, body);
  return body;
}

/**
 * Acquire a workspace key once the trial is claimed, so the Layers tool set can
 * act on the workspace this session just created.
 *
 * `claim/verify` returns a key too, but only to whoever CALLED it — and the flow
 * deliberately steers claiming to the web page, so in the normal path the
 * browser gets that key and this session never sees one. The secret is returned
 * once and only hashed at rest, so it cannot be handed over after the fact;
 * minting a fresh one for this caller is the only correct answer.
 *
 * Runs off the status poll because that is the one call already made repeatedly
 * across the claim boundary — no new polling, and it self-heals a session that
 * was already running when the claim landed. Idempotent on our side (skipped
 * once a key is held) and best-effort: a failure here must never break a status
 * read, which is load-bearing for the whole flow.
 */
async function ensureWorkspaceKey(
  baseUrl: string,
  trialHandle: string,
  status: unknown,
): Promise<void> {
  if (getClaimedApiKey()) return;
  const record = asRecord(status);
  if (!record || record.claimed !== true) return;

  try {
    const response = await authedFetch(
      baseUrl,
      `/api/onboard/agent/trials/${encodeURIComponent(trialHandle)}/workspace-key`,
      { method: "POST" },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    const body = asRecord(await response.json());
    const secret = body && typeof body.secret === "string" ? body.secret : undefined;
    const organizationId =
      body && typeof body.organizationId === "string" ? body.organizationId : undefined;
    if (secret) rememberWorkspaceKey(secret, organizationId);
  } catch {
    // Never surface or log the error — this path holds a credential, and a
    // status read must not fail because a key could not be minted.
  }
}

async function beginClaim(baseUrl: string, email: string, claimToken?: string): Promise<unknown> {
  const token = claimToken ?? getSession()?.claimToken;
  if (!token) throw new Error("provide claimToken or run onboard_start first");

  let response: Response;
  try {
    response = await fetch(endpoint(baseUrl, "/api/onboard/claim/begin"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimToken: token, email }),
    });
  } catch (error) {
    throw new Error(redact(`Onboarding claim request failed: ${errorMessage(error)}`));
  }

  if (response.status === 409) {
    await response.body?.cancel();
    throw new Error("Onboarding preview still building — wait and retry onboard_claim_begin.");
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw new Error(`Onboarding claim is rate limited.${retryAfterText(response)}`);
  }
  return sanitizeClaimBegin(await parseSuccess<unknown>(response, "Onboarding claim begin"));
}

async function verifyClaim(
  baseUrl: string,
  email: string,
  code: string,
  claimToken?: string,
): Promise<unknown> {
  const token = claimToken ?? getSession()?.claimToken;
  if (!token) throw new Error("provide claimToken or run onboard_start first");

  let response: Response;
  try {
    response = await fetch(endpoint(baseUrl, "/api/onboard/claim/verify"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimToken: token, email, code }),
    });
  } catch (error) {
    throw new Error(redact(`Onboarding claim verification failed: ${errorMessage(error)}`));
  }
  const body = await parseSuccess<unknown>(response, "Onboarding claim verify");
  // Capture FIRST (org id + workspace key into process state), then strip the
  // plumbing and credentials out of what the agent gets to see.
  rememberVerifiedClaim(body);
  return sanitizeClaimVerify(body);
}

export function registerOnboardingTools(server: McpServer, baseUrl: string): void {
  server.registerTool(
    "onboard_start",
    {
      title: "Start Layers onboarding",
      annotations: WRITE,
      description:
        "Start a keyless Layers workspace trial from a website or Apple App Store URL after solving the server proof-of-work challenge. Only those two link types are supported. Ask the human for their URL first, warmly and with examples (a website like yourbrand.com, or an Apple App Store link) — NEVER guess, default, or infer it (never use layers.ai/layers.com, your own domain, or an example URL).",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(
            "The human's own website or Apple App Store URL. Ask for it; never guess or default it.",
          ),
      },
    },
    async ({ url }) => runTool(() => startOnboarding(baseUrl, url)),
  );

  server.registerTool(
    "get_onboarding_status",
    {
      title: "Get onboarding status",
      annotations: READ_ONLY,
      description:
        "Poll the current onboarding trial, including build, claim, post-claim states, and the latest preview/workspace links.",
      inputSchema: {
        trialHandle: z
          .string()
          .optional()
          .describe("Trial handle from onboard_start; defaults to the process-held trial"),
      },
    },
    async ({ trialHandle }) => runTool(() => getOnboardingStatus(baseUrl, trialHandle)),
  );

  server.registerTool(
    "onboard_claim_begin",
    {
      title: "Begin onboarding claim",
      annotations: WRITE,
      description:
        "Send a six-digit claim code to the human's email after the onboarding preview is ready. ASK the human which email to use — never infer or reuse a signed-in/account email. The human reads the code from their OWN inbox; do NOT read, search, or open their email with any tool.",
      inputSchema: {
        email: z
          .string()
          .email()
          .describe(
            "The email the human tells you to use. Ask for it; never infer or reuse an account email.",
          ),
        claimToken: z
          .string()
          .optional()
          .describe("Claim token from claimUrl; defaults to the process-held token"),
      },
    },
    async ({ email, claimToken }) => runTool(() => beginClaim(baseUrl, email, claimToken)),
  );

  server.registerTool(
    "onboard_claim_verify",
    {
      title: "Verify onboarding claim",
      annotations: WRITE,
      description:
        "Verify the six-digit code from the human's inbox and claim the Layers workspace without returning credentials. Successful responses include postclaimAssets with generationStatus, postclaimState, estimatedDuration, and message; relay postclaimAssets.message verbatim when present. The assets are generating — the influencer, first video, and keyword research — it can take a few minutes, and the preview page is where they appear when ready. The response carries no preview URL, so use the previewUrl already held or returned by get_onboarding_status. After a same-account success, continue through ask_elle immediately instead of closing with congratulations.",
      inputSchema: {
        email: z.string().email().describe("The same email used with onboard_claim_begin"),
        code: z.string().describe("Six-digit code read by the human from their inbox"),
        claimToken: z
          .string()
          .optional()
          .describe("Claim token from claimUrl; defaults to the process-held token"),
      },
    },
    async ({ email, code, claimToken }) =>
      runTool(() => verifyClaim(baseUrl, email, code, claimToken)),
  );
}
