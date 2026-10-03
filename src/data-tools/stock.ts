import type { Hex } from "viem";
import type { FeedReading } from "../chain/service.ts";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { RHC_CHAIN_ID, RHC_STOCK_TOKENS } from "./rhc-stock-tokens.ts";

// B: Stock Token prices and corporate-action (multiplier) status, read from public Robinhood Chain contracts.
//
// Pricing follows the rules already in the repo, never a looser copy:
//  - Chainlink's Robinhood Stock Token feeds already include the token's ERC-8056 uiMultiplier (config/rhc-mainnet.json,
//    ChainlinkStockOracle `applyMultiplier = false`), so the feed answer is served as it is and the multiplier is never
//    applied a second time. The multiplier is reported beside the price, for information only.
//  - A reading counts only when the answer is positive, the feed has at most 36 decimals, updatedAt is set, it is no older
//    than ESCROW_MAX_PRICE_AGE_S (302,400 s by default: equity feeds pause while markets are closed) and no more than five
//    minutes in the future: the same test as escrowPrice in src/pay/escrow.ts.
//  - A token whose paused() or oraclePaused() view returns true is refused, as the oracle contract does; a token without
//    those views is unaffected.
// A refused reading is answered with 503 before any payment is asked for, so a refusal is never charged.

export type StockToken = { symbol: string; address: Hex; decimals: number; feed: Hex };

/** Stock Tokens with a feed: the router's configured ones first, then, on Robinhood Chain mainnet, the ones verified in config/rhc-mainnet.json. */
export function stockTokens(ctx: Ctx): StockToken[] {
  const out = new Map<string, StockToken>();
  const add = (t: { symbol: string; address: string; decimals: number; feed?: string }) => {
    const symbol = t.symbol.toUpperCase();
    if (t.feed && !out.has(symbol)) out.set(symbol, { symbol, address: t.address as Hex, decimals: t.decimals, feed: t.feed as Hex });
  };
  for (const t of [...ctx.cfg.escrow.tokens, ...ctx.cfg.paywith.tokens]) add(t);
  if (ctx.cfg.chain.id === RHC_CHAIN_ID) for (const t of RHC_STOCK_TOKENS) add(t);
  return [...out.values()];
}

export function findStockToken(ctx: Ctx, symbol: string): StockToken {
  const want = symbol.trim().toUpperCase();
  const token = /^[A-Z0-9.]{1,16}$/.test(want) ? stockTokens(ctx).find((t) => t.symbol === want) : undefined;
  if (!token) throw new ApiError(404, `No Stock Token ${want.slice(0, 16)} with a price feed on this router. See GET /api/v1/data.`, "unknown_symbol");
  return token;
}

/** The optional views a Stock Token exposes; null where the view is missing or reverts. */
export type TokenStatus = { uiMultiplier: bigint | null; newUiMultiplier: bigint | null; effectiveAt: number | null; paused: boolean | null; oraclePaused: boolean | null };

const view = (name: string, type: "uint256" | "bool") => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type }] }) as const;
// ERC-8056 style views as Robinhood Chain Stock Tokens expose them (checked on chain: uiMultiplier, newUIMultiplier, effectiveAt).
const STOCK_TOKEN_ABI = [view("uiMultiplier", "uint256"), view("newUIMultiplier", "uint256"), view("effectiveAt", "uint256"), view("paused", "bool"), view("oraclePaused", "bool")] as const;

/** Chain reads, replaceable in tests (like anyrPricing in src/pay/escrow.ts). */
export const dataChain = {
  readFeed: (ctx: Ctx, feed: Hex): Promise<FeedReading> => ctx.chain.readFeed(feed),
  tokenStatus: async (ctx: Ctx, token: Hex): Promise<TokenStatus> => {
    const read = (functionName: (typeof STOCK_TOKEN_ABI)[number]["name"]) => ctx.chain.client.readContract({ address: token, abi: STOCK_TOKEN_ABI, functionName }).catch(() => null) as Promise<bigint | boolean | null>;
    const [m, next, at, paused, oraclePaused] = await Promise.all([read("uiMultiplier"), read("newUIMultiplier"), read("effectiveAt"), read("paused"), read("oraclePaused")]);
    const big = (v: unknown) => (typeof v === "bigint" ? v : null);
    return { uiMultiplier: big(m), newUiMultiplier: big(next), effectiveAt: typeof at === "bigint" ? Number(at) : null, paused: typeof paused === "boolean" ? paused : null, oraclePaused: typeof oraclePaused === "boolean" ? oraclePaused : null };
  },
};

export type StockReading = { feed: FeedReading | null; status: TokenStatus; readAt: number };

// One chain read per token per 15 seconds, shared by every caller (the price endpoint is reachable before payment).
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Promise<StockReading> }>();
export const clearDataToolsCache = () => cache.clear();

