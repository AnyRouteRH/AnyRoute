import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { formatUnits, type Hex } from "viem";
import { CreditsAbi } from "../chain/abis.ts";
import type { Ctx } from "../context.ts";
import { accounts, chainCursor, chainEvents, escrowDeposits, keys, kv, ledger } from "../db/schema.ts";
import { picoToUsd, usdgToPico } from "../lib/money.ts";
import { acceptedTokens, escrowCredit, tokenPrice, verifyForCredit } from "./escrow.ts";
import { fastCreditFields, type FastDeposit } from "./fast-credit-state.ts";
import { verifyUsdgDeposit } from "./verify-usdg-deposit.ts";
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
    const [cursor] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, "main"));
    const confirmed = fin.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
    const start = ctx.cfg.chain.startBlock ?? (confirmed > 5_000n ? confirmed - 5_000n : 0n);
    const unread = cursor ? cursor.block + 1n : start;
    for (let from = unread > start ? unread : start; from <= fin.head; from += 2000n) {
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
  const head = await ctx.chain.blockNumber().catch(() => null);
  const confirmed = head === null ? null : head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  return { expected_credit_delay_s: null, head_block: head?.toString() ?? null, credit_block: confirmed?.toString() ?? null, explorer: ctx.cfg.chain.explorerUrl, confirmations: ctx.cfg.chain.confirmations };
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
  const base = (lane: string, tx: string, index: number, block: bigint) => {
    const remaining = lane === "usdg" ? null : depositRemainingSeconds(block, fin, credit);
    return { id: `${lane}:${tx}:${index}`, lane, tx_hash: tx, tx_url: explorer && /^https:\/\//.test(explorer) ? `${explorer.replace(/\/$/, "")}/tx/${tx}` : null, block: block.toString(), remaining_s: remaining,
      expected_final_at: remaining !== null && remaining > 0 ? new Date(Date.now() + remaining * 1000).toISOString() : null }; // B123
  };
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
    deposits.push({ ...base("escrow", row.txHash, row.logIndex, row.blockNumber), symbol: row.symbol === "ANYR" ? "$ANYR" : row.symbol, amount: tok ? formatUnits(BigInt(row.rawAmount), tok.decimals) : null, from_address: row.fromAddress, worth_usd: worth, worth_fixed: !!row.price18 || tok?.kind === "usdg", credited_usd: row.credited != null ? picoToUsd(row.credited) : 0, stage, note: row.error, capped: d?.capped || !!row.reviewReason });
  }
  for (const e of [...usdLogs.values()].sort((a, b) => a.blockNumber > b.blockNumber ? -1 : 1).slice(0, 50)) {
    const [posted] = await ctx.db.select({ amount: ledger.amount }).from(ledger).where(and(eq(ledger.accountId, accountId), eq(ledger.ref, `dep:${e.txHash}:${e.logIndex}`)));
    let stage = posted ? "credited" : "detected";
    if (stage === "detected") {
      const verdict = await verifyUsdgDeposit(ctx, e);
      if (!verdict.ok) stage = verdict.unknown ? "checking" : "orphaned";
    }
    deposits.push({ ...base("usdg", e.txHash, e.logIndex, e.blockNumber), symbol: "USDG", amount: formatUnits(BigInt(String(e.args.amount)), 6), from_address: e.args.from ?? null, worth_usd: picoToUsd(usdgToPico(BigInt(String(e.args.amount)))), worth_fixed: true, credited_usd: posted ? picoToUsd(posted.amount) : 0, confirmations: ctx.cfg.chain.confirmations, stage });
  }
  for (const r of stored.filter(r => r.key.startsWith(`deposit-watch:${ctx.cfg.chain.id}:`))) {
    const w = r.value as DepositWatch;
    if (!deposits.some(d => d.tx_hash === w.txHash && d.lane === w.lane)) deposits.push({ ...base(w.lane, w.txHash, -1, 0n), block: null, remaining_s: null, expected_final_at: null, stage: "submitted", submitted_at: w.submittedAt });
    else if (deposits.some(d => d.tx_hash === w.txHash && d.lane === w.lane && ["final", "credited"].includes(String(d.stage)))) await ctx.db.delete(kv).where(eq(kv.key, r.key)); // Indexed credits keep the status across reloads.
  }
  return { deposits, explorer, confirmations: ctx.cfg.chain.confirmations, head_block: fin.head.toString(), credit_block: credit.toString(), expected_credit_delay_s: Math.max(0, fin.headTime - fin.finalTime), ...await fastCreditFields(ctx) };
}
