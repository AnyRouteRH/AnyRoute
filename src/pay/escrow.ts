import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { AnyrEscrow } from "../config.ts";
import type { EscrowFinality, EscrowTransfer } from "../chain/service.ts";
import { v4Twap } from "../chain/twap.ts";
import type { Db, Tx } from "../db/client.ts";
import { chainCursor, escrowDeposits, kv } from "../db/schema.ts";
import { balanceOf, ensureAccount, post } from "../ledger/ledger.ts";
import { mulBps, usdToPico, type Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { rawToPico } from "./paywith.ts";

// "Pay with stock", escrow edition. A customer sends an allowlisted Stock Token from their own wallet
// to the operator's escrow wallet. Once the transfer's block is final, the sending wallet's account
// (w_<address>, the same account wallet sign-in uses) is credited at the Chainlink price minus a
// haircut. Credits are spendable on inference only; the tokens stay in escrow. No Anyroute contract
// is involved.
//
// $ANYR (when ANYR_TOKEN_ADDRESS is set) is accepted the same way, with the same finality, reorganization
// and idempotency rules. It has no Chainlink feed, so it is priced from its pools (ANYR_POOL_LEGS, the
// lower of spot and the time-weighted average), minus its own ANYR_ESCROW_HAIRCUT_BPS. No trustworthy
// price leaves the deposit pending. One deposit is credited at most ANYR_ESCROW_MAX_USD_PER_DEPOSIT: the
// rest is not credited, and the deposit is flagged for operator review (refund or credit it by hand).
//
// A credit must never outlive the transfer that paid for it, so:
// - Only blocks at or below the chain's finality point (ESCROW_FINALITY, with CHAIN_CONFIRMATIONS as an
//   extra floor) are scanned for crediting. Newer transfers are shown as `pending_finality` only.
// - The scan keeps (block, hash) checkpoints. When the newest one is no longer canonical it rewinds to
//   the newest one that still is and scans again, so no transfer in a replaced range is skipped.
// - Before crediting, the block hash recorded with the transfer must still be canonical and the
//   transaction's receipt must still hold exactly that Transfer log; otherwise the deposit is `orphaned`.
// - Credits are re-verified for ESCROW_REORG_HORIZON_BLOCKS. A credit whose transfer left the canonical
//   chain gets one compensating debit (`escrow-reversal:<id>`) and becomes `reversed`. If it was already
//   spent the balance goes negative, which blocks all spending until it is covered. Every reversal, and
//   every orphan found after finality, is flagged for operator review and fails readiness until reviewed.

const CURSOR = "escrow"; // last block scanned at or below the finality point
const PREVIEW = "escrow-preview"; // last block scanned above it (display only; never credited from)
const CHECKPOINTS = "escrow:checkpoints";
const KEEP_CHECKPOINTS = 64;
const RECONCILE_EVERY_MS = 60_000;
const RECHECK_AFTER_MS = 10 * 60_000;
const DROPPED = "Dropped before its block was final; nothing was credited.";

export type EscrowStatus = "pending_finality" | "pending" | "credited" | "orphaned" | "reversed";
export type EscrowPrice = { price18: bigint; updatedAt: number };
/** The chain's finality point plus `creditable`: the highest block whose transfers may be credited. */
export type EscrowFinal = EscrowFinality & { creditable: bigint };
type Deposit = typeof escrowDeposits.$inferSelect;
type Checkpoint = { block: bigint; hash: string };
type Verdict = { ok: true; blockNumber: bigint; blockHash: string } | { ok: false; reason: string; unknown?: boolean };

export const escrowEnabled = (ctx: Ctx) => !!ctx.cfg.escrow.address && (ctx.cfg.escrow.tokens.length > 0 || !!ctx.cfg.anyrEscrow);
export const escrowAccountId = (wallet: string) => `w_${wallet.toLowerCase().slice(2)}`;

/** A token escrow accepts: a Stock Token priced by its Chainlink feed, or $ANYR priced from its pools. */
export type AcceptedToken = { symbol: string; address: string; decimals: number; haircutBps: number } & (
  | { kind: "stock"; feed: string; maxCredit: null }
  | { kind: "anyr"; anyr: AnyrEscrow; maxCredit: Pico }
);

export function acceptedTokens(ctx: Ctx): AcceptedToken[] {
  const stocks: AcceptedToken[] = ctx.cfg.escrow.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, haircutBps: ctx.cfg.escrow.haircutBps, kind: "stock", feed: t.feed, maxCredit: null }));
  const a = ctx.cfg.anyrEscrow;
  if (!a) return stocks;
  return [...stocks, { symbol: a.symbol, address: a.address, decimals: a.decimals, haircutBps: a.haircutBps, kind: "anyr", anyr: a, maxCredit: usdToPico(a.maxUsdPerDeposit, "floor") }];
}
const acceptedToken = (ctx: Ctx, address: string) => acceptedTokens(ctx).find((t) => t.address.toLowerCase() === address.toLowerCase());

