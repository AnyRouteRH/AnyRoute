import { openProviderHeaders } from "./headers.ts";
import { providerFetch } from "./network.ts";
import type { Candidate } from "../catalog/catalog.ts";
import { decrypt } from "../lib/util.ts";

// OpenAI-compatible upstream calls. Every failure is classified so the router can decide
// whether to fall back (5xx, timeout, connection, 429, empty-200, provider-side 4xx) and what
// to record against the provider's health.

export type ErrorKind =
  | "http_5xx"
  | "timeout"
  | "connection"
  | "rate_limited"
  | "provider_auth"
  | "rejected"
  | "empty200"
  | "unreadable"
  | "interrupted";

export type UpstreamFailure = { ok: false; status?: number; errorKind: ErrorKind; message: string; latencyMs: number };
export type UpstreamJson = { ok: true; kind: "json"; status: number; json: any; latencyMs: number };
export type UpstreamStream = { ok: true; kind: "stream"; status: number; events: AsyncGenerator<any>; first: any; latencyMs: number; abort: () => void };
export type UpstreamResult = UpstreamJson | UpstreamStream | UpstreamFailure;

// Fields that only mean something to the router and must not reach providers.
const ROUTER_FIELDS = new Set(["provider", "models", "route", "transforms", "usage", "plugins", "cache", "guardrails", "user_id", "debug"]);
// Parameters dropped quietly when a provider does not list them (OpenRouter behaviour);
// everything else is forwarded, and semantic parameters are filtered at selection time.
const DROPPABLE = new Set(["top_k", "min_p", "top_a", "repetition_penalty", "logit_bias", "seed", "logprobs", "top_logprobs", "stop", "presence_penalty", "frequency_penalty", "verbosity"]);

export function upstreamBody(c: Candidate, body: Record<string, unknown>, stream: boolean) {
  const out: Record<string, unknown> = {};
  const supported = new Set(c.supportedParameters ?? []);
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (ROUTER_FIELDS.has(k) || v === undefined) continue;
    if (supported.size && DROPPABLE.has(k) && !supported.has(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  // OpenRouter's unified reasoning object -> OpenAI-style reasoning_effort when needed.
  const reasoning = body.reasoning as { effort?: string; max_tokens?: number; exclude?: boolean; enabled?: boolean } | undefined;
  if (reasoning && supported.size && !supported.has("reasoning")) {
    delete out.reasoning;
    if (supported.has("reasoning_effort") && reasoning.effort) out.reasoning_effort = reasoning.effort;
  }
  out.model = c.providerModelId;
  if (stream) {
    out.stream = true;
    out.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
  } else delete out.stream;
  return { body: out, dropped };
}

export function providerKey(c: Candidate, secret: string, byokKey?: string) {
  if (byokKey) return byokKey;
  if (!c.provider.apiKeyEnc) return undefined;
  return decrypt(secret, c.provider.apiKeyEnc);
}

function classifyStatus(status: number): ErrorKind {
  if (status >= 500) return "http_5xx";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 402 || status === 403) return "provider_auth";
  return "rejected";
}

/** Provider error text is shown to callers: strip URLs, credentials and long hex, cap the length. */
export function sanitizeUpstream(msg: string) {
  return msg
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:sk|pk|rk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b0x[0-9a-fA-F]{32,}\b/g, "[hex]")
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[hex]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .slice(0, 200);
}

