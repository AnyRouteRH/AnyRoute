import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { generations, kv, paywithDebts, paywithSessions, paywithSwaps } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { minPico, mulBps, type Pico, picoToUsdg, PICO_PER_USD, usdToPico, usdgToPico } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { allocateSwap, processEvents, recordEvents } from "../chain/indexer.ts";
import type { AllowanceAuthorization, ChargeAuthorization, DecodedLog, PaywithSession } from "../chain/service.ts";

// "Your NVDA pays for your AI." A key with an open PayWithStock session may run up to a small,
// cap-bounded USD debt. The router cannot move the wallet's tokens on its own: every on-chain charge
// carries the wallet's EIP-712 authorization, bound to the Merkle root of the receipts it pays.
//  - With a signed allowance (total and per-charge token limits, <= 7 days, <= $5 per charge) the
//    aggregator settles at >= $1 (or 24h) by itself, one bounded charge at a time.
//  - Without one it proposes the charge (amount, token maximum, usage commitment) and waits for the
//    wallet to sign it in the dashboard; the signed charge then settles the same way.
// If the oracle is stale/paused, requests fall back to the key's prepaid USDG, else 402.

export type PaywithGrant = { symbol: string; token: string; decimals: number; fairPrice18: bigint; creditLine: Pico };

// ---- EIP-712 (mirrors PayWithStock.CHARGE_TYPEHASH / ALLOWANCE_TYPEHASH) ------------------------

export const CHARGE_TYPES = {
  ChargeAuthorization: [
    { name: "keyHash", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "usdgAmount", type: "uint256" },
    { name: "maxRaw", type: "uint256" },
    { name: "usageCommitment", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "epoch", type: "uint64" },
    { name: "deadline", type: "uint256" },
    { name: "router", type: "address" },
  ],
} as const;
export const ALLOWANCE_TYPES = {
  AllowanceAuthorization: [
    { name: "keyHash", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "maxRawTotal", type: "uint256" },
    { name: "maxRawPerCharge", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "epoch", type: "uint64" },
    { name: "router", type: "address" },
  ],
} as const;
/** PayWithStock.MAX_AUTHORIZATION_WINDOW (seconds) and MAX_ALLOWANCE_CHARGE_USDG (USDG units). */
export const MAX_AUTHORIZATION_WINDOW_S = 7 * 86_400;
export const MAX_ALLOWANCE_CHARGE_USDG = 5_000_000n;
/** How long a proposed charge waits for the wallet's signature (and stays valid once signed). */
export const CHARGE_TTL_S = 24 * 3_600;
/** Signed windows stay this far inside the contract's 7-day bound (clock skew between router and chain). */
const WINDOW_MARGIN_S = 600;

const uint = z.string().regex(/^\d{1,78}$/, "must be a decimal integer string").transform((v) => BigInt(v));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v.toLowerCase() as Hex);
export const allowanceMessage = z.object({ keyHash: bytes32, token: address, maxRawTotal: uint, maxRawPerCharge: uint, validUntil: uint, nonce: uint, epoch: uint, router: address });
export const chargeMessage = z.object({ keyHash: bytes32, token: address, usdgAmount: uint, maxRaw: uint, usageCommitment: bytes32, nonce: uint, epoch: uint, deadline: uint, router: address });

type Json<T> = { [K in keyof T]: string };
const jsonify = <T extends object>(m: T) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v)])) as Json<T>;
const nowS = () => Math.floor(Date.now() / 1000);

export function chargeTypedData(ctx: Ctx, message: ChargeAuthorization) {
  return { domain: ctx.chain.payWithStockDomain(), types: CHARGE_TYPES, primaryType: "ChargeAuthorization" as const, message };
}
export function allowanceTypedData(ctx: Ctx, message: AllowanceAuthorization) {
  return { domain: ctx.chain.payWithStockDomain(), types: ALLOWANCE_TYPES, primaryType: "AllowanceAuthorization" as const, message };
}
/** What a wallet signs with eth_signTypedData_v4: the domain type spelled out and integers as decimal strings. */
export function typedDataJson(td: ReturnType<typeof chargeTypedData> | ReturnType<typeof allowanceTypedData>) {
  const domainType = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  return { domain: td.domain, types: { EIP712Domain: domainType, ...td.types }, primaryType: td.primaryType, message: jsonify(td.message) };
}

// ---- kv records (no schema change: authorizations live next to the swap rows) --------------------

type StoredAllowance = { message: Json<AllowanceAuthorization>; signature: Hex; wallet: string; savedAt: string };
type StoredCharge = {
  mode: "signature" | "allowance";
  keyHash: string;
  usageCommitment: Hex;
  generations: string[];
  leaves: Hex[];
  usdg: string;
  message?: Json<ChargeAuthorization>;
  signature?: Hex | null;
  wallet?: string;
};
const allowanceKvKey = (chainKeyHash: string) => `paywith-allowance:${chainKeyHash}`;
const chargeKvKey = (swapId: string) => `paywith-charge:${swapId}`;