const priceCache = new Map<string, { at: number; price: EscrowPrice | null }>();
const inflight = new Map<string, Promise<EscrowPrice | null>>();
export const clearEscrowPriceCache = () => {
  priceCache.clear();
  inflight.clear();
};

/** USD per whole token (18 decimals), or null when the feed is unreadable, non-positive or stale. */
export async function escrowPrice(ctx: Ctx, feed: string): Promise<EscrowPrice | null> {
  const hit = priceCache.get(feed);
  if (hit && Date.now() - hit.at < 15_000) return hit.price;
  let price: EscrowPrice | null = null;
  try {
    const r = await ctx.chain.readFeed(feed as Hex);
    const age = Date.now() / 1000 - r.updatedAt;
    if (r.answer > 0n && r.decimals <= 36 && r.updatedAt > 0 && age <= ctx.cfg.escrow.maxPriceAgeS && age > -300)
      price = { price18: r.decimals <= 18 ? r.answer * 10n ** BigInt(18 - r.decimals) : r.answer / 10n ** BigInt(r.decimals - 18), updatedAt: r.updatedAt };
  } catch (err) {
    log.warn("escrow price feed unreadable", { feed, error: (err as Error).message.slice(0, 200) });
  }
  priceCache.set(feed, { at: Date.now(), price });
  return price;
}

// The TWAP reads several blocks and logs, and /api/v1/escrow is public: one computation per 30 s per process,
// shared by concurrent callers, whether it produced a price or not.
const ANYR_PRICE_TTL_MS = 30_000;
const USDG_DECIMALS = 6;
const twapState: { blockRate?: number } = {};
/** The pool TWAP used to price $ANYR (chain/twap.ts); replaceable in tests. */
export const anyrPricing = { twap: v4Twap };

/**
 * USD per whole ANYR (18 decimals): the lower of spot and the BUYBACK_TWAP_MINUTES average through
 * ANYR_POOL_LEGS, in USDG. Null when a pool is unreadable or too thin, or spot is more than
 * ANYR_ESCROW_MAX_DEVIATION (default BUYBACK_MAX_DEVIATION) from the average.
 */
export async function anyrEscrowPrice(ctx: Ctx, a: AnyrEscrow): Promise<EscrowPrice | null> {
  const key = `anyr:${a.address}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < ANYR_PRICE_TTL_MS) return hit.price;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      let price: EscrowPrice | null = null;
      try {
        const r = await anyrPricing.twap(ctx.chain.client, ctx.cfg.chain.poolManager, a.legs, {
          windowSeconds: ctx.cfg.buyback.twapMinutes * 60,
          maxDeviation: a.maxDeviation,
          decimalsAdjust: 10 ** (a.decimals - USDG_DECIMALS),
          state: twapState,
        });
        const usd = r.conservative;
        const price18 = Number.isFinite(usd) && usd > 0 ? BigInt(Math.floor(usd * 1e18)) : 0n;
        if (price18 > 0n) price = { price18, updatedAt: Math.floor(Date.now() / 1000) };
        else log.warn("no trustworthy ANYR price", { error: "non-positive price" });
      } catch (err) {
        log.warn("no trustworthy ANYR price", { error: (err as Error).message.slice(0, 200) });
      }
      priceCache.set(key, { at: Date.now(), price });
      return price;
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

const tokenPrice = (ctx: Ctx, t: AcceptedToken) => (t.kind === "anyr" ? anyrEscrowPrice(ctx, t.anyr) : escrowPrice(ctx, t.feed));

/** Credits (pico-USD) for `raw` token units at `price18`, after the haircut (the stock one by default), rounded down. */
export const escrowCredit = (ctx: Ctx, raw: bigint, decimals: number, price18: bigint, haircutBps = ctx.cfg.escrow.haircutBps): Pico =>
  mulBps(rawToPico(raw, decimals, price18), 10_000 - haircutBps, "floor");

/** Pico-USD as dollars and cents, rounded down (for notes). */
const usd2 = (p: Pico) => {
  const cents = p / 10_000_000_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

export function formatRaw(raw: bigint, decimals: number, maxFraction = 6) {
  const unit = 10n ** BigInt(decimals);
  const frac = (raw % unit).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${raw / unit}${frac ? "." + frac : ""}`;
}

