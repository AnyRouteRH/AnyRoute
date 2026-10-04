import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { chainCursor } from "../db/schema.ts";
import { recordEvents } from "../chain/indexer.ts";
import { fastCreditActive } from "./fast-credit-state.ts";
import { previewFastUsdg } from "./fast-credit-usdg.ts";
export const isUsdgDeposit = (e: { contract: string; event: string }) => e.contract === "credits" && e.event === "Deposited";
/** Separate deposit cursor: enabling fast credit must not delay unrelated contract events. */
export async function pollFastUsdg(ctx: Ctx, maxRange: bigint) {
  if (!await fastCreditActive(ctx)) return false;
  const fin = await ctx.chain.escrowFinality(ctx.cfg.escrow.finality);
  const floor = fin.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  const final = fin.final < floor ? fin.final : floor;
  await previewFastUsdg(ctx, final, fin.head, maxRange);
  const id = `fast-usdg-final:${ctx.cfg.chain.id}`;
  const [cursor] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, id));
  const start = ctx.cfg.chain.startBlock ?? (final > 5_000n ? final - 5_000n : 0n);
  for (let from = cursor ? cursor.block + 1n : start; from <= final; from += maxRange) {
    const to = from + maxRange - 1n < final ? from + maxRange - 1n : final;
    const hash = await ctx.chain.blockHashAt(to);
    if (!hash) throw new Error("USDG final block is not available yet.");
    const deposits = (await ctx.chain.logs(from, to)).filter(isUsdgDeposit);
    if (await ctx.chain.blockHashAt(to) !== hash) throw new Error("Chain changed during USDG deposit scan.");
    await recordEvents(ctx, deposits);
    await ctx.db.insert(chainCursor).values({ id, block: to }).onConflictDoUpdate({ target: chainCursor.id, set: { block: to, updatedAt: new Date() } });
  }
  return true;
}