async function getKv<T>(ctx: Ctx, key: string): Promise<T | null> {
  const [r] = await ctx.db.select().from(kv).where(eq(kv.key, key));
  return (r?.value as T) ?? null;
}
async function putKv(ctx: Ctx, key: string, value: unknown) {
  await ctx.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}
/** Forget the key's stored allowance (closing or revoking the session; an allowance the chain refused). */
export async function forgetAllowance(ctx: Ctx, chainKeyHash: string) {
  await ctx.db.delete(kv).where(eq(kv.key, allowanceKvKey(chainKeyHash)));
}

// ---- prices ------------------------------------------------------------------------------------

const fairCache = new Map<string, { at: number; price: bigint | null }>();

export async function fairPrice(ctx: Ctx, token: string): Promise<bigint | null> {
  const hit = fairCache.get(token);
  if (hit && Date.now() - hit.at < 30_000) return hit.price;
  const q = await ctx.chain.quoteRaw(token as Hex, 1_000_000n).catch(() => null);
  const price = q?.fairPrice18 ?? null;
  fairCache.set(token, { at: Date.now(), price });
  return price;
}
export const clearFairCache = () => fairCache.clear();

/** USD value (pico) of `raw` token units at fairPrice18 (USD per whole token, 18 decimals). */
export const rawToPico = (raw: bigint, decimals: number, fair18: bigint) => (raw * fair18 * PICO_PER_USD) / (10n ** BigInt(decimals) * 10n ** 18n);
export const picoToRaw = (pico: Pico, decimals: number, fair18: bigint) =>
  fair18 === 0n ? 0n : (pico * 10n ** BigInt(decimals) * 10n ** 18n + fair18 * PICO_PER_USD - 1n) / (fair18 * PICO_PER_USD);

export async function openDebt(ctx: Ctx, chainKeyHash: string): Promise<Pico> {
  const [r] = await ctx.db
    .select({ n: sql<string>`coalesce(sum(${paywithDebts.amount}), 0)` })
    .from(paywithDebts)
    .where(and(eq(paywithDebts.chainKeyHash, chainKeyHash), isNull(paywithDebts.swapId)));
  return BigInt(r?.n ?? 0);
}

/** Work out how much a key may owe right now when paying with `symbol`, or explain why not. */
export async function grantFor(ctx: Ctx, key: KeyRow, symbol: string): Promise<{ grant: PaywithGrant | null; reason?: string }> {
  const tok = ctx.cfg.paywith.tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
  if (!tok) return { grant: null, reason: `${symbol} is not a registered Stock Token on this router.` };
  const [s] = await ctx.db.select().from(paywithSessions).where(eq(paywithSessions.keyHash, key.chainKeyHash));
  if (!s || !s.active) return { grant: null, reason: `No open ${tok.symbol} session for this key. Open one with PayWithStock.openSession.` };
  if (s.token.toLowerCase() !== tok.address.toLowerCase()) return { grant: null, reason: `This key's open session pays with ${s.symbol}, not ${tok.symbol}.` };
  if (!ctx.chain.address("payWithStock")) return { grant: null, reason: "Pay with Stock Tokens is not configured on this router." };
  const fair = await fairPrice(ctx, tok.address);
  if (!fair) return { grant: null, reason: `The ${tok.symbol} price feed is stale or paused.` };
  // Remaining daily cap (fresh from chain, with the day rollover applied).
  let capLeftRaw = s.capRawDay - s.spentRawToday;
  try {
    const onchain = await ctx.chain.session(key.chainKeyHash as Hex);
    const today = BigInt(Math.floor(Date.now() / 86_400_000) * 86_400);
    capLeftRaw = onchain.capRawPerDay - (onchain.dayStart < today ? 0n : onchain.spentRawToday);
    if (!onchain.active) return { grant: null, reason: "The on-chain session is closed." };
  } catch {
    /* fall back to the indexed view */
  }
  const haircut = BigInt(10_000 - ctx.cfg.paywith.capHaircutBps);
  const capUsd = mulBps(rawToPico(capLeftRaw > 0n ? capLeftRaw : 0n, tok.decimals, fair), haircut, "floor");
  // The credit line bounds how far below zero the balance may go in total. Unswapped debt is
  // already part of that negative balance, so the line is simply min(max debt, cap value left today):
  // the eventual swap of all outstanding debt then always fits the session's daily cap. The router
  // carries this line itself: the wallet's tokens move only when it authorizes the charge.
  const line = minPico(usdToPico(ctx.cfg.paywith.maxDebtUsd), capUsd);
  return { grant: { symbol: tok.symbol, token: tok.address.toLowerCase(), decimals: tok.decimals, fairPrice18: fair, creditLine: line > 0n ? line : 0n } };
}