// A wrong `decimals` in configuration would misprice every deposit by powers of ten, so each token's
// on-chain decimals are checked once per process before anything is credited.
const verified = new WeakMap<Ctx, Promise<void>>();
function verifyTokens(ctx: Ctx) {
  let p = verified.get(ctx);
  if (!p) {
    p = (async () => {
      for (const t of acceptedTokens(ctx)) {
        const onchain = await ctx.chain.tokenDecimals(t.address as Hex);
        if (onchain !== t.decimals) throw new Error(`${t.symbol} has ${onchain} decimals on-chain but ${t.decimals} in configuration`);
      }
    })();
    p.catch(() => verified.delete(ctx));
    verified.set(ctx, p);
  }
  return p;
}

/** The chain head, its finality point, and the highest block the watcher may credit from. */
export async function escrowFinality(ctx: Ctx): Promise<EscrowFinal> {
  const f = await ctx.chain.escrowFinality(ctx.cfg.escrow.finality);
  const floor = f.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  return { ...f, finalHash: f.finalHash.toLowerCase() as Hex, creditable: f.final < floor ? f.final : floor };
}

async function canonicalHash(ctx: Ctx, n: bigint) {
  const h = await ctx.chain.blockHashAt(n);
  if (!h) throw new Error(`block ${n} is not available from the RPC node yet`);
  return h.toLowerCase();
}

async function loadCheckpoints(db: Db): Promise<Checkpoint[]> {
  const [row] = await db.select().from(kv).where(eq(kv.key, CHECKPOINTS));
  const points = (row?.value as { points?: { block: string; hash: string }[] } | undefined)?.points ?? [];
  return points.map((p) => ({ block: BigInt(p.block), hash: p.hash }));
}

