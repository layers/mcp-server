import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { refreshSession } from "./api.js";
import {
  getSession,
  redact,
  type OnboardingSession,
} from "./session.js";

interface BridgeClient {
  onclose?: () => void;
  connect(transport: Transport): Promise<void>;
  callTool: Client["callTool"];
  close(): Promise<void>;
}

type BridgeTarget = "onboarding" | "full";
type BridgeState = BridgeTarget | "browser";

interface BridgeConnection {
  accessToken: string;
  client: BridgeClient;
  closed: boolean;
  sessionHandle: string;
  target: BridgeTarget;
  trialHandle: string;
}

export interface OnboardingBridgeDependencies {
  getSession: () => OnboardingSession | undefined;
  refreshSession: (baseUrl: string) => Promise<void>;
  createClient: () => BridgeClient;
  createTransport: (
    url: URL,
    options: StreamableHTTPClientTransportOptions,
  ) => Transport;
}

const defaultDependencies: OnboardingBridgeDependencies = {
  getSession,
  refreshSession,
  createClient: () =>
    new Client({ name: "layers-onboarding-bridge", version: "1.0.0" }),
  createTransport: (url, options) =>
    new StreamableHTTPClientTransport(url, options),
};

const sensitiveKey = /^(?:authorization|access[_-]?token|refresh[_-]?token|session[_-]?handle)$/i;

function redactBridgeText(text: string, secrets: ReadonlySet<string>): string {
  let redacted = redact(text);
  const orderedSecrets = [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const secret of orderedSecrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }

  // Defense in depth for credentials echoed under a recognizable transport or
  // JSON field even when the bridge was never given that credential's value.
  redacted = redacted.replace(/\bBearer\s+[^\s,;"'}\]]+/gi, "Bearer [redacted]");
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[redacted]",
  );
  redacted = redacted.replace(
    /((?:"|')?(?:authorization|access[\s_-]?token|refresh[\s_-]?token|session[\s_-]?handle)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    "$1[redacted]",
  );
  // The trailing run is a single flat quantifier, not (?:_[…]+)+ : because the
  // character class already contains "_", the nested form let a "_" be consumed
  // two ways, which is catastrophic backtracking (js/redos). "_" then one-or-more
  // class chars matches the exact same strings without the ambiguity.
  redacted = redacted.replace(
    /\b(?:access[_-]?token|refresh[_-]?token|sessionHandle)_[A-Za-z0-9.+/=_-]+\b/gi,
    "[redacted]",
  );
  return redacted;
}

function redactBridgeValue(
  value: unknown,
  secrets: ReadonlySet<string>,
  key?: string,
): unknown {
  if (key && sensitiveKey.test(key)) return "[redacted]";
  if (typeof value === "string") return redactBridgeText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactBridgeValue(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactBridgeValue(entryValue, secrets, entryKey),
      ]),
    );
  }
  return value;
}

function errorDetails(error: unknown): { code?: unknown; message: string; name?: string } {
  if (error instanceof Error) {
    return {
      code: "code" in error ? (error as Error & { code?: unknown }).code : undefined,
      message: error.message,
      name: error.name,
    };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      code: record.code ?? record.status ?? record.statusCode,
      message: typeof record.message === "string" ? record.message : String(error),
      name: typeof record.name === "string" ? record.name : undefined,
    };
  }
  return { message: String(error) };
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    if (typeof current !== "object") break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof StreamableHTTPError && error.code === 401) return true;
  if (error instanceof UnauthorizedError) return true;

  return errorChain(error).some((item) => {
    const details = errorDetails(item);
    return (
      details.code === 401 ||
      details.code === "401" ||
      details.name === "UnauthorizedError" ||
      /\b401\b|unauthori[sz]ed/i.test(details.message)
    );
  });
}

function isForbidden(error: unknown): boolean {
  if (error instanceof StreamableHTTPError && error.code === 403) return true;

  return errorChain(error).some((item) => {
    const details = errorDetails(item);
    return (
      details.code === 403 ||
      details.code === "403" ||
      /\b403\b|forbidden|anonymous[- ]principal|anonymous user/i.test(details.message)
    );
  });
}

function isConnectionDrop(error: unknown): boolean {
  return errorChain(error).some((item) => {
    const { code, message } = errorDetails(item);
    return (
      ["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(
        String(code),
      ) ||
      /connection (?:is )?closed|connection reset|fetch failed|network error|socket hang up/i.test(
        message,
      )
    );
  });
}

