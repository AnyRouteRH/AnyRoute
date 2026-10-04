import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generations, kv, royalties, settlements } from "../src/db/schema.ts";
import { picoToUsdg, mulBps } from "../src/lib/money.ts";
import { runSettlement } from "../src/services/settlement.ts";
import { retainedMargin } from "../src/services/retained-margin.ts";
import { startRouter } from "./helpers.ts";

// The former unconfigured path read margin_unsent, rounded down, and never wrote or signed.
function previousUnconfiguredResult(value: bigint) {
  const amount = picoToUsdg(value, "floor");
  return amount <= 0n ? { sent: "0" } : { sent: "0", accrued_usdg: amount.toString(), reason: "staking not configured" };
}
test("settlement output and retained margin equal the former unconfigured path, including fees and dust", async () => {
  const h = await startRouter({ providers: [] });
  try {
    const upstream = 50_000_000_000_000n, margin = 7_000_000_000_123n;
    await h.ctx.db.insert(generations).values({ id: "retained-call", providerId: "sample-provider", modelId: "sample-model", upstreamCost: upstream, margin, royalty: 1_000_000_000_000n, tokensIn: 2, tokensOut: 3, mode: "prepaid", ts: new Date("2020-01-01T00:00:00Z") });
    // Any chain transfer or retired address lookup is a regression.
    h.chain.transferUsdg = async () => { throw new Error("unexpected margin transfer"); };
    const result = await runSettlement(h.ctx);
    const accrued = margin + mulBps(upstream, h.ctx.cfg.fees.providerFeeBps, "floor");
    expect(result.margin).toEqual(previousUnconfiguredResult(accrued));
    expect(result.hours).toEqual({ periods: 1, royalties: 1, generations: 1 });
    expect(result.roots).toEqual({ posted: false, reason: "no funded keys" });
    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, "margin_unsent"));
    expect(String(row.value)).toBe(accrued.toString());
    const [invoice] = await h.ctx.db.select().from(settlements);
    expect(invoice.usdgOwed).toBe(picoToUsdg(upstream - mulBps(upstream, h.ctx.cfg.fees.providerFeeBps, "floor"), "floor"));
    expect(await h.ctx.db.select().from(royalties)).toHaveLength(1);
    expect((await runSettlement(h.ctx)).margin).toEqual(result.margin);
    expect((await h.ctx.db.select().from(kv).where(eq(kv.key, "margin_unsent")))[0].value).toBe(row.value);
    for (const amount of [0n, 1n, 999_999n, 1_000_000n, accrued]) {
      await h.ctx.db.update(kv).set({ value: amount.toString() }).where(eq(kv.key, "margin_unsent"));
      expect(await retainedMargin(h.ctx)).toEqual(previousUnconfiguredResult(amount));
      expect(String((await h.ctx.db.select().from(kv).where(eq(kv.key, "margin_unsent")))[0].value)).toBe(amount.toString());
    }
  } finally { await h.close(); }
});
