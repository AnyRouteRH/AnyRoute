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