/**
 * The remote MCP server forgets its Streamable-HTTP transport sessions when it
 * restarts or redeploys, so an established bridge connection starts getting
 * JSON-RPC -32000 "Session not found". Treat that exactly like a dropped
 * connection: close and reconnect, which re-initializes a fresh MCP session.
 * Without this an Elle deploy would surface the raw error mid-onboarding.
 */
function isStaleSession(error: unknown): boolean {
  return errorChain(error).some((item) => {
    const { code, message } = errorDetails(item);
    return String(code) === "-32000" || /session not found/i.test(message);
  });
}

function bridgeState(session: OnboardingSession): BridgeState {
  if (session.claim?.continuity === "same_account") return "full";
  if (session.claim?.continuity === "browser") return "browser";
  return "onboarding";
}

function fullTransitionKey(session: OnboardingSession): string {
  return `${session.sessionHandle}:${session.trialHandle}`;
}

function sessionEndedMessage(session: OnboardingSession | undefined): string {
  const base = "Session ended - continue in your Layers workspace in the browser.";
  return session?.workspaceUrl ? `${base} ${session.workspaceUrl}` : base;
}

function browserContinuityMessage(): string {
  return "This workspace was claimed in the browser. Continue in your Layers workspace there, and use the links already surfaced in this chat.";
}

class BridgeCallError extends Error {
  constructor(
    readonly original: unknown,
    readonly target: BridgeTarget,
  ) {
    super(errorDetails(original).message);
    this.name = "BridgeCallError";
  }
}

function sameSession(
  connection: BridgeConnection,
  session: OnboardingSession,
  target: BridgeTarget,
): boolean {
  return (
    !connection.closed &&
    connection.accessToken === session.accessToken &&
    connection.sessionHandle === session.sessionHandle &&
    connection.target === target &&
    connection.trialHandle === session.trialHandle
  );
}

/**
 * Lazily connects the keyless onboarding process to Elle's remote MCP server.
 * One call is retried at most once, either after a token refresh or reconnect.
 */
export class OnboardingBridge {
  private connection: BridgeConnection | undefined;
  private connecting: Promise<BridgeConnection> | undefined;
  private fullTransitionRefresh: Promise<void> | undefined;
  private fullTransitionRefreshKey: string | undefined;
  private readonly dependencies: OnboardingBridgeDependencies;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly elleMcpBaseUrl: string,
    dependencies: Partial<OnboardingBridgeDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  private rememberSecrets(secrets: Set<string>): void {
    const session = this.dependencies.getSession();
    if (!session) return;
    secrets.add(session.accessToken);
    secrets.add(session.sessionHandle);
  }

  private endpoint(session: OnboardingSession, target: BridgeTarget): URL {
    if (target === "full") return new URL("/api/mcp/elle/mcp", this.elleMcpBaseUrl);
    const url = new URL("/api/mcp/onboarding/mcp", this.elleMcpBaseUrl);
    url.searchParams.set("trial", session.trialHandle);
    return url;
  }

