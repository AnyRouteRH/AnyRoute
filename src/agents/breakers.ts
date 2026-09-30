import { z } from "zod";
import { usdToPico } from "../lib/money.ts";

const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const agentBreakersSchema = z.strictObject({
  max_spend_usd_per_minute: z.number().positive().max(1_000_000).optional(),
  max_requests_per_minute: count.optional(),
  max_denials_per_10min: count.optional(),
  max_distinct_models_per_hour: count.optional(),
});
export type AgentBreakers = z.infer<typeof agentBreakersSchema>;
export type BreakerState = { spent_minute_pico: bigint; requests_minute: number; denials_10min: number; distinct_models_hour: number; models_hour?: string[]; requested_models?: string[] };
export type BreakerReasonCode = `breaker:${keyof AgentBreakers}`;
export const breakerMessages: Record<BreakerReasonCode, string> = {
  "breaker:max_spend_usd_per_minute": "The rolling minute spend breaker has tripped.",
  "breaker:max_requests_per_minute": "The rolling minute request breaker has tripped.",
  "breaker:max_denials_per_10min": "The rolling ten-minute denial breaker has tripped.",
  "breaker:max_distinct_models_per_hour": "The rolling hour distinct-model breaker has tripped.",
};
/** Inclusive thresholds over recorded observations, before admitting another request. */
export function breakerReasons(limits: AgentBreakers | undefined, state: BreakerState | undefined, killed: boolean, estimate = 0n, model?: string) {
  if (!limits || killed || !Object.keys(limits).length) return [];
  if (!state) throw new Error("Breaker state is required for a rulebook with breakers.");
  const tripped: BreakerReasonCode[] = [];
  if (limits.max_spend_usd_per_minute !== undefined && (state.spent_minute_pico >= usdToPico(limits.max_spend_usd_per_minute) || state.spent_minute_pico + estimate > usdToPico(limits.max_spend_usd_per_minute))) tripped.push("breaker:max_spend_usd_per_minute");
  if (limits.max_requests_per_minute !== undefined && state.requests_minute >= limits.max_requests_per_minute) tripped.push("breaker:max_requests_per_minute");
  if (limits.max_denials_per_10min !== undefined && state.denials_10min >= limits.max_denials_per_10min) tripped.push("breaker:max_denials_per_10min");
  if (limits.max_distinct_models_per_hour !== undefined && (state.distinct_models_hour >= limits.max_distinct_models_per_hour || (state.models_hour !== undefined && new Set([...state.models_hour, ...(state.requested_models ?? []), ...(model ? [model] : [])]).size > limits.max_distinct_models_per_hour))) tripped.push("breaker:max_distinct_models_per_hour");
  return tripped.map(code => ({ code, message: breakerMessages[code] }));
}
export const breakerKillReason = (decision: { reasons: { code: string }[] }) => decision.reasons.find(r => r.code.startsWith("breaker:"))?.code;