async function errorMessage(res: Response) {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return sanitizeUpstream(String(j?.error?.message ?? j?.message ?? text));
    } catch {
      return sanitizeUpstream(text);
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue; // comment / keep-alive
        if (data.trim() === "[DONE]") return;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw Object.assign(new Error("Provider sent an unreadable stream event."), { errorKind: "unreadable" as ErrorKind });
        }
        yield parsed;
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data);
        } catch {
          /* trailing garbage */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function callUpstream(opts: {
  candidate: Candidate;
  path: "/chat/completions" | "/completions" | "/embeddings";
  body: Record<string, unknown>;
  stream: boolean;
  apiKey?: string;
  appSecret?: string;
  signal: AbortSignal;
  timeoutMs: number;
  firstTokenTimeoutMs: number;
  production: boolean;
}): Promise<UpstreamResult> {
  const { candidate: c } = opts;
  const customHeaders = openProviderHeaders(opts.appSecret ?? "", c.provider.headers);
  const started = performance.now();
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(opts.signal.reason);
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const totalTimer = setTimeout(() => ctl.abort(new DOMException("timeout", "TimeoutError")), c.provider.timeoutMs ?? opts.timeoutMs);
  const cleanup = () => {
    clearTimeout(totalTimer);
    opts.signal.removeEventListener("abort", onAbort);
  };
  const elapsed = () => performance.now() - started;
  const fail = (errorKind: ErrorKind, message: string, status?: number): UpstreamFailure => {
    cleanup();
    return { ok: false, errorKind, message, status, latencyMs: elapsed() };
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: opts.stream ? "text/event-stream" : "application/json",
    ...customHeaders,
  };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  let res: Response;
  // Time-to-first-token applies to streams only: non-streaming providers send headers after generating.
  const firstTimer = opts.stream
    ? setTimeout(() => ctl.abort(new DOMException("first token timeout", "TimeoutError")), opts.firstTokenTimeoutMs)
    : undefined;
  try {
    res = await providerFetch(c.provider.baseUrl.replace(/\/$/, "") + opts.path, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify(opts.body),
      signal: ctl.signal,
    }, { production: opts.production, allowDevelopmentMockLoopback: !opts.production });
  } catch (e) {
    clearTimeout(firstTimer);
    if (opts.signal.aborted) {
      cleanup();
      throw e;
    }
    const timeout = (e as Error)?.name === "TimeoutError" || (ctl.signal.reason as Error)?.name === "TimeoutError";
    return fail(timeout ? "timeout" : "connection", timeout ? "Provider timed out." : "Provider could not be reached.");
  }
  if (!res.ok) {
    clearTimeout(firstTimer);
    const message = await errorMessage(res);
    return fail(classifyStatus(res.status), message, res.status);
  }

  if (!opts.stream) {
    try {
      const json = await res.json();
      clearTimeout(firstTimer);
      cleanup();
      return { ok: true, kind: "json", status: res.status, json, latencyMs: elapsed() };
    } catch (e) {
      clearTimeout(firstTimer);
      if (opts.signal.aborted) {
        cleanup();
        throw e;
      }
      const timeout = (ctl.signal.reason as Error)?.name === "TimeoutError";
      return fail(timeout ? "timeout" : "unreadable", timeout ? "Provider timed out." : "Provider returned unreadable JSON.");
    }
  }

  if (!res.body) {
    clearTimeout(firstTimer);
    return fail("unreadable", "Provider returned an empty stream.");
  }
  const events = parseSse(res.body, ctl.signal);
  // Wait for the first event so connection-level failures still allow fallback.
  let first: IteratorResult<any>;
  try {
    first = await events.next();
  } catch (e) {
    clearTimeout(firstTimer);
    if (opts.signal.aborted) {
      cleanup();
      throw e;
    }
    const kind: ErrorKind = (e as { errorKind?: ErrorKind }).errorKind ?? ((ctl.signal.reason as Error)?.name === "TimeoutError" ? "timeout" : "interrupted");
    return fail(kind, kind === "timeout" ? "Provider timed out before the first token." : "Provider stream failed.");
  }
  clearTimeout(firstTimer);
  if (first.done) return fail("empty200", "Provider stream ended without any event.");
  const latencyMs = elapsed();
  const wrapped = (async function* () {
    try {
      for await (const ev of events) yield ev;
    } finally {
      cleanup();
    }
  })();
  return { ok: true, kind: "stream", status: res.status, events: wrapped, first: first.value, latencyMs, abort: () => ctl.abort() };
}