  private headers(session: OnboardingSession, target: BridgeTarget): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessToken}`,
    };
    if (target === "onboarding") {
      // Elle's hosted onboarding-guide tools run in an MCP request context
      // detached from the server middleware, so the ?trial= query the gate
      // reads never reaches them — only request headers do. Sending the
      // handle here lets those tools recover the gate-authorized binding.
      // Must match ONBOARD_TRIAL_HEADER in apps/elle.
      headers["x-layers-onboard-trial"] = session.trialHandle;
    }
    return headers;
  }

  private async refreshForFullPath(secrets: Set<string>): Promise<void> {
    const session = this.dependencies.getSession();
    try {
      await this.dependencies.refreshSession(this.apiBaseUrl);
      this.rememberSecrets(secrets);
    } catch {
      throw new Error(redactBridgeText(sessionEndedMessage(session), secrets));
    }
  }

  private async ensureFullTransitionRefresh(
    session: OnboardingSession,
    secrets: Set<string>,
  ): Promise<void> {
    const key = fullTransitionKey(session);
    if (this.fullTransitionRefreshKey === key) return;

    if (!this.fullTransitionRefresh) {
      const refresh = this.refreshForFullPath(secrets);
      this.fullTransitionRefresh = refresh;
      try {
        await refresh;
        const current = this.dependencies.getSession();
        if (current && fullTransitionKey(current) === key) {
          this.fullTransitionRefreshKey = key;
        }
      } finally {
        if (this.fullTransitionRefresh === refresh) this.fullTransitionRefresh = undefined;
      }
      return;
    }

    await this.fullTransitionRefresh;
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection || connection.closed) return;
    connection.closed = true;
    try {
      await connection.client.close();
    } catch {
      // A failed close must not prevent a fresh authenticated connection.
    }
  }

  private async openConnection(
    session: OnboardingSession,
    target: BridgeTarget,
  ): Promise<BridgeConnection> {
    await this.closeConnection();

    const client = this.dependencies.createClient();
    const connection: BridgeConnection = {
      accessToken: session.accessToken,
      client,
      closed: false,
      sessionHandle: session.sessionHandle,
      target,
      trialHandle: session.trialHandle,
    };
    client.onclose = () => {
      connection.closed = true;
      if (this.connection === connection) this.connection = undefined;
    };

    const transport = this.dependencies.createTransport(this.endpoint(session, target), {
      requestInit: {
        headers: this.headers(session, target),
      },
    });

    try {
      await client.connect(transport);
      if (connection.closed) {
        throw new Error("Onboarding bridge connection closed during setup");
      }
      this.connection = connection;
      return connection;
    } catch (error) {
      connection.closed = true;
      try {
        await client.close();
      } catch {
        // Preserve the original connection error for retry classification.
      }
      throw error;
    }
  }

  private async ensureConnected(secrets: Set<string>): Promise<BridgeConnection> {
    while (true) {
      const session = this.dependencies.getSession();
      if (!session) throw new Error("run onboard_start first");
      const target = bridgeState(session);
      if (target === "browser") {
        throw new Error(browserContinuityMessage());
      }
      if (target === "full") {
        await this.ensureFullTransitionRefresh(session, secrets);
        this.rememberSecrets(secrets);
        const current = this.dependencies.getSession();
        if (!current) throw new Error(sessionEndedMessage(session));
        if (current.accessToken !== session.accessToken) continue;
      }

      if (this.connection && sameSession(this.connection, session, target)) {
        return this.connection;
      }

      if (this.connecting) {
        await this.connecting;
        continue;
      }

      const connecting = this.openConnection(session, target);
      this.connecting = connecting;
      try {
        const connection = await connecting;
        const current = this.dependencies.getSession();
        if (current && sameSession(connection, current, target)) return connection;
      } finally {
        if (this.connecting === connecting) this.connecting = undefined;
      }
    }
  }

  private async callOnce(
    remoteToolName: string,
    args: Record<string, unknown>,
    secrets: Set<string>,
  ): Promise<CallToolResult> {
    const connection = await this.ensureConnected(secrets);
    try {
      const result = await connection.client.callTool({
        name: remoteToolName,
        arguments: args,
      });
      if (!("content" in result)) {
        throw new Error("Onboarding bridge returned an invalid tool result");
      }
      return result as CallToolResult;
    } catch (error) {
      throw new BridgeCallError(error, connection.target);
    }
  }

  async callBridged(
    remoteToolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const secrets = new Set<string>();
    this.rememberSecrets(secrets);

    try {
      let result: CallToolResult;
      try {
        result = await this.callOnce(remoteToolName, args, secrets);
      } catch (firstError) {
        this.rememberSecrets(secrets);
        const original =
          firstError instanceof BridgeCallError ? firstError.original : firstError;
        const target = firstError instanceof BridgeCallError ? firstError.target : undefined;
        if (target === "full" && (isUnauthorized(original) || isForbidden(original))) {
          await this.refreshForFullPath(secrets);
          this.rememberSecrets(secrets);
          await this.closeConnection();
        } else if (isUnauthorized(original)) {
          await this.dependencies.refreshSession(this.apiBaseUrl);
          this.rememberSecrets(secrets);
          await this.closeConnection();
        } else if (isConnectionDrop(original) || isStaleSession(original)) {
          await this.closeConnection();
        } else {
          throw original;
        }

        // Exactly one retry, regardless of how the retry itself fails.
        result = await this.callOnce(remoteToolName, args, secrets);
      }

      this.rememberSecrets(secrets);
      return redactBridgeValue(result, secrets) as CallToolResult;
    } catch (error) {
      this.rememberSecrets(secrets);
      const message = errorDetails(error).message;
      throw new Error(redactBridgeText(message, secrets));
    }
  }

  async close(): Promise<void> {
    await this.closeConnection();
  }
}

let onboardingBridge: OnboardingBridge | undefined;

/** The process-wide bridge is created only when a bridged tool is first called. */
export function getOnboardingBridge(
  apiBaseUrl: string,
  elleMcpBaseUrl: string,
): OnboardingBridge {
  onboardingBridge ??= new OnboardingBridge(apiBaseUrl, elleMcpBaseUrl);
  return onboardingBridge;
}