async function saveProgress(db: Db | Tx, block: bigint, points: Checkpoint[]) {
  await db.insert(chainCursor).values({ id: CURSOR, block }).onConflictDoUpdate({ target: chainCursor.id, set: { block, updatedAt: new Date() } });
  const value = { points: points.slice(-KEEP_CHECKPOINTS).map((p) => ({ block: p.block.toString(), hash: p.hash })) };
  await db.insert(kv).values({ key: CHECKPOINTS, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

function toRows(ctx: Ctx, transfers: EscrowTransfer[]) {
  const byAddress = new Map(acceptedTokens(ctx).map((t) => [t.address.toLowerCase(), t]));
  return transfers.flatMap((t) => {
    const tok = byAddress.get(t.token.toLowerCase());
    if (!tok) return [];
    const txHash = t.txHash.toLowerCase();
    return [{ id: `${txHash}:${t.logIndex}`, txHash, logIndex: t.logIndex, blockNumber: t.blockNumber, blockHash: t.blockHash?.toLowerCase() ?? null, token: t.token.toLowerCase(), symbol: tok.symbol, fromAddress: t.from.toLowerCase(), rawAmount: t.value.toString() }];
  });
}
type Row = ReturnType<typeof toRows>[number];

/** Record transfers found at or below the finality point. Returns how many became `pending`. */
async function recordFinal(tx: Tx, rows: Row[]) {
  if (!rows.length) return 0;
  const inserted = await tx.insert(escrowDeposits).values(rows.map((r) => ({ ...r, status: "pending" }))).onConflictDoNothing().returning({ id: escrowDeposits.id });
  let recorded = inserted.length;
  const fresh = new Set(inserted.map((r) => r.id));
  const clashes = new Map(rows.filter((r) => !fresh.has(r.id)).map((r) => [r.id, r]));
  if (!clashes.size) return recorded;
  const existing = await tx.select().from(escrowDeposits).where(inArray(escrowDeposits.id, [...clashes.keys()])).for("update");
  for (const e of existing) {
    const { id, ...facts } = clashes.get(e.id)!;
    const same = e.token === facts.token && e.fromAddress === facts.fromAddress && BigInt(e.rawAmount) === BigInt(facts.rawAmount);
    const moved = e.blockNumber !== facts.blockNumber || e.blockHash !== facts.blockHash;
    if (e.status === "pending_finality" || e.status === "pending" || e.status === "orphaned") {
      // Never credited: the final, canonical copy of the log is what gets credited.
      if (e.status !== "pending" || !same || moved) await tx.update(escrowDeposits).set({ ...facts, status: "pending", error: null }).where(eq(escrowDeposits.id, id));
      if (e.status !== "pending") recorded++;
    } else if (e.status === "credited" && same) {
      if (moved) {
        await tx.update(escrowDeposits).set({ blockNumber: facts.blockNumber, blockHash: facts.blockHash }).where(eq(escrowDeposits.id, id));
        if (e.blockHash) log.warn("credited escrow transfer is canonical in a different block", { id, block: facts.blockNumber });
      }
    } else if (!e.reviewReason || e.reviewedAt) {
      const reason = e.status === "reversed" ? "a reversed deposit is back on the canonical chain" : "the transfer log of a credited deposit changed";
      await tx.update(escrowDeposits).set({ reviewReason: reason, reviewedAt: null }).where(eq(escrowDeposits.id, id));
      log.error(`escrow deposit needs review: ${reason}`, { id, status: e.status });
    }
  }
  return recorded;
}

/** Scan (cursor, creditable] for transfers into escrow, rewinding first if the scanned range was reorganized. */
async function scanFinal(ctx: Ctx, fin: EscrowFinal, maxRange: bigint) {
  const tokens = acceptedTokens(ctx).map((t) => t.address as Hex);
  const escrow = ctx.cfg.escrow.address as Hex;
  const [cur] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, CURSOR));
  let points: Checkpoint[] = [];
  let cursor: bigint;
  let rewoundTo: bigint | null = null;
  if (!cur) {
    cursor = (ctx.cfg.escrow.startBlock ?? (fin.creditable > 5_000n ? fin.creditable - 5_000n : 0n)) - 1n;
  } else {
    points = (await loadCheckpoints(ctx.db)).filter((p) => p.block <= cur.block);
    let base: Checkpoint | undefined;
    for (let i = points.length - 1; i >= 0 && !base; i--) if ((await canonicalHash(ctx, points[i].block)) === points[i].hash) base = points[i];
    if (base) {
      if (base !== points.at(-1)) log.error("escrow scan range was reorganized; rescanning from the last canonical checkpoint", { from: base.block, was: cur.block });
      points = points.filter((p) => p.block <= base.block);
      cursor = base.block;
      if (cursor !== cur.block) await saveProgress(ctx.db, cursor, points);
    } else {
      // No checkpoint yet (a cursor written before checkpoints existed, or moved by hand), or none of them is
      // canonical any more: trust nothing above the finality point and, after a deep reorganization, rescan
      // the whole re-verification horizon.
      if (points.length) log.error("escrow scan range was reorganized below every checkpoint; rescanning the horizon", { was: cur.block });
      const floor = ctx.cfg.escrow.startBlock ? ctx.cfg.escrow.startBlock - 1n : 0n; // the cursor is the last block scanned
      const back = points.length ? cur.block - BigInt(ctx.cfg.escrow.reorgHorizonBlocks) : cur.block < fin.creditable ? cur.block : fin.creditable;
      cursor = back > floor ? back : floor;
      points = [{ block: cursor, hash: await canonicalHash(ctx, cursor) }];
      await saveProgress(ctx.db, cursor, points);
    }
    if (cursor < cur.block) rewoundTo = cursor;
  }
  let from = cursor + 1n;
  let recorded = 0;
  while (from <= fin.creditable) {
    const to = from + maxRange - 1n < fin.creditable ? from + maxRange - 1n : fin.creditable;
    const hash = await canonicalHash(ctx, to);
    const rows = toRows(ctx, await ctx.chain.escrowTransfers(tokens, escrow, from, to));
    if ((await canonicalHash(ctx, to)) !== hash) throw new Error("the chain changed during the escrow scan; retrying on the next poll");
    await ctx.db.transaction(async (tx) => {
      recorded += await recordFinal(tx, rows);
      // Anything shown before finality that the final scan did not find again was dropped by a reorganization.
      await tx.update(escrowDeposits).set({ status: "orphaned", error: DROPPED }).where(and(eq(escrowDeposits.status, "pending_finality"), lte(escrowDeposits.blockNumber, to)));
      points.push({ block: to, hash });
      await saveProgress(tx, to, points);
    });
    cursor = to;
    from = to + 1n;
  }
  return { cursor, recorded, rewoundTo };
}

/** Show transfers above the finality point as `pending_finality`. Display only: nothing here is credited. */
async function scanPreview(ctx: Ctx, fin: EscrowFinal, finalCursor: bigint, maxRange: bigint) {
  const tokens = acceptedTokens(ctx).map((t) => t.address as Hex);
  const [pc] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, PREVIEW));
  let from = (pc && pc.block > finalCursor ? pc.block : finalCursor) + 1n;
  let seen = 0;
  while (from <= fin.head) {
    const to = from + maxRange - 1n < fin.head ? from + maxRange - 1n : fin.head;
    const rows = toRows(ctx, await ctx.chain.escrowTransfers(tokens, ctx.cfg.escrow.address as Hex, from, to));
    if (rows.length) seen += (await ctx.db.insert(escrowDeposits).values(rows.map((r) => ({ ...r, status: "pending_finality" }))).onConflictDoNothing().returning({ id: escrowDeposits.id })).length;
    await ctx.db.insert(chainCursor).values({ id: PREVIEW, block: to }).onConflictDoUpdate({ target: chainCursor.id, set: { block: to, updatedAt: new Date() } });
    from = to + 1n;
  }
  return seen;
}

