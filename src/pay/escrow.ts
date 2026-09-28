import { and, asc, desc, eq } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { EscrowToken } from "../config.ts";
import { chainCursor, escrowDeposits } from "../db/schema.ts";
import { ensureAccount, post } from "../ledger/ledger.ts";
import { mulBps, type Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { rawToPico } from "./paywith.ts";

// "Pay with stock", escrow edition. A customer sends an allowlisted Stock Token from their own wallet
// to the operator's escrow wallet. After confirmations the sending wallet's account (w_<address>, the
// same account wallet sign-in uses) is credited at the Chainlink price minus a haircut. Credits are
// spendable on inference only; the tokens stay in escrow. No Anyroute contract is involved.

const CURSOR = "escrow";
export type EscrowPrice = { price18: bigint; updatedAt: number };

export const escrowEnabled = (ctx: Ctx) => !!ctx.cfg.escrow.address && ctx.cfg.escrow.tokens.length > 0;
export const escrowAccountId = (wallet: string) => `w_${wallet.toLowerCase().slice(2)}`;

const priceCache = new Map<string, { at: number; price: EscrowPrice | null }>();
export const clearEscrowPriceCache = () => priceCache.clear();

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

/** Credits (pico-USD) for `raw` token units at `price18`, after the haircut, rounded down. */
export const escrowCredit = (ctx: Ctx, raw: bigint, decimals: number, price18: bigint): Pico =>
  mulBps(rawToPico(raw, decimals, price18), 10_000 - ctx.cfg.escrow.haircutBps, "floor");

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
      for (const t of ctx.cfg.escrow.tokens) {
        const onchain = await ctx.chain.tokenDecimals(t.address as Hex);
        if (onchain !== t.decimals) throw new Error(`${t.symbol} has ${onchain} decimals on-chain but ${t.decimals} in configuration`);
      }
    })();
    p.catch(() => verified.delete(ctx));
    verified.set(ctx, p);
  }
  return p;
}

/** Record new confirmed transfers into escrow, then credit what can be priced. */
export async function pollEscrow(ctx: Ctx, maxRange = 2_000n) {
  if (!escrowEnabled(ctx)) return { skipped: "escrow not configured" };
  await verifyTokens(ctx);
  const escrow = ctx.cfg.escrow.address as Hex;
  const tokens = ctx.cfg.escrow.tokens;
  const byAddress = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
  const head = await ctx.chain.blockNumber();
  const safeHead = head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  const [cur] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, CURSOR));
  let from = cur ? cur.block + 1n : (ctx.cfg.escrow.startBlock ?? (safeHead > 5_000n ? safeHead - 5_000n : 0n));
  let recorded = 0;
  while (from <= safeHead) {
    const to = from + maxRange - 1n < safeHead ? from + maxRange - 1n : safeHead;
    const transfers = await ctx.chain.escrowTransfers(tokens.map((t) => t.address as Hex), escrow, from, to);
    const rows = transfers.flatMap((t) => {
      const tok = byAddress.get(t.token.toLowerCase());
      if (!tok) return [];
      const txHash = t.txHash.toLowerCase();
      return [{ id: `${txHash}:${t.logIndex}`, txHash, logIndex: t.logIndex, blockNumber: t.blockNumber, token: t.token.toLowerCase(), symbol: tok.symbol, fromAddress: t.from.toLowerCase(), rawAmount: t.value.toString() }];
    });
    if (rows.length) recorded += (await ctx.db.insert(escrowDeposits).values(rows).onConflictDoNothing().returning({ id: escrowDeposits.id })).length;
    await ctx.db
      .insert(chainCursor)
      .values({ id: CURSOR, block: to })
      .onConflictDoUpdate({ target: chainCursor.id, set: { block: to, updatedAt: new Date() } });
    from = to + 1n;
  }
  return { head: head.toString(), recorded, ...(await creditEscrowDeposits(ctx)) };
}

