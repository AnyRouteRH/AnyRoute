import { and, eq, like, sql } from "drizzle-orm";
import { TransactionReceiptNotFoundError, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { keys, kv } from "../db/schema.ts";
import type { DecodedLog } from "../chain/service.ts";
import { usdgToPico } from "../lib/money.ts";
import { applyFastDeposit, fastDepositKey, readFastDeposit, reverseFastDeposit, type FastDeposit } from "./fast-credit-state.ts";

/** Receipt status, configured Credits contract, exact log index/key/amount and canonical block hash. */
export async function verifyUsdgDeposit(ctx: Ctx, e: DecodedLog, hash?: string): Promise<{ ok: boolean; unknown?: boolean; hash?: string }> {
  let r;
  try { r = await ctx.chain.client.getTransactionReceipt({ hash: e.txHash }); }
  catch (err) { if (err instanceof TransactionReceiptNotFoundError) return { ok: false }; throw err; }
  const canonical = await ctx.chain.blockHashAt(e.blockNumber);
  if (!canonical) return { ok: false, unknown: true };
  if (hash && hash !== canonical.toLowerCase()) return { ok: false };
  if (r.blockHash.toLowerCase() !== canonical.toLowerCase()) return { ok: false, unknown: true };
  if (r.status !== "success" || r.blockNumber !== e.blockNumber) return { ok: false };
  const decoded = ctx.chain.decodeReceipt(r.logs);
  const found = decoded.some(l => l.contract === "credits" && l.event === "Deposited" && l.logIndex === e.logIndex && String(l.args.keyHash).toLowerCase() === String(e.args.keyHash).toLowerCase() && String(l.args.amount) === String(e.args.amount));
  return { ok: found, hash: canonical.toLowerCase() };
}
export async function handleFastUsdg(ctx: Ctx, e: DecodedLog) {
  const fin = await ctx.chain.escrowFinality(ctx.cfg.escrow.finality);
  const floor = fin.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  const final = e.blockNumber <= fin.final && e.blockNumber <= floor;
  const id = fastDepositKey(ctx, "usdg", e.txHash, e.logIndex);
  const fixed = await readFastDeposit(ctx.db, id);
  if (fixed?.status === "final" || fixed?.status === "reversed") return true;
  if (!final && (!ctx.cfg.fastCredit.enabled && !fixed || fin.head - e.blockNumber + 1n < BigInt(ctx.cfg.fastCredit.confirmations) && !fixed)) return false;
  const verdict = await verifyUsdgDeposit(ctx, e, fixed?.hash);
  if (!verdict.ok) {
    if (!verdict.unknown && fixed) await reverseFastDeposit(ctx, id);
    return final && !verdict.unknown;
  }
  const [key] = await ctx.db.select().from(keys).where(eq(keys.chainKeyHash, String(e.args.keyHash).toLowerCase()));
  if (!key) return false; // Final event stays unprocessed, including deposits made before key registration.
  const candidate: FastDeposit = fixed ?? {
    id, lane: "usdg", accountId: key.accountId, keyHash: key.keyHash, txHash: e.txHash.toLowerCase(), logIndex: e.logIndex,
    block: e.blockNumber.toString(), hash: verdict.hash!, total: usdgToPico(BigInt(String(e.args.amount))).toString(), provisional: "0", status: "provisional",
    ref: `dep:${e.txHash}:${e.logIndex}`, kind: "deposit", reversalKind: "deposit_reversal", reversalRef: `dep-reversal:${e.txHash}:${e.logIndex}`,
  };
  await applyFastDeposit(ctx, candidate, final);
  return final;
}
export async function previewFastUsdg(ctx: Ctx, final: bigint, head: bigint, maxRange: bigint) {
  // Rescan the unfinalized interval: no preview checkpoint can skip a replacement branch.
  if (ctx.cfg.fastCredit.enabled) {
    const start = ctx.cfg.chain.startBlock ?? (final > 5_000n ? final - 5_000n : 0n);
    for (let from = final + 1n > start ? final + 1n : start; from <= head; from += maxRange) {
      const to = from + maxRange - 1n < head ? from + maxRange - 1n : head;
      for (const e of await ctx.chain.logs(from, to)) if (e.contract === "credits" && e.event === "Deposited") await handleFastUsdg(ctx, e);
    }
  }
  const rows = await ctx.db.select().from(kv).where(and(like(kv.key, "fast-credit:deposit:%"), sql`${kv.value}->>'lane' = 'usdg'`, sql`${kv.value}->>'status' = 'provisional'`));
  for (const row of rows) {
    const d = row.value as FastDeposit;
    const [key] = await ctx.db.select().from(keys).where(eq(keys.keyHash, d.keyHash!));
    if (!key) continue;
    await handleFastUsdg(ctx, { contract: "credits", event: "Deposited", txHash: d.txHash as Hex, logIndex: d.logIndex, blockNumber: BigInt(d.block), args: { keyHash: key.chainKeyHash, amount: BigInt(d.total) / 1_000_000n } });
  }
}