const lastReconcile = new WeakMap<Ctx, number>();

/** Record new transfers into escrow, credit final ones that can be priced, and re-verify recent credits. */
export async function pollEscrow(ctx: Ctx, maxRange = 2_000n) {
  if (!escrowEnabled(ctx)) return { skipped: "escrow not configured" };
  await verifyTokens(ctx);
  const fin = await escrowFinality(ctx);
  const scan = await scanFinal(ctx, fin, maxRange);
  const seen = await scanPreview(ctx, fin, scan.cursor, maxRange);
  const credit = await creditEscrowDeposits(ctx, fin);
  // Re-verification is cheap but not free: once a minute, and at once over any range the scan rewound.
  const due = scan.rewoundTo !== null || Date.now() - (lastReconcile.get(ctx) ?? 0) >= RECONCILE_EVERY_MS;
  const rec = due ? await reconcileEscrowDeposits(ctx, { fin, since: scan.rewoundTo ?? undefined }) : { reversed: 0 };
  return { head: fin.head.toString(), final: fin.final.toString(), recorded: scan.recorded, seen, ...credit, reversed: rec.reversed };
}

/** Pre-credit check: the recorded block is still canonical and its receipt still holds exactly this Transfer log. */
async function verifyForCredit(ctx: Ctx, d: Deposit): Promise<Verdict> {
  const canonical = (await ctx.chain.blockHashAt(d.blockNumber))?.toLowerCase();
  if (!canonical) return { ok: false, unknown: true, reason: `block ${d.blockNumber} is not available from the RPC node yet` };
  if (d.blockHash && canonical !== d.blockHash) return { ok: false, reason: `block ${d.blockNumber} was replaced by a chain reorganization` };
  const r = await ctx.chain.escrowReceipt(d.txHash as Hex, ctx.cfg.escrow.address as Hex);
  if (!r) return { ok: false, reason: "the transaction is not on the canonical chain" };
  if (!r.success) return { ok: false, reason: "the transaction reverted" };
  if (r.blockNumber !== d.blockNumber) return { ok: false, reason: `the transaction moved to block ${r.blockNumber}` };
  if (r.blockHash.toLowerCase() !== canonical) return { ok: false, unknown: true, reason: "the RPC node returned inconsistent block and receipt data" };
  if (!matches(d, r.transfers)) return { ok: false, reason: "the transaction no longer contains this transfer" };
  return { ok: true, blockNumber: d.blockNumber, blockHash: canonical };
}

/** Re-verification of a credit: still canonical where recorded, or (same log index) canonical in another final block. */
async function verifyCredited(ctx: Ctx, d: Deposit, fin: EscrowFinal): Promise<Verdict> {
  const canonical = (await ctx.chain.blockHashAt(d.blockNumber))?.toLowerCase();
  if (!canonical) return { ok: false, unknown: true, reason: `block ${d.blockNumber} is not available from the RPC node yet` };
  if (d.blockHash === canonical) return { ok: true, blockNumber: d.blockNumber, blockHash: canonical };
  // The block at that height changed, or this credit predates recorded block hashes: look up the transaction itself.
  const r = await ctx.chain.escrowReceipt(d.txHash as Hex, ctx.cfg.escrow.address as Hex);
  if (!r) return { ok: false, reason: "the transaction is no longer on the canonical chain" };
  if (!r.success) return { ok: false, reason: "the transaction reverted" };
  if (!matches(d, r.transfers)) return { ok: false, reason: "the transaction no longer contains this transfer" };
  const at = r.blockNumber === d.blockNumber ? canonical : (await ctx.chain.blockHashAt(r.blockNumber))?.toLowerCase();
  if (!at || at !== r.blockHash.toLowerCase()) return { ok: false, unknown: true, reason: "the RPC node returned inconsistent block and receipt data" };
  if (r.blockNumber > fin.creditable) return { ok: false, unknown: true, reason: `the transaction moved to block ${r.blockNumber}, which is not final yet` };
  return { ok: true, blockNumber: r.blockNumber, blockHash: at };
}

