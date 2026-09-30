import { AnyRouteError } from "@anyroute/client";

// Errors the SDK throws for a non-2xx answer. The router's envelope is { error: { code, message, type, metadata? } };
// `type` is the stable machine-readable reason (rate_limited, model_not_found, preset_not_found, ...). A 429 (and some
// 503s) carries Retry-After, parsed here into milliseconds.

/** Retry-After as milliseconds: delta-seconds or an HTTP-date. null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value == null || value.trim() === "") return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export class AnyrouteAPIError extends AnyRouteError {
  /** The router's reason, for example "rate_limited" or "model_not_found". Same value as `code`. */
  readonly type: string;
  /** From Retry-After, in milliseconds. null when the router did not say. */
  readonly retryAfterMs: number | null;
  readonly headers: Headers;

  constructor(message: string, type: string, status: number, metadata: unknown, headers: Headers) {
    super(message, type, status, metadata);
    this.name = "AnyrouteAPIError";
    this.type = type;
    this.headers = headers;
    this.retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  }

  /** Seconds to wait before retrying, or null. */
  get retryAfter(): number | null {
    return this.retryAfterMs == null ? null : this.retryAfterMs / 1000;
  }

  /** Read a failed response into the matching subclass. Consumes the body. */
  static async fromResponse(res: Response): Promise<AnyrouteAPIError> {
    const text = await res.text().catch(() => "");
    let env: { error?: { message?: string; type?: string; metadata?: unknown } } | null = null;
    try {
      env = JSON.parse(text);
    } catch {
      env = null;
    }
    const message = env?.error?.message ?? (text.slice(0, 200) || `request failed with ${res.status}`);
    const type = env?.error?.type ?? defaultType(res.status);
    const Cls = res.status === 429 ? RateLimitError : res.status === 401 || res.status === 403 ? AuthenticationError : res.status === 404 ? NotFoundError : res.status === 400 || res.status === 422 ? BadRequestError : AnyrouteAPIError;
    return new Cls(message, type, res.status, env?.error?.metadata, res.headers);
  }
}

const defaultType = (status: number) => (status === 429 ? "rate_limited" : status === 401 ? "unauthorized" : status === 404 ? "not_found" : status >= 500 ? "server_error" : "request_failed");

export class RateLimitError extends AnyrouteAPIError {
  override name = "RateLimitError";
}
export class AuthenticationError extends AnyrouteAPIError {
  override name = "AuthenticationError";
}
export class NotFoundError extends AnyrouteAPIError {
  override name = "NotFoundError";
}
export class BadRequestError extends AnyrouteAPIError {
  override name = "BadRequestError";
}

/** A batch did not reach a final state before the timeout passed to `batches.wait`. */
export class BatchTimeoutError extends AnyRouteError {
  constructor(readonly batchId: string, readonly lastStatus: string) {
    super(`batch ${batchId} is still ${lastStatus}`, "batch_timeout");
    this.name = "BatchTimeoutError";
  }
}
