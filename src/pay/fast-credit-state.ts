import { and, eq, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { kv, ledger } from "../db/schema.ts";
import { ensureAccount, post } from "../ledger/ledger.ts";
import { usdToPico, picoToUsd } from "../lib/money.ts";
import { log, sha256 } from "../lib/util.ts";
import { provisionalCreditAmount } from "./fast-credit-amount.ts";

export type FastDeposit = {
  id: string; lane: "escrow"; accountId: string; keyHash?: string; wallet?: string;
  txHash: string; logIndex: number; block: string; hash: string;
  total: string; provisional: string; status: "provisional" | "final" | "reversed";
  ref: string; kind: string; reversalKind: string; reversalRef: string;
  price18?: string; priceAt?: number; capped?: boolean;
};
const PREFIX = "fast-credit:deposit:";
export const fastDepositKey = (ctx: Ctx, lane: string, tx: string, index: number) => `${PREFIX}${ctx.cfg.chain.id}:${lane}:${tx.toLowerCase()}:${index}`;
export async function readFastDeposit(db: Db | Tx, id: string): Promise<FastDeposit | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, id));
  return row ? row.value as FastDeposit : null;
}
export async function writeFastDeposit(tx: Tx, d: FastDeposit) {
  await tx.insert(kv).values({ key: d.id, value: d }).onConflictDoUpdate({ target: kv.key, set: { value: d, updatedAt: new Date() } });
}
// A single database row serializes escrow credits across replicas. Lock it before deposit/account rows.
export async function fastCreditLock(tx: Tx) {
  await tx.insert(kv).values({ key: "fast-credit:lock", value: {} }).onConflictDoNothing();
  await tx.select().from(kv).where(eq(kv.key, "fast-credit:lock")).for("update");
}
export async function fastCreditActive(ctx: Ctx) {
  if (ctx.cfg.fastCredit.enabled) return true;
  const [row] = await ctx.db.select({ key: kv.key }).from(kv).where(eq(kv.key, "fast-credit:lock"));
  return !!row; // Disabling stops new provisional credits; existing credits still settle/reverse.
}
async function outstanding(db: Db | Tx, accountId?: string) {
  const [r] = await db.select({ amount: sql<string>`coalesce(sum((${kv.value}->>'provisional')::numeric), 0)` }).from(kv).where(and(like(kv.key, `${PREFIX}%`), sql`${kv.value}->>'status' = 'provisional'`, accountId ? sql`${kv.value}->>'accountId' = ${accountId}` : undefined));
  return BigInt(r.amount);
}
export async function applyFastDeposit(ctx: Ctx, candidate: FastDeposit, final: boolean, update?: (tx: Tx, d: FastDeposit) => Promise<void>) {
  return ctx.db.transaction(async tx => {
    await fastCreditLock(tx);
    let d = await readFastDeposit(tx, candidate.id);
    if (d?.status === "reversed" || d?.status === "final") return d;
    if (!d) {
      // A deposit credited before enabling this feature must never be credited again.
      const [old] = await tx.select({ id: ledger.id }).from(ledger).where(eq(ledger.ref, candidate.ref));
      if (old) return null;
      d = { ...candidate, provisional: "0", status: "provisional" };
    }
    if (!final && d.provisional !== "0") return d;
    const total = BigInt(d.total);
    let amount = total - BigInt(d.provisional);
    if (!final) {
      const accountRoom = usdToPico(ctx.cfg.fastCredit.accountMaxUsd, "floor") - await outstanding(tx, d.accountId);
      const globalRoom = usdToPico(ctx.cfg.fastCredit.globalMaxUsd, "floor") - await outstanding(tx);
      amount = provisionalCreditAmount(amount, accountRoom, globalRoom);
      if (amount <= 0n) return null; // No price is fixed until money is actually credited.
    }
    await ensureAccount(tx, d.accountId, d.wallet ? "wallet" : "key", d.wallet);
    await post(tx, { accountId: d.accountId, keyHash: d.keyHash, amount, kind: final ? d.kind : "provisional", ref: final ? d.ref : `provisional:${d.id}`, description: final ? "Deposit final settlement" : "Deposit credited while settling" });
    d = { ...d, ...(final ? { status: "final" as const } : { provisional: amount.toString() }) };
    await writeFastDeposit(tx, d);
    await update?.(tx, d);
    return d;
  });
}
export async function reverseFastDeposit(ctx: Ctx, id: string, update?: (tx: Tx, d: FastDeposit) => Promise<void>) {
  const reversed = await ctx.db.transaction(async tx => {
    await fastCreditLock(tx);
    const d = await readFastDeposit(tx, id);
    if (!d || d.status !== "provisional") return false;
    await post(tx, { accountId: d.accountId, keyHash: d.keyHash, amount: -BigInt(d.provisional), kind: d.reversalKind, ref: d.reversalRef, description: "Deposit reversed after chain reorganization" });
    d.status = "reversed";
    await writeFastDeposit(tx, d);
    await update?.(tx, d);
    return true;
  });
  if (reversed) log.error("provisional deposit reversed", { id });
  return reversed;
}
export async function fastCreditFields(ctx: Ctx, accountId?: string) {
  if (!ctx.cfg.fastCredit.enabled) return {};
  return { fast_credit: { enabled: true, confirmations: ctx.cfg.fastCredit.confirmations, account_max_usd: ctx.cfg.fastCredit.accountMaxUsd, global_max_usd: ctx.cfg.fastCredit.globalMaxUsd, ...(accountId ? { settling_usd: picoToUsd(await outstanding(ctx.db, accountId)) } : {}) } };
}
// One durable check per reversal uses the existing notifier's delivery/deduplication and webhook config.
export async function fastCreditAlertChecks(ctx: Ctx) {
  const rows = await ctx.db.select({ key: kv.key }).from(kv).where(and(like(kv.key, `${PREFIX}%`), sql`${kv.value}->>'status' = 'reversed'`));
  return Object.fromEntries(rows.map(r => [`deposit_reversal_${sha256(r.key).slice(0, 24)}`, false]));
}