const matches = (d: Deposit, transfers: { token: Hex; from: Hex; value: bigint; logIndex: number }[]) =>
  transfers.some((t) => t.logIndex === d.logIndex && t.token.toLowerCase() === d.token && t.from.toLowerCase() === d.fromAddress && t.value === BigInt(d.rawAmount));

async function orphan(ctx: Ctx, d: Deposit, reason: string) {
  const [row] = await ctx.db
    .update(escrowDeposits)
    .set({ status: "orphaned", error: `Not credited: ${reason}.`, reviewReason: `orphaned after finality: ${reason}`, reviewedAt: null })
    .where(and(eq(escrowDeposits.id, d.id), eq(escrowDeposits.status, d.status)))
    .returning({ id: escrowDeposits.id });
  // A transfer at or below the finality point should never disappear: this is a finality failure or a faulty RPC node.
  if (row) log.error("final escrow transfer is not canonical; not credited", { id: d.id, block: d.blockNumber, reason });
  return !!row;
}

/** Credit final, pending deposits at the current price. Idempotent: the ledger ref is unique per transfer. */
export async function creditEscrowDeposits(ctx: Ctx, fin?: EscrowFinal) {
  fin ??= await escrowFinality(ctx);
  const pending = await ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.status, "pending")).orderBy(asc(escrowDeposits.blockNumber), asc(escrowDeposits.logIndex)).limit(500);
  let credited = 0;
  let waiting = 0;
  let orphaned = 0;
  for (const d of pending) {
    // Rows recorded before finality gating existed can sit above the finality point: they wait for it.
    if (d.blockNumber > fin.creditable) {
      waiting++;
      continue;
    }
    const tok = acceptedToken(ctx, d.token);
    const price = tok ? await tokenPrice(ctx, tok) : null;
    if (!tok || !price) {
      const error = tok ? `waiting for a fresh ${tok.symbol} price` : "token is no longer accepted; needs operator review";
      if (d.error !== error) await ctx.db.update(escrowDeposits).set({ error }).where(and(eq(escrowDeposits.id, d.id), eq(escrowDeposits.status, "pending")));
      waiting++;
      continue;
    }
    let v: Verdict;
    try {
      v = await verifyForCredit(ctx, d);
    } catch (err) {
      v = { ok: false, unknown: true, reason: (err as Error).message.slice(0, 200) };
    }
    if (!v.ok) {
      if (v.unknown) {
        log.warn("escrow transfer could not be verified yet", { id: d.id, reason: v.reason });
        waiting++;
      } else if (await orphan(ctx, d, v.reason)) orphaned++;
      continue;
    }
    const raw = BigInt(d.rawAmount);
    const full = escrowCredit(ctx, raw, tok.decimals, price.price18, tok.haircutBps);
    // Above the per-deposit limit only the limit is credited; the rest waits for the operator.
    const amount = tok.maxCredit !== null && full > tok.maxCredit ? tok.maxCredit : full;
    const over = amount < full ? { value: usd2(full), limit: usd2(amount) } : null;
    const accountId = escrowAccountId(d.fromAddress);
    const done = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.select().from(escrowDeposits).where(eq(escrowDeposits.id, d.id)).for("update");
      if (!row || row.status !== "pending" || row.blockNumber !== v.blockNumber) return false;
      await ensureAccount(tx, accountId, "wallet", d.fromAddress);
      if (amount > 0n)
        await post(tx, {
          accountId,
          amount,
          kind: tok.kind === "anyr" ? "anyr_deposit" : "stock_deposit",
          ref: `escrow:${d.id}`,
          description: `${formatRaw(raw, tok.decimals)} ${tok.symbol} sent to escrow (${d.txHash})${over ? `; credited up to the $${over.limit} per-deposit limit` : ""}`,
        });
      const now = new Date();
      const review = over
        ? {
            error: `Credited $${over.limit} of $${over.value}: ${tok.symbol} deposits are credited up to $${over.limit} each. The rest is held for operator review.`,
            reviewReason: `${tok.symbol} deposit above the per-deposit limit: credited $${over.limit} of $${over.value}; refund or credit the rest by hand`,
            reviewedAt: null,
          }
        : { error: null };
      await tx
        .update(escrowDeposits)
        .set({ status: "credited", accountId, blockHash: v.blockHash, price18: price.price18.toString(), priceUpdatedAt: new Date(price.updatedAt * 1000), credited: amount, creditedAt: now, checkedAt: now, ...review })
        .where(eq(escrowDeposits.id, d.id));
      return true;
    });
    if (done) credited++;
    if (done && over) log.error("escrow deposit above the per-deposit limit: credited only the limit; needs operator review", { id: d.id, symbol: tok.symbol, value_usd: over.value, credited_usd: over.limit });
  }
  return { credited, waiting, orphaned };
}

