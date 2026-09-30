import { forwardNetworkReceipt } from "../network/receipt-link.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { callUpstream, type ErrorKind, upstreamBody, type UpstreamFailure } from "../providers/upstream.ts";
import type { HealthTracker } from "../services/health.ts";
import type { AciExchange } from "../providers/aci.ts";

// Try providers in order, falling back on 5xx / timeout / connection / 429 / provider-auth /
// provider-side rejections / empty-200s. For streams, events are buffered until the first
// meaningful delta so that an empty or broken stream can still fall back invisibly.

export type Attempt = { provider: string; model: string; ok: boolean; error_kind?: ErrorKind; status?: number; latency_ms: number; message?: string };

export type RouteTarget = { model: ModelRow; ordered: Candidate[] };

/** `exchange` is set when the candidate is an attested aci/1 gateway (providers/aci.ts). */
export type RouteSuccess =
  | { ok: true; kind: "json"; candidate: Candidate; model: ModelRow; json: any; latencyMs: number; attempts: Attempt[]; dropped: string[]; exchange?: AciExchange }
  | {
      ok: true;
      kind: "stream";
      candidate: Candidate;
      model: ModelRow;
      buffered: any[];
      rest: AsyncGenerator<any>;
      latencyMs: number;
      attempts: Attempt[];
      abort: () => void;
      dropped: string[];
      exchange?: AciExchange;
    };
export type RouteFailure = { ok: false; attempts: Attempt[]; last?: UpstreamFailure };

/** Empty-200: content in {null, ""} with no tool calls, and finish_reason not length/content_filter. */
export function isEmptyCompletion(json: any, stopRequested = false): boolean {
  const choices = json?.choices;
  if (!Array.isArray(choices) || !choices.length) return true;
  return choices.every((ch: any) => {
    const msg = ch?.message ?? {};
    const text = ch?.text; // legacy completions
    const hasContent = (typeof msg.content === "string" && msg.content.length > 0) || (Array.isArray(msg.content) && msg.content.length > 0) || (typeof text === "string" && text.length > 0);
    const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
    const finish = ch?.finish_reason;
    // An empty answer that ended on a caller-supplied stop sequence is a legitimate answer.
    if (stopRequested && finish === "stop") return false;
    return !hasContent && !hasTools && !hasImages && finish !== "length" && finish !== "content_filter";
  });
}

export function meaningfulDelta(ev: any): boolean {
  if (ev?.error) return false;
  for (const ch of ev?.choices ?? []) {
    const d = ch?.delta ?? {};
    if (typeof d.content === "string" && d.content.length) return true;
    if (typeof ch?.text === "string" && ch.text.length) return true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true;
    if ((typeof d.reasoning === "string" && d.reasoning.length) || (typeof d.reasoning_content === "string" && d.reasoning_content.length)) return true;
    if (Array.isArray(d.images) && d.images.length) return true;
    if (ch?.finish_reason === "length" || ch?.finish_reason === "content_filter") return true;
  }
  return false;
}

