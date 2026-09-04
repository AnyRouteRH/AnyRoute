import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { callUpstream, type ErrorKind, upstreamBody, type UpstreamFailure } from "../providers/upstream.ts";
import type { HealthTracker } from "../services/health.ts";

// Try providers in order, falling back on 5xx / timeout / connection / 429 / provider-auth /
// provider-side rejections / empty-200s. For streams, events are buffered until the first
// meaningful delta so that an empty or broken stream can still fall back invisibly.

export type Attempt = { provider: string; model: string; ok: boolean; error_kind?: ErrorKind; status?: number; latency_ms: number; message?: string };

export type RouteTarget = { model: ModelRow; ordered: Candidate[] };

export type RouteSuccess =
  | { ok: true; kind: "json"; candidate: Candidate; model: ModelRow; json: any; latencyMs: number; attempts: Attempt[]; dropped: string[] }
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
