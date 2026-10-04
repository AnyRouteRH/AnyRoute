import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { formatUnits, type Hex } from "viem";
import { CreditsAbi } from "../chain/abis.ts";
import type { Ctx } from "../context.ts";
import { accounts, chainEvents, escrowDeposits, keys, kv, ledger } from "../db/schema.ts";
import { picoToUsd, usdgToPico } from "../lib/money.ts";
import { acceptedTokens, escrowCredit, tokenPrice, verifyForCredit } from "./escrow.ts";
import { fastCreditFields, type FastDeposit } from "./fast-credit-state.ts";
import { verifyUsdgDeposit } from "./fast-credit-usdg.ts";
import type { DecodedLog, EscrowFinality } from "../chain/service.ts";

export type DepositWatch = { accountId: string; txHash: string; lane: "escrow" | "usdg"; submittedAt: string };
export const watchKey = (ctx: Ctx, account: string, hash: string) => `deposit-watch:${ctx.cfg.chain.id}:${account}:${hash.toLowerCase()}`;
export async function watchDeposit(ctx: Ctx, accountId: string, txHash: string, lane: DepositWatch["lane"]) {
  return ctx.db.transaction(async tx => {
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for("update");
    const rows = await tx.select({ key: kv.key }).from(kv).where(like(kv.key, `deposit-watch:${ctx.cfg.chain.id}:${accountId}:%`));
    // Bound account-owned submitted hashes across replicas; no typed amount is retained.
    if (rows.length >= 20 && !rows.some(r => r.key === watchKey(ctx, accountId, txHash))) return false;
    await tx.insert(kv).values({ key: watchKey(ctx, accountId, txHash), value: { accountId, txHash: txHash.toLowerCase(), lane, submittedAt: new Date().toISOString() } satisfies DepositWatch }).onConflictDoNothing();
    return true;
  });
}
const previews = new WeakMap<Ctx, { at: number; promise: Promise<DecodedLog[]> }>();
function usdgPreview(ctx: Ctx, fin: EscrowFinality) {
  const old = previews.get(ctx);
  if (old && Date.now() - old.at < 5000) return old.promise;
  const promise = (async () => {
    if (!ctx.chain.address("credits")) return [];
    const found: DecodedLog[] = [];
    const start = ctx.cfg.chain.startBlock ?? 0n;
    for (let from = fin.final + 1n > start ? fin.final + 1n : start; from <= fin.head; from += 2000n) {
      const to = from + 1999n < fin.head ? from + 1999n : fin.head;
      const logs = await ctx.chain.client.getLogs({ address: ctx.chain.address("credits")!, event: CreditsAbi.find(e => e.type === "event" && e.name === "Deposited")!, fromBlock: from, toBlock: to });
      found.push(...ctx.chain.decodeReceipt(logs).filter(e => e.contract === "credits" && e.event === "Deposited"));
    }
    return found;
  })();
  previews.set(ctx, { at: Date.now(), promise });
  promise.catch(() => previews.delete(ctx));
  return promise;
}
export function creditBlock(ctx: Ctx, fin: EscrowFinality) {
  const confirmed = fin.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  return fin.final < confirmed ? fin.final : confirmed;
}
export async function depositTiming(ctx: Ctx) {
  const fin = await ctx.chain.escrowFinality(ctx.cfg.escrow.finality).catch(() => null);
  return { expected_credit_delay_s: fin ? Math.max(0, fin.headTime - fin.finalTime) : null, head_block: fin?.head.toString() ?? null, credit_block: fin ? creditBlock(ctx, fin).toString() : null, explorer: ctx.cfg.chain.explorerUrl };
}
export async function usdgFinalityReady(ctx: Ctx, block: bigint) {
  return block <= creditBlock(ctx, await ctx.chain.escrowFinality(ctx.cfg.escrow.finality));
}
/** Approximate remaining time from the live head/finality block gap, never a deadline. */
export function depositRemainingSeconds(block: bigint, fin: EscrowFinality, credit: bigint) {
  if (block <= credit) return 0;
  const gap = fin.head - fin.final;
  const delay = Math.max(0, fin.headTime - fin.finalTime);
  return gap > 0n && delay > 0 ? Math.ceil(Number(block - credit) / Number(gap) * delay) : null;
}
export async function accountDeposits(ctx: Ctx, accountId: string) {
  const fin = await ctx.chain.escrowFinality(ctx.cfg.escrow.finality);
  const credit = creditBlock(ctx, fin);
  const accountKeys = await ctx.db.select({ chainHash: keys.chainKeyHash }).from(keys).where(eq(keys.accountId, accountId));
  const hashes = new Set(accountKeys.map(k => k.chainHash.toLowerCase()));
  const stored = await ctx.db.select().from(kv).where(and(sql`${kv.value}->>'accountId' = ${accountId}`, sql`(${kv.key} like 'fast-credit:deposit:%' or ${kv.key} like ${`deposit-watch:${ctx.cfg.chain.id}:%`})`));
  const fixed = new Map(stored.filter(r => r.key.startsWith(`fast-credit:deposit:${ctx.cfg.chain.id}:`)).map(r => { const d = r.value as FastDeposit; return [`${d.lane}:${d.txHash}:${d.logIndex}`, d]; }));
  const historical = hashes.size ? await ctx.db.select().from(chainEvents).where(and(eq(chainEvents.contract, "credits"), eq(chainEvents.event, "Deposited"), inArray(sql<string>`lower(${chainEvents.args}->>'keyHash')`, [...hashes]))).orderBy(desc(chainEvents.blockNumber), desc(chainEvents.logIndex)).limit(50) : [];
  const usdLogs = new Map<string, DecodedLog>();
  for (const e of [...historical, ...await usdgPreview(ctx, fin)]) {
    const args = e.args as Record<string, unknown>;
    if (hashes.has(String(args.keyHash).toLowerCase())) usdLogs.set(`${e.txHash}:${e.logIndex}`, { ...e, txHash: e.txHash as Hex, contract: "credits", args });
  }
  const wallet = accountId.startsWith("w_") ? `0x${accountId.slice(2)}` : "";
  const escrow = wallet ? await ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.fromAddress, wallet)).orderBy(desc(escrowDeposits.blockNumber), desc(escrowDeposits.logIndex)).limit(50) : [];
  const explorer = ctx.cfg.chain.explorerUrl;
  const base = (lane: string, tx: string, index: number, block: bigint) => ({ id: `${lane}:${tx}:${index}`, lane, tx_hash: tx, tx_url: explorer && /^https:\/\//.test(explorer) ? `${explorer.replace(/\/$/, "")}/tx/${tx}` : null, block: block.toString(), remaining_s: depositRemainingSeconds(block, fin, credit) });
  const deposits: Array<Record<string, unknown>> = [];
  const tokens = acceptedTokens(ctx);
  for (const row of escrow) {
    const tok = tokens.find(t => t.address.toLowerCase() === row.token);
    const d = fixed.get(`escrow:${row.txHash}:${row.logIndex}`);
    const p = row.price18 ? { price18: BigInt(row.price18) } : tok ? await tokenPrice(ctx, tok) : null;
    const worth = tok && p ? picoToUsd(escrowCredit(ctx, BigInt(row.rawAmount), tok.decimals, p.price18, tok.haircutBps)) : null;
    let stage: string = row.status === "credited" ? "final" : row.status === "pending" ? p ? "crediting" : "awaiting_price" : row.status === "pending_finality" ? "detected" : row.status;
    if (["detected", "provisional"].includes(stage)) {
      const verdict = await verifyForCredit(ctx, row);
      if (!verdict.ok) stage = verdict.unknown ? "checking" : "orphaned";
    }
    deposits.push({ ...base("escrow", row.txHash, row.logIndex, row.blockNumber), symbol: row.symbol === "ANYR" ? "$ANYR" : row.symbol, amount: tok ? formatUnits(BigInt(row.rawAmount), tok.decimals) : null, from_address: row.fromAddress, worth_usd: worth, worth_fixed: !!row.price18, credited_usd: row.credited != null ? picoToUsd(row.credited) : 0, stage, note: row.error, capped: d?.capped || !!row.reviewReason });
  }
  for (const e of [...usdLogs.values()].sort((a, b) => a.blockNumber > b.blockNumber ? -1 : 1).slice(0, 50)) {
    const d = fixed.get(`usdg:${e.txHash}:${e.logIndex}`);
    const [posted] = await ctx.db.select({ amount: ledger.amount }).from(ledger).where(and(eq(ledger.accountId, accountId), eq(ledger.ref, `dep:${e.txHash}:${e.logIndex}`)));
    let stage = d?.status === "reversed" ? "reversed" : d?.status === "final" || posted ? "final" : d && BigInt(d.provisional) > 0n ? "provisional" : e.blockNumber <= credit ? "crediting" : "detected";
    if (["detected", "provisional", "crediting"].includes(stage)) {
      const verdict = await verifyUsdgDeposit(ctx, e, d?.hash);
      if (!verdict.ok) stage = verdict.unknown ? "checking" : "orphaned";
    }
    deposits.push({ ...base("usdg", e.txHash, e.logIndex, e.blockNumber), symbol: "USDG", amount: formatUnits(BigInt(String(e.args.amount)), 6), from_address: e.args.from ?? null, worth_usd: picoToUsd(usdgToPico(BigInt(String(e.args.amount)))), worth_fixed: true, credited_usd: d ? picoToUsd(BigInt(d.status === "final" ? d.total : d.provisional)) : posted ? picoToUsd(posted.amount) : 0, stage });
  }
  for (const r of stored.filter(r => r.key.startsWith(`deposit-watch:${ctx.cfg.chain.id}:`))) {
    const w = r.value as DepositWatch;
    if (!deposits.some(d => d.tx_hash === w.txHash && d.lane === w.lane)) deposits.push({ ...base(w.lane, w.txHash, -1, 0n), block: null, remaining_s: null, stage: "submitted", submitted_at: w.submittedAt });
    else if (deposits.some(d => d.tx_hash === w.txHash && d.lane === w.lane && d.stage === "final")) await ctx.db.delete(kv).where(eq(kv.key, r.key)); // Final indexed deposits keep the status across reloads.
  }
  return { deposits, explorer, head_block: fin.head.toString(), credit_block: credit.toString(), expected_credit_delay_s: Math.max(0, fin.headTime - fin.finalTime), ...await fastCreditFields(ctx) };
}
