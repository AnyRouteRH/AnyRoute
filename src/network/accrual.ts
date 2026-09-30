import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { generations, hostAnchorLeaves, hostAnchors, providers, settlements } from "../db/schema.ts";
import { picoToUsdg } from "../lib/money.ts";
import { networkFeeLedger, networkReceiptLinks } from "./payout-schema.ts";
export const networkPeriod = (now: Date) => now.toISOString().slice(0, 13);
export function networkFee(gross: bigint, bps: number) {
  if (gross < 0n || !Number.isInteger(bps) || bps < 0 || bps > 2000) throw new Error("Invalid network fee inputs.");
  const fee = gross * BigInt(bps) / 10_000n;
  return { gross, fee, net: gross - fee };
}
/** Invoice in the accrual hour, so late confirmations cannot alter an already paid period.
 * Network costs never enter curated-provider invoices, even while payouts are disabled.
 * Signature/leaf validation belongs to host-anchor; this joins its confirmed per-host leaves. */
export async function accrueNetworkHours(ctx: Ctx, now = new Date()) {
  const hosts = await ctx.db.select({ id: providers.id }).from(providers).where(eq(providers.networkHost, true));
  if (!ctx.cfg.networkPayouts.enabled) return new Set(hosts.map(p => p.id));
  const period = networkPeriod(now);
  for (const host of hosts) await ctx.db.transaction(async tx => {
    const [p] = await tx.select().from(providers).where(eq(providers.id, host.id)).for("update");
    if (p.payoutMode !== "usdg") return;
    const rows = await tx.select({ id: generations.id, upstream: generations.upstreamCost, tokensIn: generations.tokensIn, tokensOut: generations.tokensOut })
      .from(networkReceiptLinks).innerJoin(generations, and(eq(generations.id, networkReceiptLinks.generationId), eq(generations.providerId, networkReceiptLinks.providerId)))
      .where(and(eq(networkReceiptLinks.providerId, p.id), isNull(networkReceiptLinks.accruedPeriod), lt(generations.ts, new Date(period + ":00:00.000Z")), sql`${generations.mode} not in ('cache','byok')`, sql`exists (select 1 from ${hostAnchorLeaves} l join ${hostAnchors} a on a.id = l.anchor_id where l.provider_id = ${p.id} and l.receipt_id = ${networkReceiptLinks.receiptId} and a.provider_id = ${p.id} and a.status = 'confirmed' and a.tx_hash is not null)`));
    if (!rows.length) return;
    const [previous] = await tx.select().from(networkFeeLedger).where(and(eq(networkFeeLedger.providerId, p.id), eq(networkFeeLedger.period, period)));
    const [invoice] = await tx.select().from(settlements).where(and(eq(settlements.providerId, p.id), eq(settlements.period, period)));
    if ((previous && previous.status !== "accrued") || invoice?.payoutId || (invoice && !previous)) throw new Error("Network accrual period is already closed or contains a legacy invoice.");
    const gross = (previous?.grossPico ?? 0n) + rows.reduce((n, g) => n + g.upstream, 0n);
    const { fee, net } = networkFee(gross, ctx.cfg.networkPayouts.feeBps);
    await tx.insert(networkFeeLedger).values({ id: `${p.id}|${period}`, providerId: p.id, period, grossPico: gross, feePico: fee }).onConflictDoUpdate({ target: [networkFeeLedger.providerId, networkFeeLedger.period], set: { grossPico: gross, feePico: fee } });
    await tx.insert(settlements).values({ providerId: p.id, period, upstream: gross, fee, usdgOwed: picoToUsdg(net, "floor"), tokens: (invoice?.tokens ?? 0n) + rows.reduce((n, g) => n + BigInt(g.tokensIn + g.tokensOut), 0n), requests: (invoice?.requests ?? 0) + rows.length })
      .onConflictDoUpdate({ target: [settlements.providerId, settlements.period], set: { upstream: gross, fee, usdgOwed: picoToUsdg(net, "floor"), tokens: sql`${settlements.tokens} + ${rows.reduce((n, g) => n + BigInt(g.tokensIn + g.tokensOut), 0n)}`, requests: sql`${settlements.requests} + ${rows.length}` } });
    await tx.update(networkReceiptLinks).set({ accruedPeriod: period }).where(inArray(networkReceiptLinks.generationId, rows.map(g => g.id)));
  });
  return new Set(hosts.map(p => p.id));
}
