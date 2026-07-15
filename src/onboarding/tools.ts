import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../api.js";
import { READ_ONLY, WRITE } from "../api.js";
import { authedFetch } from "./api.js";
import { getSession, redact, rememberSession } from "./session.js";

const POW_ATTEMPT_LIMIT = 2 ** 26;

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
  return parseSuccess<unknown>(response, "Onboarding status");
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
  return parseSuccess<unknown>(response, "Onboarding claim begin");
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
  return parseSuccess<unknown>(response, "Onboarding claim verify");
}

export function registerOnboardingTools(server: McpServer, baseUrl: string): void {
  server.registerTool(
    "onboard_start",
    {
      title: "Start Layers onboarding",
      annotations: WRITE,
      description:
        "Start a keyless Layers workspace trial from a website or Apple App Store URL after solving the server proof-of-work challenge.",
      inputSchema: {
        url: z.string().url().describe("Website or Apple App Store URL to onboard"),
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
        "Poll the current onboarding trial, including build and claim states plus the reveal-gated marketing plan.",
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
        "Send a six-digit claim code to the human's email after the onboarding preview is ready.",
      inputSchema: {
        email: z.string().email().describe("Email inbox that will receive the six-digit claim code"),
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
        "Verify the six-digit code from the human's inbox and claim the Layers workspace without returning credentials.",
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