/** Credit pending deposits at the current price. Idempotent: the ledger ref is unique per transfer. */
export async function creditEscrowDeposits(ctx: Ctx) {
  const pending = await ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.status, "pending")).orderBy(asc(escrowDeposits.blockNumber), asc(escrowDeposits.logIndex)).limit(500);
  let credited = 0;
  let waiting = 0;
  for (const d of pending) {
    const tok = ctx.cfg.escrow.tokens.find((t) => t.address.toLowerCase() === d.token);
    const price = tok ? await escrowPrice(ctx, tok.feed) : null;
    if (!tok || !price) {
      const error = tok ? `waiting for a fresh ${tok.symbol} price` : "token is no longer accepted; needs operator review";
      if (d.error !== error) await ctx.db.update(escrowDeposits).set({ error }).where(and(eq(escrowDeposits.id, d.id), eq(escrowDeposits.status, "pending")));
      waiting++;
      continue;
    }
    const raw = BigInt(d.rawAmount);
    const amount = escrowCredit(ctx, raw, tok.decimals, price.price18);
    const accountId = escrowAccountId(d.fromAddress);
    await ctx.db.transaction(async (tx) => {
      await ensureAccount(tx, accountId, "wallet", d.fromAddress);
      if (amount > 0n)
        await post(tx, { accountId, amount, kind: "stock_deposit", ref: `escrow:${d.id}`, description: `${formatRaw(raw, tok.decimals)} ${tok.symbol} sent to escrow (${d.txHash})` });
      await tx
        .update(escrowDeposits)
        .set({ status: "credited", accountId, price18: price.price18.toString(), priceUpdatedAt: new Date(price.updatedAt * 1000), credited: amount, error: null, creditedAt: new Date() })
        .where(and(eq(escrowDeposits.id, d.id), eq(escrowDeposits.status, "pending")));
    });
    credited++;
  }
  return { credited, waiting };
}

/** Public payment instructions with live rates. */
export async function escrowInfo(ctx: Ctx) {
  if (!escrowEnabled(ctx)) return { enabled: false as const };
  const tokens = await Promise.all(
    ctx.cfg.escrow.tokens.map(async (t: EscrowToken) => {
      const price = await escrowPrice(ctx, t.feed);
      const one = 10n ** BigInt(t.decimals);
      return {
        symbol: t.symbol,
        address: t.address.toLowerCase(),
        decimals: t.decimals,
        price_usd: price ? Number(rawToPico(one, t.decimals, price.price18)) / 1e12 : null,
        credit_usd_per_token: price ? Number(escrowCredit(ctx, one, t.decimals, price.price18)) / 1e12 : null,
        price_updated_at: price ? new Date(price.updatedAt * 1000).toISOString() : null,
      };
    }),
  );
  return {
    enabled: true as const,
    address: ctx.cfg.escrow.address,
    chain_id: ctx.cfg.chain.id,
    explorer: ctx.cfg.chain.explorerUrl,
    confirmations: ctx.cfg.chain.confirmations,
    haircut_bps: ctx.cfg.escrow.haircutBps,
    tokens,
  };
}

export async function escrowDepositsFor(ctx: Ctx, accountId: string, limit = 50) {
  const rows = await ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.fromAddress, accountId.startsWith("w_") ? `0x${accountId.slice(2)}` : "")).orderBy(desc(escrowDeposits.blockNumber), desc(escrowDeposits.logIndex)).limit(limit);
  return rows.map((d) => {
    const tok = ctx.cfg.escrow.tokens.find((t) => t.address.toLowerCase() === d.token);
    return {
      id: d.id,
      tx_hash: d.txHash,
      block: d.blockNumber.toString(),
      symbol: d.symbol,
      amount: tok ? formatRaw(BigInt(d.rawAmount), tok.decimals) : null,
      raw_amount: d.rawAmount,
      status: d.status,
      credited_usd: d.credited != null ? Number(d.credited) / 1e12 : null,
      price_usd: d.price18 ? Number(BigInt(d.price18) / 10n ** 12n) / 1e6 : null,
      note: d.error,
      at: (d.creditedAt ?? d.createdAt).toISOString(),
    };
  });
}
