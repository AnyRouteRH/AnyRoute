import { and, eq, isNull, sql } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, keccak256, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { payouts, providers, settlements } from "../db/schema.ts";
import { decrypt, encrypt, uid } from "../lib/util.ts";
import { networkFeeLedger, networkPayoutDispatch } from "./payout-schema.ts";
/** Intercept network hosts only. A claimed invoice is never transferred again with a fresh nonce.
 * Persist the signed transfer before broadcasting: recovery rebroadcasts identical bytes.
 * Reverted or nonce-conflicted transfers stay pending for operator reconciliation. */
export async function networkPayout(ctx: Ctx, p: typeof providers.$inferSelect, cutoff: string, out: unknown[]) {
  if (!p.networkHost) return false;
  if (!ctx.cfg.networkPayouts.enabled || p.payoutMode !== "usdg" || !p.payoutAddress || !ctx.chain.roleAddress("settlement")) return true;
  let row = await ctx.db.transaction(async tx => {
    await tx.select({ id: providers.id }).from(providers).where(eq(providers.id, p.id)).for("update");
    const [pending] = await tx.select().from(payouts).where(and(eq(payouts.providerId, p.id), eq(payouts.status, "pending"))).limit(1);
    if (pending) return pending;
    // Only invoices created by anchored network accrual are eligible.
    const due = await tx.select().from(settlements).where(and(eq(settlements.providerId, p.id), isNull(settlements.payoutId), sql`${settlements.period} <= ${cutoff}`, sql`exists (select 1 from ${networkFeeLedger} f where f.provider_id = ${p.id} and f.period = ${settlements.period} and f.gross_pico = ${settlements.upstream} and f.fee_pico = ${settlements.fee})`));
    const amount = due.reduce((n, e) => n + e.usdgOwed, 0n);
    if (amount <= 0n) return;
    const [pay] = await tx.insert(payouts).values({ id: uid("pay_"), providerId: p.id, usdg: amount, to: p.payoutAddress, status: "pending" }).returning();
    for (const e of due) await tx.update(settlements).set({ payoutId: pay.id }).where(and(eq(settlements.providerId, p.id), eq(settlements.period, e.period)));
    return pay;
  });
  if (!row) return true;
  const claimed = await ctx.db.select({ invoice: settlements, fee: networkFeeLedger }).from(settlements).leftJoin(networkFeeLedger, and(eq(networkFeeLedger.providerId, settlements.providerId), eq(networkFeeLedger.period, settlements.period))).where(eq(settlements.payoutId, row.id));
  if (!claimed.length || claimed.some(e => e.invoice.providerId !== p.id || !e.fee || e.fee.grossPico !== e.invoice.upstream || e.fee.feePico !== e.invoice.fee || e.invoice.usdgOwed !== (e.invoice.upstream - e.invoice.fee) / 1_000_000n) || claimed.reduce((n, e) => n + e.invoice.usdgOwed, 0n) !== row.usdg) throw new Error("Pending network payout does not reconcile with anchored invoices.");
  // Destination changes require manual reconciliation; screening must apply to the actual transfer.
  if (row.to?.toLowerCase() !== p.payoutAddress.toLowerCase()) throw new Error("Network payout destination changed; reconcile the pending transfer.");
  let [dispatch] = await ctx.db.select().from(networkPayoutDispatch).where(eq(networkPayoutDispatch.payoutId, row.id));
  if (!dispatch) {
    const wallet = ctx.chain.wallet("settlement");
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [row.to as Hex, row.usdg] });
    const request = await wallet.prepareTransactionRequest({ chain: wallet.chain, to: ctx.cfg.chain.usdg, data });
    const signed = await wallet.signTransaction(request as never);
    const hash = keccak256(signed);
    await ctx.db.insert(networkPayoutDispatch).values({ payoutId: row.id, signedTxEnc: encrypt(ctx.cfg.appSecret, signed), txHash: hash }).onConflictDoNothing();
    [dispatch] = await ctx.db.select().from(networkPayoutDispatch).where(eq(networkPayoutDispatch.payoutId, row.id));
  }
  const hash = dispatch.txHash as Hex;
  let receipt = await ctx.chain.client.getTransactionReceipt({ hash }).catch(e => { if ((e as Error).name !== "TransactionReceiptNotFoundError") throw e; return null; });
  if (!receipt) {
    await ctx.chain.client.sendRawTransaction({ serializedTransaction: decrypt(ctx.cfg.appSecret, dispatch.signedTxEnc) as Hex }).catch(async e => {
      // An already broadcast transaction can be known but still awaiting inclusion.
      const transaction = await ctx.chain.client.getTransaction({ hash }).catch(() => null);
      if (!transaction) throw e;
    });
    receipt = await ctx.chain.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  }
  if (receipt.status !== "success") throw new Error("Network payout transfer reverted; reconcile before retrying.");
  // A token that returns false must not be recorded as paid.
  const { decodeEventLog } = await import("viem");
  const transferred = receipt.logs.some(l => {
    if (l.address.toLowerCase() !== ctx.cfg.chain.usdg.toLowerCase()) return false;
    try { const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }); return e.eventName === "Transfer" && e.args.from.toLowerCase() === ctx.chain.roleAddress("settlement")!.toLowerCase() && e.args.to.toLowerCase() === row!.to!.toLowerCase() && e.args.value === row!.usdg; } catch { return false; }
  });
  if (!transferred) throw new Error("Network payout lacks the matching USDG transfer event.");
  await ctx.db.transaction(async tx => {
    await tx.update(payouts).set({ status: "paid", tx: hash }).where(eq(payouts.id, row!.id));
    await tx.update(settlements).set({ paidTx: hash }).where(eq(settlements.payoutId, row!.id));
  });
  out.push({ provider: p.id, usdg: row.usdg.toString(), tx: hash });
  return true;
}

export async function addPendingNetworkPayouts(ctx: Ctx, due: { providerId: string; owed: string }[]) {
  if (!ctx.cfg.networkPayouts.enabled) return;
  const pending = await ctx.db.select({ providerId: payouts.providerId }).from(payouts).innerJoin(providers, eq(providers.id, payouts.providerId)).where(and(eq(providers.networkHost, true), eq(payouts.status, "pending")));
  for (const p of pending) if (!due.some(d => d.providerId === p.providerId)) due.push({ providerId: p.providerId, owed: "0" });
}