export function readStock(ctx: Ctx, token: StockToken): Promise<StockReading> {
  const key = `${ctx.cfg.chain.id}:${token.address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = Promise.all([dataChain.readFeed(ctx, token.feed).catch(() => null), dataChain.tokenStatus(ctx, token.address)]).then(([feed, status]) => ({ feed, status, readAt: Date.now() }));
  cache.set(key, { at: Date.now(), value });
  return value;
}

export type FeedVerdict =
  | { ok: true; price18: bigint; ageS: number }
  | { ok: false; code: "feed_unreadable" | "feed_invalid" | "feed_stale"; ageS: number | null };

/** The escrowPrice test (src/pay/escrow.ts), with the reason kept. */
export function feedVerdict(r: FeedReading | null, nowS: number, maxAgeS: number): FeedVerdict {
  if (!r) return { ok: false, code: "feed_unreadable", ageS: null };
  if (r.answer <= 0n || r.decimals > 36 || r.updatedAt <= 0) return { ok: false, code: "feed_invalid", ageS: null };
  const ageS = Math.floor(nowS - r.updatedAt);
  if (ageS > maxAgeS || ageS <= -300) return { ok: false, code: "feed_stale", ageS };
  const price18 = r.decimals <= 18 ? r.answer * 10n ** BigInt(18 - r.decimals) : r.answer / 10n ** BigInt(r.decimals - 18);
  return { ok: true, price18, ageS };
}

/** A fixed-point value as a decimal string, trailing zeros trimmed ("234.99711907", "1"). */
export function decimal(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const iso = (s: number) => new Date(s * 1000).toISOString();

function refuse(code: string, message: string, metadata?: Record<string, unknown>): never {
  throw new ApiError(503, `${message} Nothing was charged.`, code, metadata, { "retry-after": "60" });
}

function haltedCheck(token: StockToken, status: TokenStatus) {
  if (status.paused || status.oraclePaused) refuse("token_paused", `${token.symbol} reports ${status.paused ? "paused()" : "oraclePaused()"} on chain, so its price is not served.`, { paused: status.paused, oracle_paused: status.oraclePaused });
}

/** The multiplier summary shared by both endpoints. `pending_change` is true while a scheduled multiplier is not yet in effect. */
function multiplierJson(status: TokenStatus, nowS: number) {
  const scheduled = status.newUiMultiplier !== null && status.effectiveAt !== null
    ? { ui_multiplier: decimal(status.newUiMultiplier, 18), ui_multiplier_raw: status.newUiMultiplier.toString(), effective_at: iso(status.effectiveAt), in_effect: status.effectiveAt <= nowS }
    : null;
  return {
    ui_multiplier: status.uiMultiplier === null ? null : decimal(status.uiMultiplier, 18),
    ui_multiplier_raw: status.uiMultiplier?.toString() ?? null,
    scheduled,
    pending_change: !!scheduled && !scheduled.in_effect && status.newUiMultiplier !== status.uiMultiplier,
  };
}

/** GET /api/v1/data/stock/:symbol: the price of one whole Stock Token in USD, or a 503 refusal. */
export function stockPriceJson(ctx: Ctx, token: StockToken, reading: StockReading, nowMs = Date.now()) {
  const nowS = nowMs / 1000;
  const maxAgeS = ctx.cfg.escrow.maxPriceAgeS;
  const verdict = feedVerdict(reading.feed, nowS, maxAgeS);
  if (!verdict.ok) {
    const hours = Math.round(maxAgeS / 3600);
    if (verdict.code === "feed_stale") refuse("feed_stale", `The ${token.symbol} price feed is older than ${hours} hours (equity feeds pause while markets are closed) or dated in the future.`, { age_seconds: verdict.ageS, max_age_seconds: maxAgeS });
    refuse(verdict.code, `The ${token.symbol} price feed is ${verdict.code === "feed_unreadable" ? "unreadable" : "not a valid price"} right now.`);
  }
  haltedCheck(token, reading.status);
  return {
    object: "data.stock_price",
    symbol: token.symbol,
    token: token.address,
    chain_id: ctx.cfg.chain.id,
    price_usd: decimal(verdict.price18, 18),
    price_e18: verdict.price18.toString(),
    unit: "USD per whole Stock Token (USDG counted as one dollar)",
    source: { kind: "chainlink", feed: token.feed, decimals: reading.feed!.decimals, updated_at: iso(reading.feed!.updatedAt), age_seconds: verdict.ageS, max_age_seconds: maxAgeS },
    // The feed already includes the multiplier; it is never applied again here.
    multiplier: { included_in_price: true, ...multiplierJson(reading.status, nowS) },
    status: { paused: reading.status.paused, oracle_paused: reading.status.oraclePaused },
    read_at: new Date(reading.readAt).toISOString(),
  };
}

/** GET /api/v1/data/stock/:symbol/actions: the token's multiplier (splits and other corporate actions) and halt status. */
export function stockActionsJson(ctx: Ctx, token: StockToken, reading: StockReading, nowMs = Date.now()) {
  const nowS = nowMs / 1000;
  if (reading.status.uiMultiplier === null) refuse("multiplier_unreadable", `${token.symbol} did not answer uiMultiplier() on chain.`);
  return {
    object: "data.stock_actions",
    symbol: token.symbol,
    token: token.address,
    chain_id: ctx.cfg.chain.id,
    ...multiplierJson(reading.status, nowS),
    price_feed_includes_multiplier: true,
    status: { paused: reading.status.paused, oracle_paused: reading.status.oraclePaused, price_served: !reading.status.paused && !reading.status.oraclePaused },
    note: "uiMultiplier converts raw token units to shares (ERC-8056). A scheduled multiplier takes effect at effective_at; the Chainlink feed for this token already includes the multiplier in effect.",
    read_at: new Date(reading.readAt).toISOString(),
  };
}
