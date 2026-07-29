import { getSession, updateSessionAccess } from "./session.js";

interface RefreshResponse {
  access_token: string;
  expires_in: number;
}

const SESSION_EXPIRED_MESSAGE = "onboarding session expired — run onboard_start again";

export class OnboardingSessionExpiredError extends Error {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE);
    this.name = "OnboardingSessionExpiredError";
  }
}

const endpoint = (baseUrl: string, path: string): URL => new URL(path, baseUrl);

export async function refreshSession(baseUrl: string): Promise<void> {
  const sessionAtEntry = getSession();
  if (!sessionAtEntry) throw new OnboardingSessionExpiredError();
  const expectedSessionHandle = sessionAtEntry.sessionHandle;

  try {
    const response = await fetch(endpoint(baseUrl, "/api/onboard/agent/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionHandle: expectedSessionHandle }),
    });
    if (!response.ok) throw new OnboardingSessionExpiredError();

    const body = (await response.json()) as Partial<RefreshResponse>;
    if (
      typeof body.access_token !== "string" ||
      body.access_token.length === 0 ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    ) {
      throw new OnboardingSessionExpiredError();
    }

    updateSessionAccess(
      expectedSessionHandle,
      body.access_token,
      Date.now() + body.expires_in * 1000,
    );
  } catch {
    const current = getSession();
    if (current && current.sessionHandle !== expectedSessionHandle) return;
    throw new OnboardingSessionExpiredError();
  }
}

export async function authedFetch(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let session = getSession();
  if (!session) throw new OnboardingSessionExpiredError();

  if (Date.now() > session.expiresAtMs - 30_000) {
    await refreshSession(baseUrl);
    session = getSession();
    if (!session) throw new OnboardingSessionExpiredError();
  }

  const request = (): Promise<Response> => {
    const current = getSession();
    if (!current) throw new OnboardingSessionExpiredError();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${current.accessToken}`);
    return fetch(endpoint(baseUrl, path), { ...init, headers });
  };

  let response = await request();
  if (response.status === 401) {
    await refreshSession(baseUrl);
    response = await request();
  }
  return response;
}