/** Post the compensating debit for a credit whose transfer left the canonical chain. Idempotent. */
async function reverse(ctx: Ctx, d: Deposit, reason: string) {
  const out = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(escrowDeposits).where(eq(escrowDeposits.id, d.id)).for("update");
    if (!row || row.status !== "credited") return null;
    const amount = row.credited ?? 0n;
    const accountId = row.accountId ?? escrowAccountId(row.fromAddress);
    if (amount > 0n) {
      await ensureAccount(tx, accountId, "wallet", row.fromAddress);
      const kind = row.token === ctx.cfg.anyrEscrow?.address ? "anyr_deposit_reversal" : "stock_deposit_reversal";
      await post(tx, { accountId, amount: -amount, kind, ref: `escrow-reversal:${row.id}`, description: `Reversed ${row.symbol} escrow credit: ${reason} (${row.txHash})` });
    }
    await tx
      .update(escrowDeposits)
      .set({ status: "reversed", reversedAt: new Date(), error: `Credit reversed: ${reason}.`, reviewReason: `credit reversed: ${reason}`, reviewedAt: null })
      .where(eq(escrowDeposits.id, row.id));
    return { accountId, amount };
  });
  if (!out) return false;
  const bal = await balanceOf(ctx.db, out.accountId);
  // A negative available balance refuses every reservation, so a spent credit freezes the account
  // until a later deposit (or the operator) covers it.
  log.error("escrow credit reversed: its transfer left the canonical chain", { id: d.id, tx: d.txHash, account: out.accountId, reversed: out.amount, balance: bal.balance, frozen: bal.available < 0n, reason });
  return true;
}

/**
 * Re-verify credits whose blocks are within ESCROW_REORG_HORIZON_BLOCKS of the finality point (each at most
 * every 10 minutes), plus every credit recorded without a block hash and, after a rewind, every credit above
 * `since`. A credit whose transfer is no longer canonical is reversed.
 */
export async function reconcileEscrowDeposits(ctx: Ctx, opts: { fin?: EscrowFinal; since?: bigint } = {}) {
  if (!escrowEnabled(ctx)) return { checked: 0, reversed: 0, unknown: 0 };
  const fin = opts.fin ?? (await escrowFinality(ctx));
  lastReconcile.set(ctx, Date.now());
  const d = escrowDeposits;
  const horizon = fin.final - BigInt(ctx.cfg.escrow.reorgHorizonBlocks);
  const due = or(isNull(d.checkedAt), lt(d.checkedAt, new Date(Date.now() - RECHECK_AFTER_MS)));
  const inWindow = or(isNull(d.blockHash), and(gte(d.blockNumber, horizon), due));
  const rows = await ctx.db
    .select()
    .from(d)
    .where(and(eq(d.status, "credited"), opts.since !== undefined ? or(gt(d.blockNumber, opts.since), inWindow) : inWindow))
    .orderBy(sql`${d.checkedAt} asc nulls first`, asc(d.blockNumber))
    .limit(200);
  let checked = 0;
  let reversed = 0;
  let unknown = 0;
  for (const row of rows) {
    let v: Verdict;
    try {
      v = await verifyCredited(ctx, row, fin);
    } catch (err) {
      v = { ok: false, unknown: true, reason: (err as Error).message.slice(0, 200) };
    }
    if (v.ok) {
      await ctx.db.update(d).set({ checkedAt: new Date(), blockNumber: v.blockNumber, blockHash: v.blockHash }).where(and(eq(d.id, row.id), eq(d.status, "credited")));
      if (row.blockHash && (row.blockNumber !== v.blockNumber || row.blockHash !== v.blockHash)) log.warn("credited escrow transfer is canonical in a different block", { id: row.id, block: v.blockNumber });
      checked++;
    } else if (v.unknown) {
      log.warn("escrow credit could not be re-verified yet", { id: row.id, reason: v.reason });
      unknown++;
    } else if (await reverse(ctx, row, v.reason)) reversed++;
  }
  return { checked, reversed, unknown };
}

/** Deposits an operator still has to look at (reversals and orphans found after finality). */
export async function escrowReviewsOpen(db: Db) {
  return db
    .select({ id: escrowDeposits.id, status: escrowDeposits.status, reason: escrowDeposits.reviewReason })
    .from(escrowDeposits)
    .where(and(isNotNull(escrowDeposits.reviewReason), isNull(escrowDeposits.reviewedAt)))
    .limit(50);
}

