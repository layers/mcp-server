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
): void {
  if (!currentSession) return;
  currentSession.claim = {
    continuity,
    ...(organizationId ? { organizationId } : {}),
  };
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
  const secrets = [currentSession.accessToken, currentSession.sessionHandle]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}
