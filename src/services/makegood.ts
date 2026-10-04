import { rpcTransport } from "../chain/rpc-transport.ts"; // RPC1
import { and, asc, desc, eq, inArray, isNull, like, lte, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { createWalletClient, encodeFunctionData, erc20Abi, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts, generations, ledger, providers } from "../db/schema.ts";
import { post } from "../ledger/ledger.ts";
import { fail } from "../lib/errors.ts";
import { type Pico, picoToUsdg, picoToUsdString, usdgToPico } from "../lib/money.ts";
import { canonicalJson, decrypt, encrypt, log, sha256, uid } from "../lib/util.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { batchPrice, priceUsage, type Cost, type Fees, type Mode, type Usage } from "../router/pricing.ts";
import type { Attempt } from "../router/execute.ts";
import { bondHostId } from "../network/bond-state.ts";
import { storeSlashEvidence } from "../network/slashing.ts";
import { isSanctioned } from "../network/sanctions.ts";
import { activityAccess } from "../activity/access.ts";
import { bearer, requireKey, walletAuth } from "../api/auth.ts";
import { webhookDestinations } from "../webhooks/schema.ts";
import { enqueue } from "../webhooks/delivery.ts";
import { makegoodPayouts, makegoodRefunds } from "./makegood-schema.ts";

// V6 R: make-good refunds. Deterministic rules over facts the router recorded when it served (or failed) a call:
//
//   rule              when                                                                 refund
//   upstream_failure  a per-call payment bought a request no provider served (5xx/timeout)   100% of that payment, on-chain
//   fallback_price    failover from the first-choice provider to a pricier one               the price difference, same tokens
//   truncated_stream  the upstream stream ended before a finish_reason (not a client cancel)  billed output tokens not delivered
//   structured_output the JSON answer still does not parse after the one repair call          100% of that repair call
//   unattested_lane   an attested-lane call settled without a fresh attestation               100%, plus a host strike
//
// Serve-time hooks record at most one pending candidate per source (a generation, or one per-call payment). The settlement
// job issues it: a ledger line linked to the generation, a signed receipt of kind "refund" naming the original receipt,
// a refund.issued webhook and, for a host-caused refund, host slashing evidence for review. Every refund is capped by
// what the ledger charged (or, for an unserved paid call, by the payment still unspent), and a source can be refunded at
// most once: one candidate row per source (unique), a row lock with a status check, and unique ledger references.
// Calls paid on-chain per call (x402 or CallPay) are refunded on-chain: the credit is moved into an obligation that the
// makegood-payouts job pays from the MAKEGOOD_REFUND_PRIVATE_KEY treasury, one USDG transfer per payer per batch.

export const MAKEGOOD_RULES = ["unattested_lane", "upstream_failure", "structured_output", "truncated_stream", "fallback_price"] as const;
export type MakegoodRule = (typeof MAKEGOOD_RULES)[number];
const UPSTREAM_FAILURES = new Set(["http_5xx", "timeout", "connection", "interrupted"]);
/** Candidates wait this long before issue, so a later rule for the same call (the repair check) can still upgrade it. */
export const ISSUE_DELAY_MS = 60_000;
const rank = (r: string) => MAKEGOOD_RULES.length - MAKEGOOD_RULES.indexOf(r as MakegoodRule);

type Candidate0 = { sourceId: string; generationId: string | null; accountId: string; keyHash: string | null; rule: MakegoodRule; amount: Pico; evidence: Record<string, unknown>; providerId: string | null; strike: boolean; payer: string | null };

/** Record (or upgrade, while still pending) a candidate. Never throws into the request path. */
async function record(ctx: Ctx, c: Candidate0) {
  try {
    await ctx.db.insert(makegoodRefunds).values({ id: uid("rf_"), ...c, status: "pending" }).onConflictDoUpdate({
      target: makegoodRefunds.sourceId,
      set: { rule: c.rule, amount: c.amount, evidence: c.evidence, providerId: c.providerId, strike: c.strike },
      // Only an undecided candidate changes, and only to a larger refund (or the stronger rule at the same amount).
      setWhere: sql`${makegoodRefunds.status} = 'pending' and (${makegoodRefunds.amount} < ${c.amount} or (${makegoodRefunds.amount} = ${c.amount} and ${makegoodRefunds.strike} = false and ${c.strike}))`,
    });
  } catch (e) {
    log.error("make-good detection failed", { source: c.sourceId, error: (e as Error).message });
  }
}

const priced = (c: Candidate, model: ModelRow, usage: Usage, mode: Mode, fees: Fees, byok: boolean, batchDiscountBps: number | null): Pico => {
  const cost = priceUsage(c, model, usage, mode, fees, byok);
  return batchDiscountBps == null ? cost.total : batchPrice(cost, batchDiscountBps).total;
};

export type ServedFacts = {
  id: string;
  accountId: string;
  keyHash: string | null;
  billingMode: string;
  paymentTx: string | null;
  payer: string | null;
  candidate: Candidate;
  model: ModelRow;
  attempts: Attempt[];
  usage: Usage;
  /** Output tokens the router delivered to the caller (streams only), estimated from the delivered text as in billing. */
  delivered?: { completion: number; reasoning: number } | null;
  cost: Cost;
  charged: Pico;
  priceMode: Mode;
  fees: Fees;
  isByok: boolean;
  /** Providers this account calls with its own key (BYOK): a failover price difference is not computed for them. */
  byokProviders?: string[];
  batchDiscountBps: number | null;
  servedClass: string;
  upstreamAttested: boolean | null;
  attestedLane: boolean;
  lane: string;
  finishReason: string | null;
  cancelled: boolean;
  stream: boolean;
};

/** The make-good rules a settled call meets, best first. Pure: the same facts give the same answer. */
export function servedRules(f: ServedFacts, offers: Candidate[]): Omit<Candidate0, "sourceId" | "generationId" | "accountId" | "keyHash" | "payer">[] {
  const out: Omit<Candidate0, "sourceId" | "generationId" | "accountId" | "keyHash" | "payer">[] = [];
  if (f.charged <= 0n) return out;
  if (f.attestedLane && (f.servedClass !== "attested" || f.upstreamAttested === false))
    out.push({ rule: "unattested_lane", amount: f.charged, providerId: f.candidate.providerId, strike: true, evidence: { lane: f.lane, disclosure: f.servedClass, upstream_attested: f.upstreamAttested } });
  // A stream the upstream ended (or broke) before any finish_reason; a client that hung up is not made good.
  if (f.stream && !f.cancelled && (f.finishReason === null || f.finishReason === "error") && f.delivered) {
    const completion = Math.min(f.usage.completion, Math.max(0, Math.ceil(f.delivered.completion)));
    const reasoning = Math.min(f.usage.reasoning, Math.max(0, Math.ceil(f.delivered.reasoning)), completion);
    if (completion < f.usage.completion) {
      const billed = priced(f.candidate, f.model, f.usage, f.priceMode, f.fees, f.isByok, f.batchDiscountBps);
      const deliveredCost = priced(f.candidate, f.model, { ...f.usage, completion, reasoning }, f.priceMode, f.fees, f.isByok, f.batchDiscountBps);
      if (billed > deliveredCost)
        out.push({ rule: "truncated_stream", amount: billed - deliveredCost, providerId: f.candidate.providerId, strike: false, evidence: { billed_completion_tokens: f.usage.completion, delivered_completion_tokens: completion, finish: f.finishReason, provider_usage: !f.usage.estimated } });
    }
  }
  // Failover: the first provider tried for the served model failed, and the one that answered costs more for these tokens.
  const firstFailed = f.attempts.find((a) => !a.ok && a.model === f.model.id);
  if (firstFailed && firstFailed.provider !== f.candidate.providerId && !f.isByok && !f.byokProviders?.includes(firstFailed.provider)) {
    const planned = offers.find((o) => o.providerId === firstFailed.provider);
    if (planned) {
      const served = priced(f.candidate, f.model, f.usage, f.priceMode, f.fees, false, f.batchDiscountBps);
      const plannedCost = priced(planned, f.model, f.usage, f.priceMode, f.fees, false, f.batchDiscountBps);
      if (served > plannedCost)
        out.push({ rule: "fallback_price", amount: served - plannedCost, providerId: firstFailed.provider, strike: false, evidence: { served_provider: f.candidate.providerId, planned_provider: firstFailed.provider, planned_error: firstFailed.error_kind ?? "other", served_cost: picoToUsdString(served), planned_cost: picoToUsdString(plannedCost) } });
    }
  }
  for (const c of out) if (c.amount > f.charged) c.amount = f.charged;
  return out.sort((a, b) => (a.amount === b.amount ? rank(b.rule) - rank(a.rule) : a.amount > b.amount ? -1 : 1));
}

/** Hook in the call finaliser (src/api/chat.ts): every settled call, including council and dual-verification legs. */
export async function noteServedCall(ctx: Ctx, f: ServedFacts) {
  // A blind token names no one to refund, and a cached answer costs nothing.
  if (!ctx.cfg.makegood.enabled || f.billingMode === "blind" || f.charged <= 0n) return;
  let best: ReturnType<typeof servedRules>[number] | undefined;
  try { [best] = servedRules(f, ctx.catalog.offers(f.model.id)); }
  catch (e) { log.error("make-good detection failed", { source: f.id, error: (e as Error).message }); return; }
  if (!best) return;
  const onchain = f.billingMode === "per_call" && !!f.paymentTx && !!f.payer;
  await record(ctx, { ...best, sourceId: f.id, generationId: f.id, accountId: f.accountId, keyHash: f.keyHash, payer: onchain ? f.payer!.toLowerCase() : null });
}

/** Hook where every provider failed a request (src/api/chat.ts). Only a per-call payment was spent on it. */
export async function noteFailedPaidCall(ctx: Ctx, b: { mode: string; accountId: string; payer?: string; paymentTx?: string }, requestId: string, attempts: Attempt[]) {
  if (!ctx.cfg.makegood.enabled || b.mode !== "per_call" || !b.paymentTx || !b.payer) return;
  // A provider that rejected the request itself (4xx) is not an upstream failure; one 5xx or timeout among the rest is.
  if (!attempts.length || attempts.some((a) => a.error_kind === "rejected")) return;
  const upstream = attempts.filter((a) => a.error_kind && UPSTREAM_FAILURES.has(a.error_kind));
  if (!upstream.length) return;
  const classes: Record<string, number> = {};
  for (const a of attempts) classes[a.error_kind ?? "other"] = (classes[a.error_kind ?? "other"] ?? 0) + 1;
  await record(ctx, { sourceId: `payment:${b.paymentTx.toLowerCase()}`, generationId: null, accountId: b.accountId, keyHash: null, rule: "upstream_failure", amount: 0n, evidence: { request_id: requestId, payment_tx: b.paymentTx.toLowerCase(), attempts: attempts.length, error_classes: classes }, providerId: upstream.at(-1)!.provider, strike: false, payer: b.payer.toLowerCase() });
}

const parses = (text: unknown) => {
  if (typeof text !== "string") return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

/** Hook in the JSON check (src/structured-output/chat.ts): the repair answer is checked and still is not JSON. */
export async function noteUnparseableRepair(ctx: Ctx, generationId: string, text: unknown, firstId: string | null) {
  if (!ctx.cfg.makegood.enabled || parses(text)) return;
  const [g] = await ctx.db.select().from(generations).where(eq(generations.id, generationId)).catch(() => []);
  if (!g?.accountId || g.cost <= 0n || g.mode === "blind") return;
  const payer = g.mode === "per_call" && g.paymentTx ? ((g.receipt as { payer?: string } | null)?.payer ?? null) : null;
  await record(ctx, { sourceId: g.id, generationId: g.id, accountId: g.accountId, keyHash: g.keyHash, rule: "structured_output", amount: g.cost, evidence: { check: "unparseable", first_call: firstId }, providerId: null, strike: false, payer: payer?.toLowerCase() ?? null });
}

// ---- issue (settlement job) ------------------------------------------------------------------------------------------

type Row = typeof makegoodRefunds.$inferSelect;

async function notify(ctx: Ctx, tx: Tx, m: Row, at: Date) {
  if (!ctx.cfg.webhookSigningEnabled) return;
  const destinations = await tx.select().from(webhookDestinations).where(and(eq(webhookDestinations.accountId, m.accountId), eq(webhookDestinations.revoked, false), m.keyHash ? or(isNull(webhookDestinations.keyHash), eq(webhookDestinations.keyHash, m.keyHash)) : isNull(webhookDestinations.keyHash)));
  for (const d of destinations) await enqueue(ctx, d, { id: `refund:${m.id}`, event: "refund.issued", reference: m.id, at, status: m.rule }, tx as unknown as Db);
}

/** A host that caused a refund feeds the existing slashing evidence, for review only (never proposed automatically). */
async function hostEvidence(ctx: Ctx, tx: Tx, m: Row, payload: unknown, attestation: string | null) {
  if (!m.providerId || !ctx.cfg.hostBonds.enabled) return;
  const [p] = await tx.select({ hash: providers.attestationHash, network: providers.networkHost }).from(providers).where(eq(providers.id, m.providerId));
  const ref = attestation ?? p?.hash ?? null;
  if (!p?.network || !ref) return;
  await storeSlashEvidence({ ...ctx, db: tx as unknown as Db }, { format: "anyroute.host-slash/1", provider_id: m.providerId, host_id: bondHostId(m.providerId), kind: "makegood_refund", reason: null, observed_sha256: sha256(canonicalJson(payload)), attestation_ref: ref, rejection_sha256: sha256(`makegood:${m.rule}${m.strike ? ":strike" : ""}`) });
}

/** Issue one pending candidate. Idempotent: a candidate is decided once, under its row lock. */
export async function issueRefund(ctx: Ctx, id: string, now = new Date()) {
  return ctx.db.transaction(async (tx) => {
    const [m] = await tx.select().from(makegoodRefunds).where(eq(makegoodRefunds.id, id)).for("update");
    if (!m || m.status !== "pending") return null;
    let charged = 0n;
    let refund = 0n;
    let original: typeof generations.$inferSelect | undefined;
    if (m.rule === "upstream_failure") {
      // Nothing was charged: the payment for the unserved request sits on the payer's wallet account as change.
      const payment = String(m.evidence.payment_tx ?? "");
      const [paid] = await tx.select({ sum: sql<string>`coalesce(sum(${ledger.amount}), 0)` }).from(ledger).where(and(eq(ledger.accountId, m.accountId), eq(ledger.kind, "per_call_payment"), or(eq(ledger.ref, `x402:${payment}`), like(ledger.ref, `callpay:${payment}:%`))));
      const [acct] = await tx.select().from(accounts).where(eq(accounts.id, m.accountId)).for("update");
      const available = acct ? acct.balance - acct.held : 0n;
      charged = BigInt(paid?.sum ?? "0");
      refund = charged < available ? charged : available > 0n ? available : 0n;
      refund = usdgToPico(picoToUsdg(refund, "floor")); // only whole USDG units leave on-chain; dust stays as change
    } else {
      [original] = await tx.select().from(generations).where(eq(generations.id, m.generationId ?? ""));
      // The ledger is the truth for what this call cost: its settlement line, on this account.
      const [line] = await tx.select().from(ledger).where(eq(ledger.ref, `settle:${m.generationId}`));
      charged = line && line.accountId === m.accountId && line.amount < 0n ? -line.amount : 0n;
      refund = m.amount < charged ? m.amount : charged;
    }
    if (!original && m.rule !== "upstream_failure") refund = 0n;
    if (refund <= 0n) {
      await tx.update(makegoodRefunds).set({ status: "void", amount: 0n, charged, issuedAt: now }).where(eq(makegoodRefunds.id, m.id));
      return { id: m.id, status: "void" as const };
    }
    const onchain = !!m.payer && (m.rule === "upstream_failure" || (original?.mode === "per_call" && !!original.paymentTx));
    const units = onchain ? picoToUsdg(refund, "floor") : 0n;
    const payload = {
      v: 1,
      kind: "refund",
      id: m.id,
      issued: now.toISOString(),
      router: ctx.cfg.publicUrl,
      original_receipt_id: original?.receiptId ?? null,
      generation_id: m.generationId,
      rule: m.rule,
      amount: picoToUsdString(refund),
      charged: picoToUsdString(charged),
      settlement: units > 0n ? "onchain" : "credit",
      ...(units > 0n ? { payer: m.payer, onchain_usdg: units.toString(), credit_remainder: picoToUsdString(m.rule === "upstream_failure" ? 0n : refund - usdgToPico(units)) } : {}),
      provider: m.providerId,
      strike: m.strike,
      evidence: m.evidence,
    };
    const signed = ctx.signer.sign(payload);
    const generationId = m.generationId ?? null;
    if (m.rule !== "upstream_failure")
      await post(tx, { accountId: m.accountId, keyHash: m.keyHash, amount: refund, kind: "refund", ref: `makegood:${m.sourceId}`, description: `Make-good refund (${m.rule})`, generationId });
    if (units > 0n)
      await post(tx, { accountId: m.accountId, keyHash: m.keyHash, amount: -usdgToPico(units), kind: "refund_onchain", ref: `makegood-onchain:${m.sourceId}`, description: "Make-good refund owed on-chain", generationId });
    await tx.update(makegoodRefunds).set({ status: "issued", amount: refund, charged, receipt: payload, receiptSig: signed.sig, receiptKeyId: signed.keyId, receiptLeaf: receiptLeaf(signed.bytes, signed.sigBytes), onchainUsdg: units > 0n ? units : null, payoutStatus: units > 0n ? "owed" : "none", issuedAt: now }).where(eq(makegoodRefunds.id, m.id));
    await notify(ctx, tx, m, now);
    await hostEvidence(ctx, tx, m, payload, original?.attestationHash ?? null);
    return { id: m.id, status: "issued" as const, rule: m.rule, amount: refund, onchain_usdg: units };
  });
}

/** Settlement step: issue every candidate that has waited ISSUE_DELAY_MS. */
export async function runMakegood(ctx: Ctx, now = new Date()) {
  if (!ctx.cfg.makegood.enabled) return { skipped: "disabled" };
  const due = await ctx.db.select({ id: makegoodRefunds.id }).from(makegoodRefunds).where(and(eq(makegoodRefunds.status, "pending"), lte(makegoodRefunds.detectedAt, new Date(now.getTime() - ISSUE_DELAY_MS)))).orderBy(asc(makegoodRefunds.detectedAt)).limit(1000);
  let issued = 0, voided = 0, failed = 0;
  for (const { id } of due) {
    try {
      const r = await issueRefund(ctx, id, now);
      if (r?.status === "issued") issued++;
      else if (r?.status === "void") voided++;
    } catch (e) {
      failed++;
      log.error("make-good refund failed", { refund: id, error: (e as Error).message });
    }
  }
  return { issued, void: voided, failed };
}

// ---- on-chain refunds (makegood-payouts job) ------------------------------------------------------------------------

export type RefundTransport = {
  prepare(to: Hex, units: bigint): Promise<{ hash: Hex; raw: Hex }>;
  broadcast(raw: Hex, hash: Hex): Promise<void>;
  /** "success" or "reverted" once mined; null while unknown after waiting up to waitMs. */
  outcome(hash: Hex, waitMs: number): Promise<"success" | "reverted" | null>;
};

/** USDG transfers signed by the refund treasury key. Null when MAKEGOOD_REFUND_PRIVATE_KEY is not set. */
export function refundTransport(ctx: Ctx): RefundTransport | null {
  const key = ctx.cfg.makegood.refundKey;
  if (!key) return null;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: ctx.chain.chain, transport: rpcTransport(ctx.cfg.chain) });
  const usdg = ctx.cfg.chain.usdg as Hex;
  return {
    prepare: async (to, units) => {
      // Preflight (balance, token rules) before a nonce is taken; the signed bytes are stored before any broadcast.
      await ctx.chain.client.simulateContract({ account, address: usdg, abi: erc20Abi, functionName: "transfer", args: [to, units] });
      const request = await wallet.prepareTransactionRequest({ account, chain: ctx.chain.chain, to: usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] }) });
      const raw = await wallet.signTransaction(request as never);
      return { raw, hash: keccak256(raw) };
    },
    broadcast: async (raw, hash) => {
      try { if (await ctx.chain.client.getTransactionReceipt({ hash })) return; }
      catch (error) { if ((error as Error).name !== "TransactionReceiptNotFoundError") throw new Error("Refund receipt lookup failed."); }
      try { await ctx.chain.client.sendRawTransaction({ serializedTransaction: raw }); }
      catch { throw new Error("Refund broadcast unresolved; the signed transfer is kept for retry."); }
    },
    outcome: async (hash, waitMs) => {
      try { return (await ctx.chain.client.getTransactionReceipt({ hash })).status === "success" ? "success" : "reverted"; }
      catch (error) { if ((error as Error).name !== "TransactionReceiptNotFoundError") throw new Error("Refund receipt lookup failed."); }
      if (waitMs <= 0) return null;
      try { return (await ctx.chain.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: waitMs })).status === "success" ? "success" : "reverted"; }
      catch { return null; }
    },
  };
}

