import { and, asc, eq, lt, ne } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { PICO_PER_USDG_UNIT } from "../lib/money.ts";
import { quoteNetworkBurn } from "./burn-quote.ts";
import { networkPeriod } from "./accrual.ts";
import { burnOperationId, networkBurnChain, type BurnChain } from "./burn-chain.ts";
import { networkFeeLedger } from "./payout-schema.ts";
/** Closed accrual periods only. Each ledger id is also the on-chain idempotency key.
 * Fee subunits below one USDG unit remain in the ledger; no rounding-up spends host funds. */
export async function runNetworkFeeBurn(ctx: Ctx, deps: { chain?: BurnChain; quote?: typeof quoteNetworkBurn } = {}) {
  if (!ctx.cfg.networkPayouts.burnEnabled) return { skipped: "network fee burn disabled" };
  const chain = deps.chain ?? networkBurnChain(ctx);
  const rows = await ctx.db.select().from(networkFeeLedger).where(and(ne(networkFeeLedger.status, "burned"), lt(networkFeeLedger.period, networkPeriod(new Date())))).orderBy(asc(networkFeeLedger.createdAt));
  let burned = 0;
  let spent = 0n;
  const cap = BigInt(Math.floor(ctx.cfg.buyback.maxPerRunUsd * 1e6));
  for (const row of rows) {
    const id = burnOperationId(row.id);
    const usdg = row.feePico / PICO_PER_USDG_UNIT;
    if (!usdg) continue;
    let op = await chain.operation(id);
    if (!op.usdgIn) {
      if (row.status !== "accrued" || row.swapTx) throw new Error("Network fee chain/database mismatch; reconcile before proceeding.");
      if (usdg > cap - spent || usdg > await chain.remaining()) continue;
      const quote = await (deps.quote ?? quoteNetworkBurn)(ctx, { quoteOnly: usdg });
      if (!quote.quoted || quote.minOut === undefined) return { burned, skipped: quote.skipped ?? "buyback quote unavailable" };
      await chain.swap(id, usdg, quote.minOut);
      spent += usdg;
      op = await chain.operation(id);
    }
    if (op.usdgIn !== usdg || !op.swapTx || op.amount <= 0n) throw new Error("Network fee swap does not reconcile with its accrual.");
    await ctx.db.update(networkFeeLedger).set({ status: op.burned ? "burned" : "swapped", swapTx: op.swapTx, anyrAmount: op.amount, burnTx: op.burnTx }).where(eq(networkFeeLedger.id, row.id));
    if (!op.burned) {
      await chain.burn(id);
      op = await chain.operation(id);
    }
    if (!op.burned || !op.burnTx) throw new Error("Network fee burn is not confirmed.");
    await ctx.db.update(networkFeeLedger).set({ status: "burned", burnTx: op.burnTx }).where(eq(networkFeeLedger.id, row.id));
    burned++;
  }
  return { burned };
}