export async function recordDebt(ctx: Ctx, d: { key: KeyRow; generationId: string; amount: Pico; grant: PaywithGrant }) {
  if (d.amount <= 0n) return null;
  const raw = picoToRaw(d.amount, d.grant.decimals, d.grant.fairPrice18);
  await ctx.db.insert(paywithDebts).values({
    id: uid("debt_"),
    chainKeyHash: d.key.chainKeyHash,
    accountId: d.key.accountId,
    generationId: d.generationId,
    token: d.grant.token,
    amount: d.amount,
    rawEstimate: raw,
    fairPrice18: d.grant.fairPrice18.toString(),
  });
  return raw;
}

// ---- wallet authorizations -----------------------------------------------------------------------

function routerAddress(ctx: Ctx): Hex {
  const r = ctx.chain.roleAddress("router");
  if (!r) fail(503, "No router signing key is configured.", "chain_unconfigured");
  return r.toLowerCase() as Hex;
}

/** The key's on-chain session, which must be open and opened by the wallet registered for the key. */
async function linkedSession(ctx: Ctx, key: KeyRow) {
  let onchain: PaywithSession;
  try {
    onchain = await ctx.chain.session(key.chainKeyHash as Hex);
  } catch {
    fail(503, "The PayWithStock session could not be read from the chain.", "chain_unavailable");
  }
  if (!onchain.active) fail(409, "This key has no open PayWithStock session. Open one first.", "no_session");
  const [row] = await ctx.db.select().from(paywithSessions).where(eq(paywithSessions.keyHash, key.chainKeyHash));
  if (!row?.active || row.wallet !== onchain.wallet.toLowerCase()) fail(409, "The router has not indexed a session from the wallet registered for this key yet.", "session_not_linked");
  const tok = ctx.cfg.paywith.tokens.find((t) => t.address.toLowerCase() === onchain.token.toLowerCase());
  if (!tok) fail(409, "The session's token is not registered on this router.", "token_unknown");
  return { onchain, tok };
}

/** Typed data for a bounded allowance the session wallet signs once. Defaults: one day of the session's
 *  cap in total, one $5 charge (with slippage headroom) per charge, 7 days. */
export async function allowanceProposal(ctx: Ctx, key: KeyRow, opts: { maxRawTotal?: bigint; maxRawPerCharge?: bigint; validSeconds?: number } = {}) {
  const { onchain, tok } = await linkedSession(ctx, key);
  const router = routerAddress(ctx);
  const fair = await fairPrice(ctx, tok.address);
  if (!fair) fail(503, `The ${tok.symbol} price is unavailable, so the allowance cannot be sized.`, "price_unavailable");
  const { nextNonce } = await ctx.chain.allowance(key.chainKeyHash as Hex);
  const perChargeUsd = minPico(usdToPico(ctx.cfg.paywith.maxDebtUsd), usdgToPico(MAX_ALLOWANCE_CHARGE_USDG));
  const headroom = BigInt(10_000 + 2 * ctx.cfg.paywith.maxSlipBps);
  const defaultPerCharge = (picoToRaw(perChargeUsd, tok.decimals, fair) * headroom + 9_999n) / 10_000n;
  const maxRawTotal = opts.maxRawTotal ?? onchain.capRawPerDay;
  if (maxRawTotal <= 0n || maxRawTotal > onchain.capRawPerDay * 7n) fail(400, "max_raw_total must be positive and at most seven days of the session's daily cap.", "invalid_request");
  const perCharge = opts.maxRawPerCharge ?? defaultPerCharge;
  if (perCharge <= 0n) fail(400, "max_raw_per_charge must be positive.", "invalid_request");
  const validSeconds = Math.min(opts.validSeconds ?? MAX_AUTHORIZATION_WINDOW_S, MAX_AUTHORIZATION_WINDOW_S - WINDOW_MARGIN_S);
  if (validSeconds < 3_600) fail(400, "valid_seconds must be at least one hour.", "invalid_request");
  const message: AllowanceAuthorization = {
    keyHash: key.chainKeyHash.toLowerCase() as Hex,
    token: onchain.token.toLowerCase() as Hex,
    maxRawTotal,
    maxRawPerCharge: perCharge < maxRawTotal ? perCharge : maxRawTotal,
    validUntil: BigInt(nowS() + validSeconds),
    nonce: nextNonce,
    epoch: onchain.epoch,
    router,
  };
  return { wallet: onchain.wallet.toLowerCase(), symbol: tok.symbol, decimals: tok.decimals, typedData: allowanceTypedData(ctx, message) };
}

