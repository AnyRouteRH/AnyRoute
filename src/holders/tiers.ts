import { parseUnits, type Hex } from "viem";
import { erc20Abi } from "../chain/abis.ts";
import type { HolderTier } from "../config.ts";
import type { Ctx } from "../context.ts";
import { log } from "../lib/util.ts";

// Holder tiers: a live check of the wallet's $ANYR balance, no staking contract. A request made with a
// key that belongs to a wallet account (w_<address>, from wallet sign-in) or paid per call by a wallet
// gets the highest tier whose `min` that balance reaches:
//   - rpm_multiplier scales the key's rpm and tpm limits;
//   - discount_bps lowers Anyroute's own fee rates for that request (the per-call margin and the BYOK
//     fee) by that many basis points, never below zero, so a caller never pays less than the provider's
//     cost. Prepaid calls carry no margin, so for them the discount is 0.
// Balances are cached for 5 minutes per address. Any RPC failure means no tier (fail closed).

const TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000; // retry an unreadable balance sooner, without calling the RPC on every request
const RPC_TIMEOUT_MS = 2_500; // a slow node must not hold a request for the RPC client's full timeout

export type HolderLookup = { balance: bigint | null; decimals: number | null; tier: HolderTier | null; error: boolean };
type Entry = { at: number; ttl: number; value: Promise<HolderLookup> };

const caches = new WeakMap<Ctx, Map<string, Entry>>();
const decimalsCache = new WeakMap<Ctx, Promise<number>>();
export function clearHolderCache(ctx: Ctx) {
  caches.delete(ctx);
  decimalsCache.delete(ctx);
}

/** The wallet behind a wallet account id (w_<40 hex>), else null. */
export const walletOfAccount = (accountId: string | null | undefined) => (accountId && /^w_[0-9a-f]{40}$/.test(accountId) ? `0x${accountId.slice(2)}` : null);

/** The highest tier (tiers are sorted by min, ascending) whose min `balance` reaches. */
export function tierFor(tiers: HolderTier[], balance: bigint, decimals: number): HolderTier | null {
  let best: HolderTier | null = null;
  for (const t of tiers) if (balance >= parseUnits(t.min, decimals)) best = t;
  return best;
}

/** A per-minute limit with the tier's multiplier applied. 0 / null (unlimited or unset) stay as they are. */
export function scaleLimit<T extends number | null | undefined>(limit: T, tier: HolderTier | null): T {
  return (limit && tier ? Math.floor(limit * tier.rpmMultiplier) : limit) as T;
}

/** A fee rate after the tier's discount: never below 0. */
export const discountedBps = (bps: number, tier: HolderTier | null) => Math.max(0, bps - (tier?.discountBps ?? 0));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)))]).finally(() => clearTimeout(timer));
}

function tokenDecimals(ctx: Ctx, token: Hex) {
  let p = decimalsCache.get(ctx);
  if (!p) {
    p = ctx.chain.tokenDecimals(token);
    p.catch(() => decimalsCache.delete(ctx));
    decimalsCache.set(ctx, p);
  }
  return p;
}

/** The wallet's token balance and tier, cached per address. Never throws: a failed read is `error`. */
export function lookupHolder(ctx: Ctx, wallet: string): Promise<HolderLookup> {
  const token = ctx.cfg.holders.token;
  if (!token) return Promise.resolve({ balance: null, decimals: null, tier: null, error: false });
  const address = wallet.toLowerCase() as Hex;
  let cache = caches.get(ctx);
  if (!cache) caches.set(ctx, (cache = new Map()));
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const entry = { at: Date.now(), ttl: TTL_MS } as Entry;
  entry.value = (async (): Promise<HolderLookup> => {
    try {
      const [balance, decimals] = await withTimeout(
        Promise.all([ctx.chain.client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>, tokenDecimals(ctx, token.address)]),
        RPC_TIMEOUT_MS,
      );
      return { balance, decimals, tier: ctx.cfg.holders.enabled ? tierFor(ctx.cfg.holders.tiers, balance, decimals) : null, error: false };
    } catch (err) {
      entry.ttl = FAIL_TTL_MS;
      log.warn("holder balance unreadable; no holder tier applied", { error: (err as Error).message.slice(0, 200) });
      return { balance: null, decimals: null, tier: null, error: true };
    }
  })();
  cache.set(address, entry);
  if (cache.size > 20_000) for (const [k, e] of cache) if (Date.now() - e.at >= e.ttl) cache.delete(k);
  return entry.value;
}

/** The tier for a request by `wallet`, or null (tiers off, no wallet, below every tier, or RPC error). */
export async function holderTier(ctx: Ctx, wallet: string | null | undefined): Promise<HolderTier | null> {
  if (!ctx.cfg.holders.enabled || !wallet) return null;
  return (await lookupHolder(ctx, wallet)).tier;
}

export const tierJson = (t: HolderTier) => ({ name: t.name, min: t.min, rpm_multiplier: t.rpmMultiplier, discount_bps: t.discountBps });

/** The public `holders` section of /api/v1/status. */
export function holdersStatus(ctx: Ctx) {
  const h = ctx.cfg.holders;
  return { enabled: h.enabled, token: h.token ? { address: h.token.address, symbol: h.token.symbol } : null, tiers: h.tiers.map(tierJson) };
}