export async function route(opts: {
  targets: RouteTarget[];
  path: "/chat/completions" | "/completions";
  body: Record<string, unknown>;
  stream: boolean;
  appSecret?: string;
  keyFor: (c: Candidate) => string | undefined;
  signal: AbortSignal;
  health: HealthTracker;
  maxAttempts: number;
  timeoutMs: number;
  firstTokenTimeoutMs: number;
  production: boolean;
  caller?: string | null;
}): Promise<RouteSuccess | RouteFailure> {
  const stopRequested = opts.body.stop != null && !(Array.isArray(opts.body.stop) && opts.body.stop.length === 0);
  const attempts: Attempt[] = [];
  let last: UpstreamFailure | undefined;
  // Retry pass: providers that failed with a response proving they never accepted the request
  // (429 / 5xx) get one more try after a short backoff. Timeouts and interrupted streams are never
  // retried — the provider may have done (and billed) the work.
  const retryable = new Set<ErrorKind>(["rate_limited", "http_5xx", "connection"]);
  const passes: RouteTarget[][] = [opts.targets];
  for (let pass = 0; pass < passes.length; pass++) {
    if (pass === 1) await new Promise((r) => setTimeout(r, 250));
  for (const target of passes[pass]) {
    for (const c of target.ordered) {
      if (attempts.length >= opts.maxAttempts) return { ok: false, attempts, last };
      const { body, dropped } = upstreamBody(c, opts.body, opts.stream);
      const r = await callUpstream({
        candidate: c,
        path: opts.path,
        body,
        stream: opts.stream,
        apiKey: opts.keyFor(c),
        appSecret: opts.appSecret,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        firstTokenTimeoutMs: opts.firstTokenTimeoutMs,
        production: opts.production,
      });
      const failed = (f: UpstreamFailure) => {
        last = f;
        attempts.push({ provider: c.providerId, model: target.model.id, ok: false, error_kind: f.errorKind, status: f.status, latency_ms: Math.round(f.latencyMs), message: f.message });
        opts.health.record({ modelId: c.modelId, providerId: c.providerId, ok: false, errorKind: f.errorKind, statusCode: f.status ?? null, latencyMs: f.latencyMs, empty200: f.errorKind === "empty200", source: "traffic", caller: opts.caller ?? null });
      };
      if (!r.ok) {
        failed(r);
        continue;
      }
      if (r.kind === "json") {
        if (r.json?.error && !r.json?.choices) {
          failed({ ok: false, errorKind: "http_5xx", status: r.status, message: String(r.json.error?.message ?? "provider error"), latencyMs: r.latencyMs });
          continue;
        }
        if (isEmptyCompletion(r.json, stopRequested)) {
          failed({ ok: false, errorKind: "empty200", status: 200, message: "Provider returned HTTP 200 with empty content.", latencyMs: r.latencyMs });
          continue;
        }
        attempts.push({ provider: c.providerId, model: target.model.id, ok: true, status: r.status, latency_ms: Math.round(r.latencyMs) });
        return forwardNetworkReceipt({ ok: true, kind: "json", candidate: c, model: target.model, json: r.json, latencyMs: r.latencyMs, attempts, dropped, ...(r.exchange ? { exchange: r.exchange } : {}) }, r);
      }
      // Stream: buffer until something meaningful arrives.
      const buffered: any[] = [r.first];
      let meaningful = meaningfulDelta(r.first);
      let streamError: UpstreamFailure | null = r.first?.error
        ? { ok: false, errorKind: "http_5xx", status: 200, message: String(r.first.error?.message ?? "stream error"), latencyMs: r.latencyMs }
        : null;
      const started = performance.now();
      while (!meaningful && !streamError) {
        let next: IteratorResult<any>;
        try {
          next = await r.events.next();
        } catch (e) {
          if (opts.signal.aborted) throw e;
          streamError = { ok: false, errorKind: (e as { errorKind?: ErrorKind }).errorKind ?? "interrupted", message: "Provider stream failed before content.", latencyMs: r.latencyMs + (performance.now() - started) };
          break;
        }
        if (next.done) break;
        if (next.value?.error) {
          streamError = { ok: false, errorKind: "http_5xx", status: 200, message: String(next.value.error?.message ?? "stream error"), latencyMs: r.latencyMs };
          break;
        }
        buffered.push(next.value);
        meaningful = meaningfulDelta(next.value);
      }
      if (!meaningful && stopRequested && buffered.some((ev) => ev?.choices?.some((ch: any) => ch?.finish_reason === "stop"))) meaningful = true;
      if (!meaningful) {
        r.abort();
        failed(streamError ?? { ok: false, errorKind: "empty200", status: 200, message: "Provider stream completed with empty content.", latencyMs: r.latencyMs + (performance.now() - started) });
        continue;
      }
      const ttft = r.latencyMs + (performance.now() - started);
      attempts.push({ provider: c.providerId, model: target.model.id, ok: true, status: r.status, latency_ms: Math.round(ttft) });
      return forwardNetworkReceipt({ ok: true, kind: "stream", candidate: c, model: target.model, buffered, rest: r.events, latencyMs: ttft, attempts, abort: r.abort, dropped, ...(r.exchange ? { exchange: r.exchange } : {}) }, r);
    }
  }
    if (pass === 0 && attempts.length < opts.maxAttempts) {
      const again = opts.targets
        .map((t) => ({ model: t.model, ordered: t.ordered.filter((c) => attempts.some((a) => a.provider === c.providerId && a.model === t.model.id && a.error_kind && retryable.has(a.error_kind))) }))
        .filter((t) => t.ordered.length);
      if (again.length) passes.push(again);
    }
  }
  return { ok: false, attempts, last };
}