/** Check and store an allowance the session wallet signed. It is registered on-chain with the next charge. */
export async function saveAllowance(ctx: Ctx, key: KeyRow, input: { message: unknown; signature: Hex }) {
  const m = allowanceMessage.parse(input.message);
  const { onchain } = await linkedSession(ctx, key);
  const router = routerAddress(ctx);
  const { nextNonce } = await ctx.chain.allowance(key.chainKeyHash as Hex);
  const now = nowS();
  const problem = (
    [
      [m.keyHash !== key.chainKeyHash.toLowerCase(), "it is for another key"],
      [m.token !== onchain.token.toLowerCase(), "it names another token than the session's"],
      [m.router !== router, "it names another router"],
      [m.epoch !== onchain.epoch, "the session was re-opened or its authorizations revoked since it was prepared"],
      [m.nonce !== nextNonce, "its nonce is not the next allowance nonce"],
      [m.validUntil <= BigInt(now + 60) || m.validUntil > BigInt(now + MAX_AUTHORIZATION_WINDOW_S), "it must expire within the next seven days"],
      [m.maxRawPerCharge <= 0n || m.maxRawPerCharge > m.maxRawTotal, "its per-charge limit must be positive and at most its total"],
    ] as const
  ).find(([bad]) => bad);
  if (problem) fail(400, `Allowance rejected: ${problem[1]}.`, "invalid_authorization");
  if (!(await ctx.chain.verifyWalletSignature(onchain.wallet, allowanceTypedData(ctx, m), input.signature))) fail(403, "The signature is not the session wallet's.", "bad_signature");
  await putKv(ctx, allowanceKvKey(key.chainKeyHash), { message: jsonify(m), signature: input.signature, wallet: onchain.wallet.toLowerCase(), savedAt: new Date().toISOString() } satisfies StoredAllowance);
  return { max_raw_total: m.maxRawTotal.toString(), max_raw_per_charge: m.maxRawPerCharge.toString(), valid_until: Number(m.validUntil), nonce: m.nonce.toString(), epoch: m.epoch.toString(), registered: false };
}

type UsableAllowance = { registered: boolean; maxRawTotal: bigint; maxRawPerCharge: bigint; remainingRaw: bigint; validUntil: bigint; message?: AllowanceAuthorization; signature?: Hex };

/** The allowance the aggregator may charge against now: the newest one the wallet signed (registered with the
 *  next charge), else the one registered on-chain. Null when there is none for the current epoch and router. */
export async function usableAllowance(ctx: Ctx, chainKeyHash: string, onchain: PaywithSession): Promise<UsableAllowance | null> {
  if (!onchain.active) return null;
  const router = ctx.chain.roleAddress("router")?.toLowerCase();
  const soon = BigInt(nowS() + 60);
  const al = await ctx.chain.allowance(chainKeyHash as Hex);
  const stored = await getKv<StoredAllowance>(ctx, allowanceKvKey(chainKeyHash));
  const parsed = stored ? allowanceMessage.safeParse(stored.message) : null;
  if (stored && parsed?.success) {
    const m = parsed.data;
    if (m.epoch === onchain.epoch && m.token === onchain.token.toLowerCase() && m.router === router && m.validUntil > soon && m.nonce === al.nextNonce)
      return { registered: false, maxRawTotal: m.maxRawTotal, maxRawPerCharge: m.maxRawPerCharge, remainingRaw: m.maxRawTotal, validUntil: m.validUntil, message: m, signature: stored.signature };
  }
  if (al.validUntil > soon && al.epoch === onchain.epoch && al.router.toLowerCase() === router && al.spentRaw < al.maxRawTotal)
    return { registered: true, maxRawTotal: al.maxRawTotal, maxRawPerCharge: al.maxRawPerCharge, remainingRaw: al.maxRawTotal - al.spentRaw, validUntil: al.validUntil };
  return null;
}

/** Largest USD amount one allowance charge may settle: the contract pulls rawNeeded * (1 + slip), clamped to
 *  min(per-charge limit, what is left); keep that worst case inside it, and at most $5. */
function allowanceLimitPico(ctx: Ctx, al: UsableAllowance, decimals: number, fair: bigint): Pico {
  const bound = al.maxRawPerCharge < al.remainingRaw ? al.maxRawPerCharge : al.remainingRaw;
  const rawAtFair = (bound * 10_000n) / BigInt(10_000 + ctx.cfg.paywith.maxSlipBps);
  return minPico(rawToPico(rawAtFair, decimals, fair), usdgToPico(MAX_ALLOWANCE_CHARGE_USDG));
}

// ---- settlement ----------------------------------------------------------------------------------

