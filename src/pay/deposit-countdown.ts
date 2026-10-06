// B123: reuse the existing block-progress estimate; these times are approximate, never deadlines.
import type { Ctx } from "../context.ts";
import { creditBlock, depositRemainingSeconds } from "./deposit-progress.ts";
export async function withDepositCountdown<T extends { block: string; stage: string }>(ctx: Ctx, deposits: T[]) {
  const waiting = deposits.some(d => ["confirming", "provisional"].includes(d.stage));
  const fin = waiting ? await ctx.chain.escrowFinality(ctx.cfg.escrow.finality).catch(() => null) : null;
  const now = Date.now();
  return deposits.map(d => {
    const seconds = fin && ["confirming", "provisional"].includes(d.stage) ? depositRemainingSeconds(BigInt(d.block), fin, creditBlock(ctx, fin)) : null;
    return { ...d, expected_final_at: seconds !== null && seconds > 0 ? new Date(now + seconds * 1000).toISOString() : null };
  });
}
