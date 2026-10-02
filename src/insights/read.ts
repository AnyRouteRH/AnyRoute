import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { activityAccess } from "../activity/access.ts";
import { picoToUsdString } from "../lib/money.ts";
import type { InsightsQuery } from "./query.ts";
export type InsightRaw = { dimension: string; id: string | null; label: string | null; charged: string; refunded: string; calls: string; proven: string; tokens_in: string; tokens_out: string; lanes: string[]; disclosures: string[]; cost_rank: number; calls_rank: number };
export function insightRow(r: InsightRaw) {
  const net = BigInt(r.charged) - BigInt(r.refunded), calls = BigInt(r.calls);
  return { id: r.id, label: r.label, charged_usd: picoToUsdString(BigInt(r.charged)), refunded_usd: picoToUsdString(BigInt(r.refunded)), cost_usd: picoToUsdString(net), calls: r.calls,
    proven_calls: r.proven, tokens_in: r.tokens_in, tokens_out: r.tokens_out, lanes: r.lanes ?? [], disclosures: r.disclosures ?? [],
    average_cost_usd: calls ? picoToUsdString(net / calls) : null,
    average_cost_ratio: { numerator_usd: picoToUsdString(net), denominator: r.calls } };
}
export async function readInsights(ctx: Ctx, key: KeyRow, q: InsightsQuery) {
  const { whole } = await activityAccess(ctx, key);
  // Existing gen_key_ts_idx / gen_ts_idx and ledger_account_idx bound the two sources before grouping.
  // A deleted key's account-stamped generations stay visible to account managers, as in Activity.
  const visible = sql`((${whole} and g.account_id = ${key.accountId}) or (k.account_id = ${key.accountId} and (${whole} or g.key_hash = ${key.keyHash}))) and (g.account_id is null or g.account_id = ${key.accountId})`;
  const result = await ctx.db.execute(sql`with events as (
    select g.ts at, g.model_id model, g.key_hash key_id, coalesce(nullif(k.name,''),k.label,'Removed key') label,
      coalesce(g.receipt->>'lane',g.receipt_v2->>'lane','unknown') lane,
      coalesce(g.receipt->>'disclosure',g.receipt_v2->>'disclosure','unknown') disclosure,
      g.cost::numeric charged, 0::numeric refunded, 1::numeric calls, g.tokens_in::numeric tokens_in, g.tokens_out::numeric tokens_out,
      case when g.mode <> 'cache' and g.provider_id <> 'cache' and g.receipt->>'disclosure' = 'attested'
        and nullif(g.receipt_sig,'') is not null and coalesce(g.receipt->>'attestation_simulated','false') = 'false'
        and coalesce(g.receipt->>'last_attempt_ok','true') <> 'false'
        and coalesce(g.receipt->>'status','attested') not in ('unverified','failed','stale','simulated','revoked')
        and coalesce(g.receipt->>'failed','false') = 'false' and coalesce(g.receipt->>'stale','false') = 'false'
        and (not (g.receipt ? 'upstream_attestation') or (g.receipt->'upstream_attestation'->>'attested' = 'true'
          and coalesce(g.receipt->'upstream_attestation'->>'last_attempt_ok','true') <> 'false'
          and coalesce(g.receipt->'upstream_attestation'->>'status','attested') not in ('unverified','failed','stale','simulated','revoked')
          and coalesce(g.receipt->'upstream_attestation'->>'failed','false') = 'false' and coalesce(g.receipt->'upstream_attestation'->>'stale','false') = 'false'))
        then 1::numeric else 0::numeric end proven
    from generations g left join keys k on k.key_hash = g.key_hash
    where g.ts >= ${q.from}::timestamptz and g.ts < ${q.to}::timestamptz and ${visible}
    union all
    select l.created_at, g.model_id, l.key_hash, coalesce(nullif(k.name,''),k.label,'Removed key'),
      coalesce(g.receipt->>'lane',g.receipt_v2->>'lane','unknown'), coalesce(g.receipt->>'disclosure',g.receipt_v2->>'disclosure','unknown'), 0, l.amount::numeric, 0, 0, 0, 0
    from ledger l left join keys k on k.key_hash = l.key_hash
      left join generations g on g.id = l.generation_id and (g.account_id = l.account_id or (g.account_id is null and g.key_hash = l.key_hash))
    where l.account_id = ${key.accountId} and (${whole} or l.key_hash = ${key.keyHash}) and l.kind = 'refund'
      and l.created_at >= ${q.from}::timestamptz and l.created_at < ${q.to}::timestamptz
  ), grouped as (
    select case when grouping(bucket) = 0 then 'time' when grouping(model) = 0 then 'model'
      when grouping(key_id) = 0 then 'key' when grouping(lane) = 0 then 'lane' else 'total' end dimension,
      coalesce(bucket, model, key_id, lane) id, case when grouping(key_id) = 0 then max(label) else null end label,
      coalesce(sum(charged),0)::text charged, coalesce(sum(refunded),0)::text refunded, coalesce(sum(calls),0)::text calls, coalesce(sum(proven),0)::text proven,
      coalesce(sum(tokens_in),0)::text tokens_in, coalesce(sum(tokens_out),0)::text tokens_out, array_agg(distinct lane) filter(where calls > 0) lanes, array_agg(distinct disclosure) filter(where calls > 0) disclosures
    from (select *, to_char(date_trunc(${q.bucket},at at time zone 'UTC'),'YYYY-MM-DD') bucket from events) e
    group by grouping sets ((),(bucket),(model),(key_id),(lane))
  ), ranked as (
    select *, row_number() over(partition by dimension order by (charged::numeric-refunded::numeric) desc,id collate "C") cost_rank,
      row_number() over(partition by dimension order by calls::numeric desc,id collate "C") calls_rank from grouped
  ) select * from ranked where dimension in ('total','time','lane') or cost_rank <= 100 or calls_rank <= 100`);
  const rows = ((result as { rows?: InsightRaw[] }).rows ?? result) as InsightRaw[];
  const select = (dimension: string) => rows.filter(r => r.dimension === dimension).sort((a,b) => a.cost_rank - b.cost_rank);
  const models = select('model');
  return { scope: whole ? 'account' : 'key', from: q.from, to: q.to, bucket: q.bucket, currency: 'USDG',
    totals: insightRow(select('total')[0]), series: select('time').sort((a,b) => (a.id ?? '').localeCompare(b.id ?? '')).map(insightRow),
    models: models.map(insightRow), keys: select('key').map((r,i) => ({ ...insightRow(r), id: String(i) })), lanes: select('lane').map(insightRow),
    top_models_by_cost: models.slice(0,5).map(insightRow), top_models_by_calls: [...models].sort((a,b) => a.calls_rank-b.calls_rank).slice(0,5).map(insightRow),
    group_limit: 100, average_rounding: 'toward zero to 12 decimal places; exact ratio included' };
}