type Claimed = { mode: "signature" | "allowance"; usdgOwed: bigint; count: number; usageCommitment: Hex; generations: string[]; leaves: Hex[] };

/** Settle accrued debts on-chain: >= threshold USD or oldest >= max age. The debts being paid are claimed
 *  by the charge before it is sent (so calls that finish meanwhile stay open for the next one) and bound
 *  to it by the Merkle root of their receipt leaves (the usage commitment the wallet authorizes). */
export async function runPaywithAggregator(ctx: Ctx) {
  if (!ctx.chain.address("payWithStock")) return { skipped: "PayWithStock not configured" };
  const results: unknown[] = [];
  // 1. Charges proposed earlier: submit the ones the wallet signed, expire the stale ones.
  const waiting = await ctx.db.select().from(paywithSwaps).where(inArray(paywithSwaps.status, ["awaiting_signature", "signed"])).orderBy(asc(paywithSwaps.ts));
  const busy = new Set<string>();
  for (const sw of waiting) {
    // One key's chain or data trouble never stops the others (the proposal stays as it is).
    const r = await advanceProposal(ctx, sw).catch((e) => ({ pending: true, result: { key: sw.keyHash, error: (e as Error).message.slice(0, 300) } }));
    if (r.pending) busy.add(sw.keyHash);
    if (r.result) results.push(r.result);
  }
  // 2. New charges, one open proposal per key at a time.
  const open = await ctx.db
    .select({
      chainKeyHash: paywithDebts.chainKeyHash,
      total: sql<string>`sum(${paywithDebts.amount})`,
      oldest: sql<Date>`min(${paywithDebts.createdAt})`,
    })
    .from(paywithDebts)
    .where(isNull(paywithDebts.swapId))
    .groupBy(paywithDebts.chainKeyHash);
  const threshold = usdToPico(ctx.cfg.paywith.thresholdUsd);
  const maxAgeMs = ctx.cfg.paywith.maxAgeH * 3_600_000;
  for (const g of open) {
    if (busy.has(g.chainKeyHash)) continue;
    if (BigInt(g.total) < threshold && Date.now() - new Date(g.oldest).getTime() < maxAgeMs) continue;
    const r = await settleKey(ctx, g.chainKeyHash).catch((e) => ({ key: g.chainKeyHash, error: (e as Error).message.slice(0, 300) }));
    if (r) results.push(r);
  }
  return { settled: results };
}

async function settleKey(ctx: Ctx, chainKeyHash: string) {
  const key = chainKeyHash as Hex;
  let onchain: PaywithSession;
  try {
    onchain = await ctx.chain.session(key);
  } catch (e) {
    return { key: chainKeyHash, error: (e as Error).message.slice(0, 300) };
  }
  if (!onchain.active) return { key: chainKeyHash, error: "The session is closed, so the debt stays open." };
  const tok = ctx.cfg.paywith.tokens.find((t) => t.address.toLowerCase() === onchain.token.toLowerCase());
  const fair = tok ? await fairPrice(ctx, tok.address) : null;
  if (!tok || !fair) return { key: chainKeyHash, error: "The session token's price is unavailable." };
  const allowance = await usableAllowance(ctx, chainKeyHash, onchain);
  const swapId = uid("swap_");
  const claimed = await claimDebts(ctx, chainKeyHash, swapId, onchain.token, allowance ? allowanceLimitPico(ctx, allowance, tok.decimals, fair) : null);
  if (!claimed) return null;
  const record: StoredCharge = { mode: claimed.mode, keyHash: chainKeyHash, usageCommitment: claimed.usageCommitment, generations: claimed.generations, leaves: claimed.leaves, usdg: claimed.usdgOwed.toString() };
  if (claimed.mode === "signature") return proposeCharge(ctx, key, swapId, claimed, onchain, record);

  try {
    await putKv(ctx, chargeKvKey(swapId), record);
    if (!allowance!.registered) {
      try {
        await ctx.chain.setAllowance(allowance!.message!, allowance!.signature!);
      } catch (e) {
        await forgetAllowance(ctx, chainKeyHash); // the chain refused it: later charges ask the wallet instead
        throw e;
      }
    }
    const r = await ctx.chain.payCallWithAllowance(key, claimed.usdgOwed, claimed.usageCommitment, ctx.cfg.paywith.maxSlipBps);
    await applyCharge(ctx, swapId, key, claimed.usdgOwed, r);
    return { key: chainKeyHash, usdg: claimed.usdgOwed.toString(), debts: claimed.count, tx: r.hash, mode: "allowance", usage_commitment: claimed.usageCommitment };
  } catch (e) {
    return failCharge(ctx, swapId, key, claimed.usageCommitment, e, "failed");
  }
}

