// K192: batch the catalogue's personal view without per-model reads or group limits.
import { sql } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import type { KeyRow } from '../api/auth.ts';
import { activityAccess } from '../activity/access.ts';
import { picoToUsdString } from '../lib/money.ts';
import { reliabilityPercent } from '../reliability/read.ts';
import { readSavings } from '../savings/read.ts';
import { savingsQuery } from '../savings/query.ts';

type UsedModel = { model: string; calls: string; succeeded: string; charged: string; refunded: string };
export async function readModelsUsed(ctx: Ctx, key: KeyRow, now = new Date()) {
  const range = savingsQuery({}, now);
  const { whole } = await activityAccess(ctx, key);
  // Activity's call boundary, including sessions, removed keys and conflicting account stamps.
  const visible = sql`((${whole} and g.account_id = ${key.accountId}) or (k.account_id = ${key.accountId} and (${whole} or g.key_hash = ${key.keyHash}))) and (g.account_id is null or g.account_id = ${key.accountId})`;
  const result = await ctx.db.execute(sql`with events as (
    select g.model_id model, 1 calls,
      (not g.cancelled and coalesce(g.finish_reason,'') not in ('error','cancelled'))::int succeeded,
      g.cost::numeric charged, 0::numeric refunded
    from generations g left join keys k on k.key_hash = g.key_hash
    where ${visible} and g.ts >= ${range.from}::timestamptz and g.ts < ${range.to}::timestamptz
    union all
    select g.model_id, 0, 0, 0, l.amount::numeric
    from ledger l left join keys k on k.key_hash = l.key_hash
      left join generations g on g.id = l.generation_id and (g.account_id = l.account_id or (g.account_id is null and g.key_hash = l.key_hash))
    where l.account_id = ${key.accountId} and (${whole} or l.key_hash = ${key.keyHash}) and l.kind = 'refund'
      and l.created_at >= ${range.from}::timestamptz and l.created_at < ${range.to}::timestamptz
  ) select model, sum(calls)::text calls, sum(succeeded)::text succeeded,
    sum(charged)::text charged, sum(refunded)::text refunded
    from events group by model having sum(calls) > 0
    order by sum(charged) - sum(refunded) desc, model collate "C"`);
  const rows = ((result as { rows?: UsedModel[] }).rows ?? result) as UsedModel[];
  await ctx.catalog.ensureFresh();
  const savings = await readSavings(ctx, key, range, { catalogReady: true });
  const suggestions = new Map(savings.models.map(row => [row.model, row.alternative]));
  return { scope: whole ? 'account' : 'key', ...range,
    data: rows.filter(row => { const model = ctx.catalog.models.get(row.model); return model && !model.hidden; }).map(row => ({
      model: row.model, calls: row.calls, succeeded: row.succeeded,
      charged_usd: picoToUsdString(BigInt(row.charged)), refunded_usd: picoToUsdString(BigInt(row.refunded)),
      cost_usd: picoToUsdString(BigInt(row.charged) - BigInt(row.refunded)),
      success_rate: reliabilityPercent(row.succeeded, row.calls), cheaper_option: suggestions.get(row.model) ?? null,
    })),
  };
}