async function closePayout(ctx: Ctx, p: typeof makegoodPayouts.$inferSelect, result: "success" | "reverted", now: Date) {
  await ctx.db.transaction(async (tx) => {
    if (result === "success") {
      await tx.update(makegoodPayouts).set({ status: "paid", settledAt: now }).where(eq(makegoodPayouts.id, p.id));
      await tx.update(makegoodRefunds).set({ payoutStatus: "paid" }).where(eq(makegoodRefunds.payoutId, p.id));
    } else {
      // A reverted transfer can never land later, so its refunds are owed again and go into a fresh batch.
      await tx.update(makegoodPayouts).set({ status: "failed", settledAt: now }).where(eq(makegoodPayouts.id, p.id));
      await tx.update(makegoodRefunds).set({ payoutStatus: "owed", payoutId: null }).where(eq(makegoodRefunds.payoutId, p.id));
    }
  });
}

/**
 * Pay owed on-chain refunds: one USDG transfer per payer, summing that payer's owed refunds. One transfer in flight at a
 * time; a transfer is signed and stored before it is broadcast, and an unconfirmed one is only ever rebroadcast as the
 * same bytes, so a crash or timeout can never pay twice. Refuses to run without MAKEGOOD_REFUND_PRIVATE_KEY.
 */
export async function runMakegoodPayouts(ctx: Ctx, transport: RefundTransport | null = refundTransport(ctx), opts: { maxPayers?: number; waitMs?: number } = {}, now = new Date()) {
  if (!ctx.cfg.makegood.enabled) return { skipped: "disabled" };
  if (!transport) return { refused: "MAKEGOOD_REFUND_PRIVATE_KEY is not set; on-chain refunds stay owed" };
  const waitMs = opts.waitMs ?? 120_000;
  let paid = 0;
  for (const p of await ctx.db.select().from(makegoodPayouts).where(eq(makegoodPayouts.status, "signed")).orderBy(asc(makegoodPayouts.createdAt))) {
    let result = await transport.outcome(p.txHash as Hex, 0);
    if (!result) {
      await transport.broadcast(decrypt(ctx.cfg.appSecret, p.signedTxEnc) as Hex, p.txHash as Hex);
      result = await transport.outcome(p.txHash as Hex, waitMs);
    }
    if (!result) return { paid, pending: p.id };
    await closePayout(ctx, p, result, now);
    if (result === "reverted") return { paid, failed: p.id }; // owed again; retried next run, never in a loop
    paid++;
  }
  const skipped: string[] = [];
  for (let i = 0; i < (opts.maxPayers ?? 25); i++) {
    const [next] = await ctx.db.select({ payer: makegoodRefunds.payer }).from(makegoodRefunds).where(and(eq(makegoodRefunds.payoutStatus, "owed"), sql`${makegoodRefunds.payer} is not null`, ...(skipped.length ? [sql`${makegoodRefunds.payer} not in (${sql.join(skipped.map((s) => sql`${s}`), sql`, `)})`] : []))).orderBy(asc(makegoodRefunds.issuedAt)).limit(1);
    if (!next?.payer) break;
    const payer = next.payer;
    if (!/^0x[0-9a-f]{40}$/.test(payer) || (ctx.cfg.sanctions.enabled && (await isSanctioned(ctx, payer)))) {
      skipped.push(payer); // stays owed; never paid to an invalid or listed address
      log.warn("make-good on-chain refund held", { reason: /^0x[0-9a-f]{40}$/.test(payer) ? "sanctions_match" : "invalid_payer" });
      continue;
    }
    const owed = await ctx.db.select({ id: makegoodRefunds.id, units: makegoodRefunds.onchainUsdg }).from(makegoodRefunds).where(and(eq(makegoodRefunds.payoutStatus, "owed"), eq(makegoodRefunds.payer, payer))).limit(500);
    const units = owed.reduce((a, r) => a + (r.units ?? 0n), 0n);
    if (units <= 0n) { skipped.push(payer); continue; }
    const prepared = await transport.prepare(payer as Hex, units);
    const id = uid("mgp_");
    await ctx.db.transaction(async (tx) => {
      await tx.insert(makegoodPayouts).values({ id, payer, usdg: units, status: "signed", txHash: prepared.hash, signedTxEnc: encrypt(ctx.cfg.appSecret, prepared.raw) });
      await tx.update(makegoodRefunds).set({ payoutStatus: "batched", payoutId: id }).where(and(eq(makegoodRefunds.payoutStatus, "owed"), inArray(makegoodRefunds.id, owed.map((r) => r.id))));
    });
    await transport.broadcast(prepared.raw, prepared.hash);
    const result = await transport.outcome(prepared.hash, waitMs);
    if (!result) return { paid, pending: id };
    const [row] = await ctx.db.select().from(makegoodPayouts).where(eq(makegoodPayouts.id, id));
    await closePayout(ctx, row, result, now);
    if (result === "reverted") return { paid, failed: id };
    paid++;
  }
  return { paid, held: skipped.length };
}

