import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { activityAccess } from "../activity/access.ts";
import type { savingsQuery } from "./query.ts";
import { savingsSuggestion, type SavingsMix } from "./suggest.ts";
export async function readSavings(ctx: Ctx, key: KeyRow, q: ReturnType<typeof savingsQuery>, options: { teamOnly?: boolean; catalogReady?: boolean } = {}) {
  const { whole } = await activityAccess(ctx, key);
  // Exactly Activity's call visibility, including deleted-key account stamps and session restrictions.
  const visible = sql`((${whole} and g.account_id = ${key.accountId}) or (k.account_id = ${key.accountId} and (${whole} or g.key_hash = ${key.keyHash}))) and (g.account_id is null or g.account_id = ${key.accountId})`;
  const result = await ctx.db.execute(sql`select g.model_id model, count(*)::text calls,
    sum(g.tokens_in)::text tokens_in, sum(g.tokens_out)::text tokens_out, sum(g.cost)::text charged_pico,
    max(g.tokens_in::bigint + g.tokens_out)::float8 max_tokens, max(g.tokens_out) max_output,
    bool_and(g.tokens_in >= 0 and g.tokens_out >= 0 and g.reasoning_tokens = 0 and g.cached_tokens = 0 and g.cache_write_tokens = 0
      and g.mode in ('prepaid','per_call','paywith') and not g.is_byok and not g.private
      and coalesce(g.receipt->>'lane',g.receipt_v2->>'lane') is not null
      and coalesce(g.receipt->>'disclosure',g.receipt_v2->>'disclosure') is not null) safe,
    array_agg(distinct coalesce(g.receipt->>'lane',g.receipt_v2->>'lane')) lanes,
    array_agg(distinct coalesce(g.receipt->>'disclosure',g.receipt_v2->>'disclosure')) disclosures
    from generations g left join keys k on k.key_hash = g.key_hash
    where ${visible} and (${!options.teamOnly} or k.team_id = ${key.teamId}) and g.cost > 0 and g.ts >= ${q.from}::timestamptz and g.ts < ${q.to}::timestamptz
    group by g.model_id order by g.model_id`);
  const rows = ((result as { rows?: SavingsMix[] }).rows ?? result) as SavingsMix[];
  if (!options.catalogReady) await ctx.catalog.ensureFresh();
  const models = rows.flatMap(mix => { const suggestion = savingsSuggestion(ctx, mix, new Set(key.allowedModels ?? [])); return suggestion ? [suggestion] : []; });
  return { scope: whole ? "account" : "key", ...q, priced_at: new Date(ctx.catalog.loadedAt).toISOString(),
    estimate: "Same tokens at current catalogue token and request prices. Excludes refunds, cache discounts, royalties, account fees and extra media, reasoning or search charges. Routing and future usage can change the cost. This does not claim equal quality.", models };
}
