import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { paywithDebts, paywithSessions, paywithSwaps } from "../db/schema.ts";
import { minPico, mulBps, type Pico, picoToUsdg, PICO_PER_USD, usdToPico } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { allocateSwap, processEvents, recordEvents } from "../chain/indexer.ts";

// "Your NVDA pays for your AI." A key with an open PayWithStock session may run up to a small,
// cap-bounded USD debt; the aggregator settles it on-chain at >= $1 (or 24h) by swapping exactly
// the USDG owed from the session wallet at fair value. If the oracle is stale/paused, requests fall
// back to the key's prepaid USDG, else 402.

export type PaywithGrant = { symbol: string; token: string; decimals: number; fairPrice18: bigint; creditLine: Pico };

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
  // the eventual swap of all outstanding debt then always fits the session's daily cap.
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

/** Settle accrued debts on-chain: >= threshold USD or oldest >= max age. The debts being paid are
 *  claimed by the swap before it is sent, so calls that finish while it is mined stay open for the next
 *  one; a failed swap releases its claim. */
export async function runPaywithAggregator(ctx: Ctx) {
  if (!ctx.chain.address("payWithStock")) return { skipped: "PayWithStock not configured" };
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
  const results: unknown[] = [];
  for (const g of open) {
    if (BigInt(g.total) < threshold && Date.now() - new Date(g.oldest).getTime() < maxAgeMs) continue;
    const swapId = uid("swap_");
    // Claim exactly the debts this swap pays.
    const claimed = await ctx.db.transaction(async (tx) => {
      const debts = await tx.select().from(paywithDebts).where(and(eq(paywithDebts.chainKeyHash, g.chainKeyHash), isNull(paywithDebts.swapId))).orderBy(asc(paywithDebts.createdAt)).for("update");
      if (!debts.length) return null;
      const total = debts.reduce((a, d) => a + d.amount, 0n);
      const usdgOwed = picoToUsdg(total, "ceil");
      await tx.insert(paywithSwaps).values({ id: swapId, keyHash: g.chainKeyHash, token: debts[0].token, usdgOut: usdgOwed, status: "submitted" });
      await tx.update(paywithDebts).set({ swapId }).where(inArray(paywithDebts.id, debts.map((d) => d.id)));
      return { usdgOwed, count: debts.length };
    });
    if (!claimed || claimed.usdgOwed <= 0n) continue;
    try {
      const r = await ctx.chain.payCall(g.chainKeyHash as Hex, claimed.usdgOwed, ctx.cfg.paywith.maxSlipBps);
      await ctx.db.update(paywithSwaps).set({ tx: r.hash }).where(eq(paywithSwaps.id, swapId));
      // Apply this transaction's events right away (Credited -> ledger credit; PaidWithStock -> allocations).
      await recordEvents(ctx, r.logs);
      await processEvents(ctx, { chainKeyHash: g.chainKeyHash });
      const paid = r.logs.find((d) => d.event === "PaidWithStock");
      if (paid)
        await allocateSwap(ctx, { keyHash: g.chainKeyHash, token: String(paid.args.token), rawSpent: paid.args.rawSpent as bigint, fairPrice18: String(paid.args.fairPrice18), usdgOwed: claimed.usdgOwed, tx: r.hash });
      results.push({ key: g.chainKeyHash, usdg: claimed.usdgOwed.toString(), debts: claimed.count, tx: r.hash });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await ctx.db.transaction(async (tx) => {
        await tx.update(paywithSwaps).set({ status: "failed", error: msg }).where(eq(paywithSwaps.id, swapId));
        await tx.update(paywithDebts).set({ swapId: null }).where(eq(paywithDebts.swapId, swapId)); // back to open
      });
      log.warn("pay-with swap failed; debt stays open", { key: g.chainKeyHash, error: msg });
      results.push({ key: g.chainKeyHash, error: msg });
    }
  }
  return { settled: results };
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
