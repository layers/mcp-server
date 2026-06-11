import { randomUUID } from "node:crypto";

export type QueryValue = string | number | boolean | string[] | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

export const err = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

/** Drop undefined values so PATCH bodies only carry the fields the caller set
 *  (null survives — it's meaningful, e.g. clearing an override). */
export const clean = (obj: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

export class LayersClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  /**
   * Issue a request and shape the outcome as an MCP tool result.
   * Mutating methods automatically get a UUID Idempotency-Key.
   * Errors render the Layers envelope: code, message, requestId, details.
   */
  async run(method: string, path: string, opts: RequestOptions = {}): Promise<ToolResult> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue;
      // Array filters repeat the param: ?status=a&status=b
      for (const v of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (method === "POST" || method === "PATCH") {
      headers["Idempotency-Key"] = randomUUID();
    }
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      return err(`Request to Layers API failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const text = await res.text();
    if (!res.ok) {
      return err(formatApiError(res.status, text));
    }

    if (!text) return ok({ status: res.status });
    try {
      return ok(JSON.parse(text));
    } catch {
      return ok(text);
    }
  }
}

function formatApiError(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string; requestId?: string; details?: unknown };
    };
    const e = parsed.error;
    if (e?.code || e?.message) {
      let out = `Layers API ${status} ${e.code ?? ""}: ${e.message ?? ""}`.trim();
      if (e.requestId) out += `\nrequestId: ${e.requestId}`;
      if (e.details !== undefined && e.details !== null) {
        out += `\ndetails: ${JSON.stringify(e.details, null, 2)}`;
      }
      return out;
    }
  } catch {
    // not the JSON envelope — fall through to raw text
  }
  return `Layers API ${status}: ${text}`;
}