/** Claim the key's open debts whose receipts are stored, in order; under an allowance only as many as one
 *  charge may settle (a single call larger than that is proposed to the wallet instead). */
async function claimDebts(ctx: Ctx, chainKeyHash: string, swapId: string, token: string, limitPico: Pico | null): Promise<Claimed | null> {
  return ctx.db.transaction(async (tx) => {
    const debts = await tx.select().from(paywithDebts).where(and(eq(paywithDebts.chainKeyHash, chainKeyHash), isNull(paywithDebts.swapId))).orderBy(asc(paywithDebts.createdAt), asc(paywithDebts.id)).for("update");
    if (!debts.length) return null;
    const gens = await tx.select({ id: generations.id, leaf: generations.receiptLeaf }).from(generations).where(inArray(generations.id, debts.map((d) => d.generationId)));
    const leafOf = new Map(gens.filter((g) => g.leaf).map((g) => [g.id, g.leaf as Hex]));
    const ready = debts.filter((d) => leafOf.has(d.generationId)); // a call whose receipt is not stored yet waits
    if (!ready.length) return null;
    let mode: Claimed["mode"] = limitPico === null ? "signature" : "allowance";
    let picked = ready;
    if (limitPico !== null) {
      picked = [];
      let sum = 0n;
      for (const d of ready) {
        if (sum + d.amount > limitPico) break;
        picked.push(d);
        sum += d.amount;
      }
      if (!picked.length) {
        mode = "signature";
        picked = ready;
      }
    }
    const usdgOwed = picoToUsdg(picked.reduce((a, d) => a + d.amount, 0n), "ceil");
    if (usdgOwed <= 0n) return null;
    const leaves = picked.map((d) => leafOf.get(d.generationId)!);
    const usageCommitment = new MerkleTree(leaves).root.toLowerCase() as Hex;
    await tx.insert(paywithSwaps).values({ id: swapId, keyHash: chainKeyHash, token: token.toLowerCase(), usdgOut: usdgOwed, status: mode === "allowance" ? "submitted" : "awaiting_signature" });
    await tx.update(paywithDebts).set({ swapId }).where(inArray(paywithDebts.id, picked.map((d) => d.id)));
    // Lets the indexer match a charge whose receipt the aggregator never saw (e.g. a timed-out send).
    await tx.insert(kv).values({ key: `paywith-commitment:${usageCommitment}`, value: { swapId } }).onConflictDoUpdate({ target: kv.key, set: { value: { swapId }, updatedAt: new Date() } });
    return { mode, usdgOwed, count: picked.length, usageCommitment, generations: picked.map((d) => d.generationId), leaves };
  });
}

/** Propose a charge for the wallet to sign: exact USDG, a token maximum (twice the slippage headroom at
 *  today's fair price), the usage commitment, a fresh nonce and a 24h deadline. */
async function proposeCharge(ctx: Ctx, key: Hex, swapId: string, claimed: Claimed, onchain: PaywithSession, record: StoredCharge) {
  const router = ctx.chain.roleAddress("router");
  const q = router ? await ctx.chain.quoteMaxIn(onchain.token, claimed.usdgOwed, Math.min(2 * ctx.cfg.paywith.maxSlipBps, 1000)) : null;
  if (!router || !q) return failCharge(ctx, swapId, key, claimed.usageCommitment, new Error("No router key or price to prepare the charge."), "failed");
  const message: ChargeAuthorization = {
    keyHash: key.toLowerCase() as Hex,
    token: onchain.token.toLowerCase() as Hex,
    usdgAmount: claimed.usdgOwed,
    maxRaw: q.maxIn,
    usageCommitment: claimed.usageCommitment,
    nonce: BigInt(Date.now()) * 1_000n + BigInt(Math.floor(Math.random() * 1_000)),
    epoch: onchain.epoch,
    deadline: BigInt(nowS() + CHARGE_TTL_S),
    router: router.toLowerCase() as Hex,
  };
  await putKv(ctx, chargeKvKey(swapId), { ...record, message: jsonify(message), signature: null, wallet: onchain.wallet.toLowerCase() } satisfies StoredCharge);
  log.info("pay-with charge awaits the wallet's signature", { key, swapId });
  return { key, awaiting_signature: swapId, usdg: claimed.usdgOwed.toString(), debts: claimed.count, usage_commitment: claimed.usageCommitment };
}

/** Move a proposed charge on: submit it once signed; expire it after its deadline (or once revoked). A signed
 *  charge keeps its debts until it lands or can no longer land, so they are never authorized twice. */