// ---- reading ---------------------------------------------------------------------------------------------------------

export function refundJson(m: Row) {
  return {
    id: m.id,
    rule: m.rule,
    status: m.status,
    amount: picoToUsdString(m.amount),
    charged: picoToUsdString(m.charged),
    currency: "USD",
    generation_id: m.generationId,
    receipt_id: m.receiptSig ? m.id : null,
    receipt_url: m.receiptSig ? `/api/v1/receipts/${encodeURIComponent(m.id)}` : null,
    provider: m.providerId,
    strike: m.strike,
    evidence: m.evidence,
    settlement: m.onchainUsdg ? "onchain" : m.status === "issued" ? "credit" : null,
    onchain: m.onchainUsdg ? { usdg_units: m.onchainUsdg.toString(), status: m.payoutStatus } : null,
    detected_at: m.detectedAt.toISOString(),
    issued_at: m.issuedAt?.toISOString() ?? null,
  };
}

/** A signed refund receipt by id, in the shape of GET /api/v1/receipts/:id (public by id, like every receipt). */
export async function refundReceipt(ctx: Ctx, id: string) {
  if (!id.startsWith("rf_")) return null;
  const [m] = await ctx.db.select().from(makegoodRefunds).where(eq(makegoodRefunds.id, id));
  if (!m?.receiptSig) return null;
  return { id: m.id, version: 1, kind: "refund", payload: m.receipt, sig: m.receiptSig, key_id: m.receiptKeyId, leaf: m.receiptLeaf, anchor: null, v2: null };
}

