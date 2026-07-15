export interface OnboardingSession {
  accessToken: string;
  expiresAtMs: number;
  sessionHandle: string;
  trialHandle: string;
  claimToken: string;
  previewUrl: string;
  claimUrl: string;
}

let currentSession: OnboardingSession | undefined;

export function getSession(): OnboardingSession | undefined {
  return currentSession;
}

export function rememberSession(session: OnboardingSession): void {
  currentSession = session;
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