async function advanceProposal(ctx: Ctx, sw: typeof paywithSwaps.$inferSelect): Promise<{ pending: boolean; result?: unknown }> {
  const key = sw.keyHash as Hex;
  const rec = await getKv<StoredCharge>(ctx, chargeKvKey(sw.id));
  const parsed = rec?.message ? chargeMessage.safeParse(rec.message) : null;
  if (!rec || !parsed?.success) return { pending: false, result: await failCharge(ctx, sw.id, key, rec?.usageCommitment ?? null, new Error("charge record missing or unreadable"), "failed") };
  const m = parsed.data;
  const expired = BigInt(nowS()) > m.deadline;
  if (!rec.signature) {
    if (!expired) return { pending: true };
    return { pending: false, result: await failCharge(ctx, sw.id, key, m.usageCommitment, new Error("The wallet did not sign the charge in time."), "expired") };
  }
  if (expired) return { pending: false, result: await failCharge(ctx, sw.id, key, m.usageCommitment, new Error("The signed charge expired before it settled."), "expired") };
  try {
    const r = await ctx.chain.payCall(m, rec.signature, ctx.cfg.paywith.maxSlipBps);
    await applyCharge(ctx, sw.id, key, m.usdgAmount, r);
    return { pending: false, result: { key, usdg: m.usdgAmount.toString(), debts: rec.generations.length, tx: r.hash, mode: "signature", usage_commitment: m.usageCommitment } };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    const s = await ctx.chain.session(key).catch(() => null);
    // Revoked or closed: the signature can never land any more, so the debts may be charged afresh
    // (failCharge keeps them claimed if this very charge did land).
    const dead = !!s && (!s.active || s.epoch !== m.epoch);
    if (dead || (await ctx.chain.commitmentCharged(key, m.usageCommitment).catch(() => false)))
      return { pending: false, result: await failCharge(ctx, sw.id, key, m.usageCommitment, e, "expired") };
    await ctx.db.update(paywithSwaps).set({ error: msg }).where(eq(paywithSwaps.id, sw.id));
    log.warn("signed pay-with charge failed; retrying until its deadline", { key, swapId: sw.id, error: msg });
    return { pending: true, result: { key, error: msg, retry: true } };
  }
}

async function applyCharge(ctx: Ctx, swapId: string, key: Hex, usdgOwed: bigint, r: { hash: Hex; logs: DecodedLog[] }) {
  await ctx.db.update(paywithSwaps).set({ tx: r.hash, status: "submitted", error: null }).where(eq(paywithSwaps.id, swapId));
  // Apply this transaction's events right away (Credited -> ledger credit; PaidWithStock -> allocations).
  await recordEvents(ctx, r.logs);
  await processEvents(ctx, { chainKeyHash: key });
  const paid = r.logs.find((d) => d.event === "PaidWithStock");
  if (paid)
    await allocateSwap(ctx, { keyHash: key, token: String(paid.args.token), rawSpent: paid.args.rawSpent as bigint, fairPrice18: String(paid.args.fairPrice18), usdgOwed, tx: r.hash, usageCommitment: String(paid.args.usageCommitment) });
}

/** A charge did not settle. If its usage commitment was charged on-chain anyway (the receipt was lost), keep
 *  the claim for the indexer to confirm; otherwise release the debts for a later charge. */
async function failCharge(ctx: Ctx, swapId: string, key: Hex, usageCommitment: Hex | null, e: unknown, status: "failed" | "expired") {
  const msg = (e as Error).message.slice(0, 300);
  if (usageCommitment && (await ctx.chain.commitmentCharged(key, usageCommitment).catch(() => false))) {
    await ctx.db.update(paywithSwaps).set({ status: "submitted", error: msg }).where(and(eq(paywithSwaps.id, swapId), inArray(paywithSwaps.status, ["submitted", "signed", "awaiting_signature"])));
    log.warn("pay-with charge landed without a receipt; the indexer confirms it", { key, swapId });
    return { key, error: msg, landed: true };
  }
  await ctx.db.transaction(async (tx) => {
    await tx.update(paywithSwaps).set({ status, error: msg }).where(eq(paywithSwaps.id, swapId));
    await tx.update(paywithDebts).set({ swapId: null }).where(eq(paywithDebts.swapId, swapId)); // back to open
  });
  log.warn(`pay-with charge ${status}; debt stays open`, { key, error: msg });
  return { key, error: msg, ...(status === "expired" ? { expired: swapId } : {}) };
}

// ---- dashboard views -----------------------------------------------------------------------------

