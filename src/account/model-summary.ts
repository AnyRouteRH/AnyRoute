// J178: compose existing readers; no additional persistence or background work.
import type { Ctx } from '../context.ts';
import type { KeyRow } from '../api/auth.ts';
import { activityAccess } from '../activity/access.ts';
import { readInsights } from '../insights/read.ts';
import { insightsQuery } from '../insights/query.ts';
import { readReliability } from '../reliability/read.ts';
import { reliabilityQuery } from '../reliability/query.ts';
import { readSavings } from '../savings/read.ts';
import { savingsQuery } from '../savings/query.ts';
import { priceNoticeItems } from '../catalog/price-notices.ts';
import { channelEnabled } from '../notifications/prefs.ts';
import { fail } from '../lib/errors.ts';

export async function readModelSummary(ctx: Ctx, key: KeyRow, id: string, now = new Date()) {
  await ctx.catalog.ensureFresh();
  const model = ctx.catalog.models.get(id);
  if (!model || model.hidden) fail(404, 'Model not found.', 'not_found');
  const range = savingsQuery({}, now);
  const usage = await readInsights(ctx, key, insightsQuery({ from: range.from, to: range.to }), id);
  const reliability = await readReliability(ctx, key, reliabilityQuery({}, now));
  const savings = await readSavings(ctx, key, range);
  const { session } = await activityAccess(ctx, key);
  const noticesAllowed = key.management && !session && await channelEnabled(ctx, key.accountId, 'price_notices', 'inbox');
  const notice = noticesAllowed ? (await priceNoticeItems(ctx, key.accountId, range.to, range.from)).find(item => item.model === id) : null;
  const recorded = reliability.models.find(row => row.model === id);
  return {
    model: id, scope: usage.scope,
    usage: { days: 30, from: range.from, to: range.to, calls: usage.totals.calls, charged_usd: usage.totals.charged_usd, refunded_usd: usage.totals.refunded_usd, cost_usd: usage.totals.cost_usd },
    reliability: { days: reliability.days, from: reliability.from, to: reliability.to, calls: recorded?.calls ?? '0', succeeded: recorded?.succeeded ?? '0', success_rate: recorded?.success_rate ?? null },
    savings: savings.models.find(row => row.model === id) ?? null,
    price_notice: notice ? { at: notice.at, title: notice.title } : null,
    price_notices_visible: !!noticesAllowed && ctx.cfg.priceNoticesEnabled,
  };
}
