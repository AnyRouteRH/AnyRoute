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
