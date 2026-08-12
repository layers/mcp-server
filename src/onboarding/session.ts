export type ClaimContinuity = "same_account" | "browser";

export interface OnboardingClaim {
  continuity: ClaimContinuity;
  /**
   * The organization the workspace was claimed INTO.
   *
   * Claiming mints a brand-new org, and the separate `layers` partner MCP
   * authenticates with a static key bound to one *other* org. Holding the
   * claimed org id keeps post-claim routing bound to the correct workspace.
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
  /**
   * A partner API key for the claimed workspace's org.
   *
   * Lives at the session root, NOT under `claim`, on purpose: a web claim never
   * routes through onboard_claim_verify, so when the key is fetched afterwards
   * there is no claim record and no known continuity. Nesting it would force
   * inventing one — and `ask_elle` ROUTES on continuity, so a fabricated value
   * would silently change which Elle the human talks to.
   *
   * Process memory only, never persisted, and covered by `redact()`.
   */
  workspaceApiKey?: string;
}

/**
 * The capability returned by a protocol-v1 URL-free reservation.
 *
 * This is deliberately separate from `OnboardingSession`: reserving a trial
 * does not mint the authenticated session, preview, or claim links used by the
 * legacy URL flow. The later evidence-submission tool can consume this value
 * from process memory without ever returning it to the host agent.
 */
export interface OnboardingReservation {
  protocolVersion: 1;
  trialHandle: string;
  reservationCapability: string;
  expiresAt: string;
  state: "awaiting_evidence";
}

let currentSession: OnboardingSession | undefined;
let currentReservation: OnboardingReservation | undefined;

export function getSession(): OnboardingSession | undefined {
  return currentSession;
}

export function getReservation(): OnboardingReservation | undefined {
  return currentReservation;
}

export function rememberSession(session: OnboardingSession): void {
  currentSession = session;
  currentReservation = undefined;
}

export function rememberReservation(reservation: OnboardingReservation): void {
  currentReservation = reservation;
  currentSession = undefined;
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
  };
  if (apiKeySecret) currentSession.workspaceApiKey = apiKeySecret;
}

/** Record a workspace key fetched after the fact (the web-claim path). */
export function rememberWorkspaceKey(apiKeySecret: string, organizationId?: string): void {
  if (!currentSession) return;
  currentSession.workspaceApiKey = apiKeySecret;
  // Only ENRICH an existing claim record — never synthesize one, since that
  // would mean guessing `continuity`.
  if (organizationId && currentSession.claim && !currentSession.claim.organizationId) {
    currentSession.claim.organizationId = organizationId;
  }
}

/** The claimed workspace's API key, if one has been issued to this session. */
export function getClaimedApiKey(): string | undefined {
  return currentSession?.workspaceApiKey;
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
  let redacted = text;
  // The claimed workspace key rides this list too. The server USES that key on
  // the caller's behalf, so it never needs to appear in text — and a partner key
  // reaching the transcript is the one leak here with no expiry to save us.
  const secrets = [
    currentSession?.accessToken,
    currentSession?.sessionHandle,
    currentSession?.workspaceApiKey,
    currentReservation?.reservationCapability,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}
