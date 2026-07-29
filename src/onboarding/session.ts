export type ClaimContinuity = "same_account" | "browser";

export interface OnboardingClaim {
  continuity: ClaimContinuity;
  /**
   * The organization the workspace was claimed INTO.
   *
   * Claiming mints a brand-new org, and the separate `layers` partner MCP
   * authenticates with a static key bound to one *other* org — so it answers
   * "Project not found" for a freshly-claimed project no matter what id it is
   * given (observed live 2026-07-29). Holding the claimed org id lets the
   * onboarding server say WHY rather than leaving the caller to conclude the
   * project failed to build.
   *
   * Identity, not a credential. The claim response also carries a Supabase
   * session; that is deliberately NOT retained here, because nothing in this
   * server consumes it and its refresh token is a durable credential. Add it
   * only alongside the code that needs it.
   */
  organizationId?: string;
  /**
   * A partner API key for the claimed org, minted by claim/verify.
   *
   * This is what lets the onboarding server act on the workspace it just
   * created: the pre-existing key (if any) is bound to a DIFFERENT org and 404s
   * on the new project. Held in process memory only, never persisted, and
   * covered by `redact()` so it cannot leak into relayed text.
   */
  apiKeySecret?: string;
}

export interface OnboardingSession {
  accessToken: string;
  expiresAtMs: number;
  sessionHandle: string;
  trialHandle: string;
  claimToken: string;
  previewUrl: string;
  claimUrl: string;
  workspaceUrl?: string;
  connectAccountsUrl?: string;
  claim?: OnboardingClaim;
}

let currentSession: OnboardingSession | undefined;

export function getSession(): OnboardingSession | undefined {
  return currentSession;
}

export function rememberSession(session: OnboardingSession): void {
  currentSession = session;
}

export function isClaimContinuity(value: unknown): value is ClaimContinuity {
  return value === "same_account" || value === "browser";
}

export function rememberSessionClaim(
  continuity: ClaimContinuity,
  organizationId?: string,
  apiKeySecret?: string,
): void {
  if (!currentSession) return;
  currentSession.claim = {
    continuity,
    ...(organizationId ? { organizationId } : {}),
    ...(apiKeySecret ? { apiKeySecret } : {}),
  };
}

/** The claimed workspace's API key, if a claim has issued one. */
export function getClaimedApiKey(): string | undefined {
  return currentSession?.claim?.apiKeySecret;
}

export function rememberSessionLinks({
  previewUrl,
  claimUrl,
  workspaceUrl,
  connectAccountsUrl,
}: {
  previewUrl?: string;
  claimUrl?: string;
  workspaceUrl?: string;
  connectAccountsUrl?: string;
}): void {
  if (!currentSession) return;
  if (previewUrl) currentSession.previewUrl = previewUrl;
  if (claimUrl) currentSession.claimUrl = claimUrl;
  if (workspaceUrl) currentSession.workspaceUrl = workspaceUrl;
  if (connectAccountsUrl) currentSession.connectAccountsUrl = connectAccountsUrl;
}

export function updateSessionAccess(
  expectedSessionHandle: string,
  accessToken: string,
  expiresAtMs: number,
): void {
  if (!currentSession || currentSession.sessionHandle !== expectedSessionHandle) return;
  currentSession.accessToken = accessToken;
  currentSession.expiresAtMs = expiresAtMs;
}

/** Remove process-held credentials before any onboarding text is serialized. */
export function redact(text: string): string {
  if (!currentSession) return text;

  let redacted = text;
  // The claimed workspace key rides this list too. The server USES that key on
  // the caller's behalf, so it never needs to appear in text — and a partner key
  // reaching the transcript is the one leak here with no expiry to save us.
  const secrets = [
    currentSession.accessToken,
    currentSession.sessionHandle,
    currentSession.claim?.apiKeySecret,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}