/** The truthful /api/v1/status section, counted from the refund records (cached for 30 seconds). */
const statusCache = new WeakMap<Ctx, { at: number; value: unknown }>();
export async function makegoodStatus(ctx: Ctx, maxAgeMs = 30_000) {
  if (!ctx.cfg.makegood.enabled) return { enabled: false };
  const hit = statusCache.get(ctx);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = await countMakegood(ctx);
  statusCache.set(ctx, { at: Date.now(), value });
  return value;
}
async function countMakegood(ctx: Ctx) {
  const [r] = await ctx.db.select({
    issued: sql<number>`count(*) filter (where ${makegoodRefunds.status} = 'issued')::int`,
    pending: sql<number>`count(*) filter (where ${makegoodRefunds.status} = 'pending')::int`,
    strikes: sql<number>`count(*) filter (where ${makegoodRefunds.status} = 'issued' and ${makegoodRefunds.strike})::int`,
    owed: sql<number>`count(*) filter (where ${makegoodRefunds.payoutStatus} in ('owed','batched'))::int`,
    owedUnits: sql<string>`coalesce(sum(${makegoodRefunds.onchainUsdg}) filter (where ${makegoodRefunds.payoutStatus} in ('owed','batched')), 0)::text`,
  }).from(makegoodRefunds);
  const [last] = await ctx.db.select({ at: makegoodPayouts.settledAt }).from(makegoodPayouts).where(eq(makegoodPayouts.status, "paid")).orderBy(desc(makegoodPayouts.settledAt)).limit(1);
  return {
    enabled: true,
    rules: [...MAKEGOOD_RULES],
    issued: r?.issued ?? 0,
    pending: r?.pending ?? 0,
    host_strikes: r?.strikes ?? 0,
    receipts: "v1 (Ed25519, kind refund); not yet anchored",
    onchain: { owed_refunds: r?.owed ?? 0, owed_usdg_units: r?.owedUnits ?? "0", last_paid_at: last?.at?.toISOString() ?? null },
  };
}