/** Charges waiting for the wallet's signature (or signed and settling), with the typed data to sign. */
export async function chargeProposals(ctx: Ctx, chainKeyHash: string) {
  const rows = await ctx.db.select().from(paywithSwaps).where(and(eq(paywithSwaps.keyHash, chainKeyHash), inArray(paywithSwaps.status, ["awaiting_signature", "signed"]))).orderBy(asc(paywithSwaps.ts));
  const out = [];
  for (const sw of rows) {
    const rec = await getKv<StoredCharge>(ctx, chargeKvKey(sw.id));
    const parsed = rec?.message ? chargeMessage.safeParse(rec.message) : null;
    if (!rec || !parsed?.success) continue;
    const m = parsed.data;
    out.push({
      id: sw.id,
      status: sw.status,
      usdg_units: m.usdgAmount.toString(),
      usd: Number(m.usdgAmount) / 1e6,
      token: m.token,
      max_raw: m.maxRaw.toString(),
      usage_commitment: m.usageCommitment,
      generations: rec.generations,
      receipt_leaves: rec.leaves,
      deadline: new Date(Number(m.deadline) * 1000).toISOString(),
      typed_data: typedDataJson(chargeTypedData(ctx, m)),
    });
  }
  return out;
}

/** Attach the wallet's signature to a proposed charge; the aggregator submits it. */
export async function signCharge(ctx: Ctx, key: KeyRow, swapId: string, signature: Hex) {
  const [sw] = await ctx.db.select().from(paywithSwaps).where(and(eq(paywithSwaps.id, swapId), eq(paywithSwaps.keyHash, key.chainKeyHash)));
  if (!sw) fail(404, "Charge not found.", "not_found");
  if (sw.status !== "awaiting_signature") fail(409, `This charge is ${sw.status}, not awaiting a signature.`, "charge_not_pending");
  const rec = await getKv<StoredCharge>(ctx, chargeKvKey(swapId));
  if (!rec?.message) fail(404, "Charge not found.", "not_found");
  const m = chargeMessage.parse(rec.message);
  if (BigInt(nowS()) > m.deadline) fail(409, "This charge proposal expired; the router proposes a new one.", "charge_expired");
  let onchain: PaywithSession;
  try {
    onchain = await ctx.chain.session(key.chainKeyHash as Hex);
  } catch {
    fail(503, "The PayWithStock session could not be read from the chain.", "chain_unavailable");
  }
  if (!onchain.active || onchain.epoch !== m.epoch) fail(409, "The session was closed or its authorizations revoked since this charge was proposed.", "charge_stale");
  if (!(await ctx.chain.verifyWalletSignature(onchain.wallet, chargeTypedData(ctx, m), signature))) fail(403, "The signature is not the session wallet's.", "bad_signature");
  await putKv(ctx, chargeKvKey(swapId), { ...rec, signature } satisfies StoredCharge);
  await ctx.db.update(paywithSwaps).set({ status: "signed" }).where(and(eq(paywithSwaps.id, swapId), eq(paywithSwaps.status, "awaiting_signature")));
  return { id: swapId, status: "signed" };
}

/** The key's allowance as the dashboard shows it (registered on-chain or waiting for the next charge). */
export async function allowanceView(ctx: Ctx, chainKeyHash: string, onchain: PaywithSession) {
  const al = await usableAllowance(ctx, chainKeyHash, onchain);
  if (!al) return null;
  return { registered: al.registered, max_raw_total: al.maxRawTotal.toString(), max_raw_per_charge: al.maxRawPerCharge.toString(), remaining_raw: al.remainingRaw.toString(), valid_until: new Date(Number(al.validUntil) * 1000).toISOString() };
}

export async function statement(ctx: Ctx, chainKeyHash: string, month: string) {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const swaps = await ctx.db
    .select()
    .from(paywithSwaps)
    .where(and(eq(paywithSwaps.keyHash, chainKeyHash), eq(paywithSwaps.status, "confirmed"), gte(paywithSwaps.ts, from), lt(paywithSwaps.ts, to)))
    .orderBy(asc(paywithSwaps.ts));
  const byToken = new Map<string, bigint>();
  for (const s of swaps) byToken.set(s.token, (byToken.get(s.token) ?? 0n) + (s.rawSpent ?? 0n));
  const totals = [...byToken.entries()].map(([token, raw]) => {
    const t = ctx.cfg.paywith.tokens.find((x) => x.address.toLowerCase() === token);
    const dec = t?.decimals ?? 18;
    const whole = Number(raw) / 10 ** dec;
    const shown = whole.toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 20 });
    return { token, symbol: t?.symbol ?? "?", raw_spent: raw.toString(), amount: whole, line: `${shown} ${t?.symbol ?? "tokens"} spent on inference` };
  });
  const pending = await openDebt(ctx, chainKeyHash);
  return {
    month,
    swaps: swaps.map((s) => ({ tx: s.tx, token: s.token, raw_spent: s.rawSpent?.toString() ?? null, fair_price: s.fairPrice, usdg: s.usdgOut.toString(), at: s.ts.toISOString(), allocations: s.allocations })),
    totals,
    pending_usd: Number(pending) / 1e12,
  };
}
