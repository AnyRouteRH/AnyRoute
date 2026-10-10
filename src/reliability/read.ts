import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { activityAccess } from "../activity/access.ts";
import type { reliabilityQuery } from "./query.ts";
type Raw = {
  dimension: string; model: string | null; calls: string; succeeded: string; route_recorded_calls: string; fallback_calls: string;
  ttft_samples: string; ttft_median: number | null; ttft_p95: number | null;
  total_samples: string; total_median: number | null; total_p95: number | null;
  refusal_decisions: string; lane: string; budget: string; rulebook: string;
};
// Round ratios to one decimal using integers; an empty denominator is unknown, never 100%.
export function reliabilityPercent(numerator: string, denominator: string) {
  const n = BigInt(numerator), d = BigInt(denominator);
  return d ? Number((n * 1000n + d / 2n) / d) / 10 : null;
}
export function reliabilityRow(r: Raw) {
  return {
    calls: r.calls, succeeded: r.succeeded, success_rate: reliabilityPercent(r.succeeded, r.calls),
    route_recorded_calls: r.route_recorded_calls, fallback_calls: r.fallback_calls,
    fallback_rate: reliabilityPercent(r.fallback_calls, r.route_recorded_calls),
    ...(BigInt(r.ttft_samples) ? { time_to_first_token_ms: { samples: r.ttft_samples, median: Number(r.ttft_median), p95: Number(r.ttft_p95) } } : {}),
    ...(BigInt(r.total_samples) ? { total_latency_ms: { samples: r.total_samples, median: Number(r.total_median), p95: Number(r.total_p95) } } : {}),
    refusals: { decisions: r.refusal_decisions, lane: r.lane, budget: r.budget, rulebook: r.rulebook },
  };
}
export async function readReliability(ctx: Ctx, key: KeyRow, q: ReturnType<typeof reliabilityQuery>) {
  const { whole } = await activityAccess(ctx, key);
  const visible = sql`((${whole} and g.account_id = ${key.accountId}) or (k.account_id = ${key.accountId} and (${whole} or g.key_hash = ${key.keyHash}))) and (g.account_id is null or g.account_id = ${key.accountId})`;
  // Keep Activity's separate team boundary for agent decisions, including management/session restrictions.
  const agents = sql`k.account_id = ${key.accountId} and (${whole} or k.key_hash = ${key.keyHash}) and (${!whole || key.management} or k.team_id = ${key.teamId})`;
  const result = await ctx.db.execute(sql`with calls as (
    select g.model_id model, not g.cancelled and coalesce(g.finish_reason,'') not in ('error','cancelled') succeeded,
      coalesce(g.receipt->'route',g.receipt_v2->'route') route,
      case when g.streamed and g.latency_ms >= 0 and g.mode <> 'cache' then g.latency_ms end ttft,
      case when g.generation_time_ms >= 0 then g.generation_time_ms end total
    from generations g left join keys k on k.key_hash = g.key_hash
    where g.ts >= ${q.from}::timestamptz and g.ts < ${q.to}::timestamptz and ${visible}
  ), refusals as (
    select e.intent->>'model' model,
      bool_or(r->>'code' = 'lane_not_allowed') lane,
      bool_or(r->>'code' in ('over_per_request','over_per_hour','over_per_day','over_per_week','breaker:max_spend_usd_per_minute')) budget,
      bool_or(coalesce(r->>'code','') not in ('lane_not_allowed','over_per_request','over_per_hour','over_per_day','over_per_week','breaker:max_spend_usd_per_minute')) rulebook
    from agent_policy_events e join keys k on k.key_hash = e.key_hash
      left join lateral jsonb_array_elements(case when jsonb_typeof(e.reasons) = 'array' then e.reasons else '[]'::jsonb end) r on true
    where ${ctx.cfg.agentPolicyEnabled} and ${agents} and e.ts >= ${q.from}::timestamptz and e.ts < ${q.to}::timestamptz
      and e.kind = 'decision' and e.decision = 'deny' and e.intent->>'kind' = 'inference'
    group by e.id, e.intent->>'model'
  ), events as (
    select model, 1 calls, succeeded::int succeeded,
      (jsonb_typeof(route) = 'object')::int route_recorded,
      (jsonb_typeof(route) = 'object' and route->>'reason' = 'fallback')::int fallback,
      ttft, total, 0 refusal, 0 lane, 0 budget, 0 rulebook from calls
    union all select model, 0, 0, 0, 0, null, null, 1, coalesce(lane,false)::int, coalesce(budget,false)::int, coalesce(rulebook,false)::int from refusals
  ) select case when grouping(model) = 1 then 'total' else 'model' end dimension, model,
    coalesce(sum(calls),0)::text calls, coalesce(sum(succeeded),0)::text succeeded,
    coalesce(sum(route_recorded),0)::text route_recorded_calls, coalesce(sum(fallback),0)::text fallback_calls,
    count(ttft)::text ttft_samples, percentile_cont(0.5) within group (order by ttft) ttft_median, percentile_cont(0.95) within group (order by ttft) ttft_p95,
    count(total)::text total_samples, percentile_cont(0.5) within group (order by total) total_median, percentile_cont(0.95) within group (order by total) total_p95,
    coalesce(sum(refusal),0)::text refusal_decisions, coalesce(sum(lane),0)::text lane, coalesce(sum(budget),0)::text budget, coalesce(sum(rulebook),0)::text rulebook
    from events group by grouping sets ((),(model)) order by dimension desc, sum(calls) desc, model collate "C"`);
  const rows = ((result as { rows?: Raw[] }).rows ?? result) as Raw[];
  return { scope: whole ? "account" : "key", ...q, totals: reliabilityRow(rows.find(r => r.dimension === "total")!),
    models: rows.filter(r => r.dimension === "model").map(r => ({ model: r.model, ...reliabilityRow(r) })) };
}
