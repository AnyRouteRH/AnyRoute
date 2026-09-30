import type { Hono } from "hono";
import { desc, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { networkFeeLedger } from "./payout-schema.ts";
export function networkBurnRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/network/burns", async c => {
    const [totals] = await ctx.db.select({ gross_pico: sql<string>`coalesce(sum(${networkFeeLedger.grossPico}),0)::text`, fee_pico: sql<string>`coalesce(sum(${networkFeeLedger.feePico}),0)::text`, burned_anyr_units: sql<string>`coalesce(sum(${networkFeeLedger.anyrAmount}) filter (where ${networkFeeLedger.status} = 'burned'),0)::text`, pending_fee_pico: sql<string>`coalesce(sum(${networkFeeLedger.feePico}) filter (where ${networkFeeLedger.status} <> 'burned'),0)::text`, conversion_dust_pico: sql<string>`coalesce(sum(mod(${networkFeeLedger.feePico},1000000)) filter (where ${networkFeeLedger.status} = 'burned'),0)::text` }).from(networkFeeLedger);
    const recent = await ctx.db.select().from(networkFeeLedger).orderBy(desc(networkFeeLedger.createdAt), desc(networkFeeLedger.id)).limit(50);
    const explorer = ctx.cfg.chain.explorerUrl.replace(/\/$/, "");
    const link = (hash: string | null) => hash && /^0x[0-9a-f]{64}$/i.test(hash) ? `${explorer}/tx/${hash}` : null;
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ data: { enabled: ctx.cfg.networkPayouts.burnEnabled, fee_bps: ctx.cfg.networkPayouts.feeBps, totals, anyr_decimals: 18, method: "transfer_to_dead_address", recent: recent.map(r => ({ status: r.status, anyr_amount: r.anyrAmount?.toString() ?? null, swap_tx: r.swapTx, burn_tx: r.burnTx, swap_url: link(r.swapTx), burn_url: link(r.burnTx), created_at: r.createdAt.toISOString() })) } });
  });
}
