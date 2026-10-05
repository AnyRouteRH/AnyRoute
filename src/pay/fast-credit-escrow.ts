import { asc, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { escrowDeposits } from "../db/schema.ts";
import { acceptedTokens, depositKinds, escrowCredit, escrowAccountId, tokenPrice, verifyForCredit, type EscrowFinal } from "./escrow.ts";
import { applyFastDeposit, fastCreditActive, fastDepositKey, readFastDeposit, reverseFastDeposit, type FastDeposit } from "./fast-credit-state.ts";

/** Uses the final path's allowlist, decimals guard, receipt check, price and per-deposit ceiling. */
export async function creditFastEscrow(ctx: Ctx, fin: EscrowFinal) {
  if (!await fastCreditActive(ctx)) return;
  const rows = await ctx.db.select().from(escrowDeposits).where(inArray(escrowDeposits.status, ["pending_finality", "provisional", "pending"])).orderBy(asc(escrowDeposits.blockNumber), asc(escrowDeposits.logIndex)).limit(500);
  for (const row of rows) {
    const id = fastDepositKey(ctx, "escrow", row.txHash, row.logIndex);
    const fixed = await readFastDeposit(ctx.db, id);
    const final = row.blockNumber <= fin.creditable;
    if (!fixed && (final || !ctx.cfg.fastCredit.enabled || fin.head - row.blockNumber + 1n < BigInt(ctx.cfg.fastCredit.confirmations))) continue;
    const verdict = await verifyForCredit(ctx, row); // Transport failures abort the poll; never reverse on them.
    if (!verdict.ok) {
      if (!verdict.unknown && fixed?.status === "provisional") await reverseFastDeposit(ctx, id, async tx => {
        await tx.update(escrowDeposits).set({ status: "reversed", reversedAt: new Date(), error: "Credit reversed after chain reorganization.", reviewReason: "provisional credit reversed after chain reorganization", reviewedAt: null }).where(eq(escrowDeposits.id, row.id));
      });
      continue;
    }
    const token = acceptedTokens(ctx).find(t => t.address.toLowerCase() === row.token);
    if (!token) continue;
    const price = fixed?.price18 ? { price18: BigInt(fixed.price18), updatedAt: fixed.priceAt! } : await tokenPrice(ctx, token);
    if (!price) continue;
    const full = escrowCredit(ctx, BigInt(row.rawAmount), token.decimals, price.price18, token.haircutBps);
    const total = token.maxCredit !== null && full > token.maxCredit ? token.maxCredit : full;
    const candidate: FastDeposit = fixed ?? {
      id, lane: "escrow", accountId: escrowAccountId(row.fromAddress), wallet: row.fromAddress,
      txHash: row.txHash, logIndex: row.logIndex, block: row.blockNumber.toString(), hash: verdict.blockHash,
      total: total.toString(), provisional: "0", status: "provisional", price18: price.price18.toString(), priceAt: price.updatedAt, capped: total < full,
      ref: `escrow:${row.id}`, kind: depositKinds(token.kind).credit,
      reversalRef: `escrow-reversal:${row.id}`, reversalKind: depositKinds(token.kind).reversal,
    };
    await applyFastDeposit(ctx, candidate, final, async (tx, d) => {
      const [current] = await tx.select().from(escrowDeposits).where(eq(escrowDeposits.id, row.id)).for("update");
      if (!current || !["pending_finality", "provisional", "pending"].includes(current.status) || current.blockHash !== row.blockHash) throw new Error("Escrow deposit changed during crediting; retry on the next poll.");
      const now = new Date();
      await tx.update(escrowDeposits).set({ status: final ? "credited" : "provisional", accountId: d.accountId, price18: d.price18, priceUpdatedAt: new Date(d.priceAt! * 1000), credited: BigInt(final ? d.total : d.provisional), creditedAt: current.creditedAt ?? now, checkedAt: now, blockHash: verdict.blockHash, error: d.capped ? "Credit limited to the per-deposit ceiling; the excess requires operator review." : null, ...(d.capped ? { reviewReason: "deposit exceeds the per-deposit ceiling; refund or credit the excess by hand", reviewedAt: null } : {}) }).where(eq(escrowDeposits.id, row.id));
    });
  }
}