export function makegoodRoutes(app: Hono, ctx: Ctx) {
  // Refunds of the caller's account (a non-owner key sees its own), or of a per-call payer's wallet (X-Wallet-Auth).
  app.get("/api/v1/refunds", async (c) => {
    c.header("cache-control", "no-store");
    if (!ctx.cfg.makegood.enabled) fail(404, "Make-good refunds are not switched on.", "not_found");
    let scope;
    if (!bearer(c.req.header("authorization")) && c.req.header("x-wallet-auth")) scope = eq(makegoodRefunds.accountId, (await walletAuth(ctx, c.req.header("x-wallet-auth")!, sha256(""))).accountId);
    else {
      const key = await requireKey(ctx, c.req.header("authorization"));
      const { whole } = await activityAccess(ctx, key);
      scope = whole ? eq(makegoodRefunds.accountId, key.accountId) : and(eq(makegoodRefunds.accountId, key.accountId), eq(makegoodRefunds.keyHash, key.keyHash));
    }
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(c.req.query("limit") ?? 50)) || 50));
    const rows = await ctx.db.select().from(makegoodRefunds).where(and(scope, inArray(makegoodRefunds.status, ["issued", "pending"]))).orderBy(desc(makegoodRefunds.detectedAt)).limit(limit);
    return c.json({ data: rows.map(refundJson) });
  });
}