/** Operator: mark a flagged deposit as reconciled (after covering or writing off any shortfall). */
export async function markEscrowReviewed(db: Db, id: string) {
  const rows = await db.update(escrowDeposits).set({ reviewedAt: new Date() }).where(and(eq(escrowDeposits.id, id), isNotNull(escrowDeposits.reviewReason))).returning({ id: escrowDeposits.id });
  return rows.length > 0;
}

const finalityCache = new WeakMap<Ctx, { at: number; fin: EscrowFinal | null }>();
async function cachedFinality(ctx: Ctx) {
  const hit = finalityCache.get(ctx);
  if (hit && Date.now() - hit.at < 15_000) return hit.fin;
  const fin = await escrowFinality(ctx).catch(() => null);
  finalityCache.set(ctx, { at: Date.now(), fin });
  return fin;
}

/** Public payment instructions with live rates. */
export async function escrowInfo(ctx: Ctx) {
  if (!escrowEnabled(ctx)) return { enabled: false as const };
  const [fin, tokens] = await Promise.all([
    cachedFinality(ctx),
    Promise.all(
      acceptedTokens(ctx).map(async (t) => {
        const price = await tokenPrice(ctx, t);
        const one = 10n ** BigInt(t.decimals);
        return {
          symbol: t.symbol,
          address: t.address.toLowerCase(),
          decimals: t.decimals,
          // chainlink: the token's feed; twap: the lower of spot and the time-weighted average of its pools
          price_source: t.kind === "anyr" ? ("twap" as const) : ("chainlink" as const),
          price_usd: price ? Number(rawToPico(one, t.decimals, price.price18)) / 1e12 : null,
          credit_usd_per_token: price ? Number(escrowCredit(ctx, one, t.decimals, price.price18, t.haircutBps)) / 1e12 : null,
          price_updated_at: price ? new Date(price.updatedAt * 1000).toISOString() : null,
          haircut_bps: t.haircutBps,
          // The most one deposit is credited (null: no limit); the rest is held for operator review.
          max_usd_per_deposit: t.kind === "anyr" ? t.anyr.maxUsdPerDeposit : null,
        };
      }),
    ),
  ]);
  return {
    enabled: true as const,
    address: ctx.cfg.escrow.address,
    chain_id: ctx.cfg.chain.id,
    explorer: ctx.cfg.chain.explorerUrl,
    // Transfers are credited once their block is at or below the chain's `finality` block and has at least
    // `confirmations`. expected_credit_delay_s is how far that point trails the chain head right now.
    finality: ctx.cfg.escrow.finality,
    confirmations: ctx.cfg.chain.confirmations,
    expected_credit_delay_s: fin ? Math.max(0, fin.headTime - fin.finalTime) : null,
    haircut_bps: ctx.cfg.escrow.haircutBps, // Stock Tokens; each token lists its own haircut_bps
    anyr: anyrSummary(ctx),
    tokens,
  };
}

export async function escrowDepositsFor(ctx: Ctx, accountId: string, limit = 50) {
  const rows = await ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.fromAddress, accountId.startsWith("w_") ? `0x${accountId.slice(2)}` : "")).orderBy(desc(escrowDeposits.blockNumber), desc(escrowDeposits.logIndex)).limit(limit);
  return rows.map((d) => {
    const tok = acceptedToken(ctx, d.token);
    return {
      id: d.id,
      tx_hash: d.txHash,
      block: d.blockNumber.toString(),
      symbol: d.symbol,
      amount: tok ? formatRaw(BigInt(d.rawAmount), tok.decimals) : null,
      raw_amount: d.rawAmount,
      status: d.status as EscrowStatus,
      credited_usd: d.credited != null ? Number(d.credited) / 1e12 : null,
      price_usd: d.price18 ? Number(BigInt(d.price18) / 10n ** 12n) / 1e6 : null,
      note: d.error,
      at: (d.reversedAt ?? d.creditedAt ?? d.createdAt).toISOString(),
    };
  });
}

/** $ANYR escrow terms for public status and payment instructions; null when ANYR is not accepted. */
export function anyrSummary(ctx: Ctx) {
  const a = ctx.cfg.anyrEscrow;
  if (!a || !escrowEnabled(ctx)) return null;
  return { symbol: a.symbol, address: a.address, decimals: a.decimals, haircut_bps: a.haircutBps, max_usd_per_deposit: a.maxUsdPerDeposit, price_source: "twap" as const, twap_minutes: ctx.cfg.buyback.twapMinutes };
}
