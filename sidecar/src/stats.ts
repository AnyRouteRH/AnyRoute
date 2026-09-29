import { DpStats, type DpStatsOptions, type Observation } from "./dpstats.ts";

// The sidecar's only telemetry: differentially private hourly counters (see dpstats.ts). There is no per-request
// log line; the handler records each inference request once, here, and GET /v1/stats serves the noisy hours.

/** Request kinds, by route. */
export const REQUEST_KINDS = ["chat_completions", "embeddings"] as const;

/** Why a request was refused. Fixed and public: every label is released every hour, even at zero. */
export const BLOCK_REASONS = ["content_request", "content_response", "unsupported_input", "too_large", "check_unavailable", "rate_limited", "unauthorized", "invalid_request", "upstream_error"] as const;

/** Map an error code the sidecar answered with to a block reason. */
export function blockReason(code: string, status: number): string {
  switch (code) {
    case "content_request":
    case "content_response":
    case "unsupported_input":
      return code;
    case "content_too_large":
    case "request_too_large":
    case "upstream_response_too_large":
      return "too_large";
    case "content_check_unavailable":
      return "check_unavailable";
    case "rate_limit_exceeded":
      return "rate_limited";
    case "invalid_api_key":
      return "unauthorized";
  }
  if (code.startsWith("upstream_") || status >= 500) return "upstream_error";
  return "invalid_request";
}

export type StatsConfig = { epsilon: NonNullable<DpStatsOptions["epsilon"]>; retentionHours: number; dailyEpsilonCap: number | null };

export function createSidecarStats(cfg: StatsConfig, now: () => number = Date.now): DpStats {
  return new DpStats({ requestKinds: REQUEST_KINDS, blockReasons: BLOCK_REASONS, epsilon: cfg.epsilon, retentionHours: cfg.retentionHours, dailyEpsilonCap: cfg.dailyEpsilonCap, now });
}

/**
 * One request's contribution, gathered while it runs and handed to the counters exactly once. A stream is recorded
 * when it ends (or is cancelled); everything else when the handler returns.
 */
export class Tally {
  private readonly o: Observation;
  private done = false;
  /** Set by the proxy when the response is a stream that records itself when it ends. */
  deferred = false;
  constructor(
    private readonly stats: DpStats,
    kind: string,
    private readonly started: number,
    private readonly now: () => number = Date.now,
  ) {
    this.o = { kind };
  }
  tokens(n: number | null | undefined) {
    if (typeof n === "number") this.o.tokens = n;
  }
  block(reason: string) {
    this.o.blocked ??= reason;
  }
  finish() {
    if (this.done) return;
    this.done = true;
    this.o.latencyMs = this.now() - this.started;
    this.stats.observe(this.o);
  }
}
