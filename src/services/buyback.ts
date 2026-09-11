import type { Ctx } from "../context.ts";
import { v4Twap } from "../chain/twap.ts";
import { log } from "../lib/util.ts";

// Keeper: turn AnyrStaking's accrued buyback USDG into ANYR for stakers, at most the contract's daily
// cap, with a minimum output derived from the pool's 30-minute TWAP (not its spot price) minus a
// slippage allowance. If spot and TWAP disagree by more than BUYBACK_MAX_DEVIATION, skip this run.
const twapState: { blockRate?: number } = {};

export async function runBuyback(ctx: Ctx) {
  const b = ctx.cfg.buyback;
  if (!ctx.chain.address("staking") || !ctx.chain.roleAddress("keeper") || !b.legs) return { skipped: "buyback not configured" };
  const { balance, remaining } = await ctx.chain.buybackState();
  const cap = BigInt(Math.floor(b.maxPerRunUsd * 1e6));
  const usdgIn = [balance, remaining, cap].reduce((a, x) => (x < a ? x : a));
  if (usdgIn < 1_000_000n) return { skipped: "less than $1 to buy back", balance: balance.toString() };
  let price: number;
  try {
    // USDG per whole ANYR (ANYR 18 decimals, USDG 6).
    price = (await v4Twap(ctx.chain.client, ctx.cfg.chain.poolManager, b.legs, { windowSeconds: b.twapMinutes * 60, maxDeviation: b.maxDeviation, decimalsAdjust: 1e12, state: twapState })).average;
  } catch (e) {
    log.warn("buyback skipped: no trustworthy ANYR price", { error: (e as Error).message });
    return { skipped: `no trustworthy price: ${(e as Error).message}` };
  }
  const anyrOut = Number(usdgIn) / 1e6 / price;
  const minOut = BigInt(Math.floor(anyrOut * (1 - b.slippageBps / 10_000) * 1e6)) * 10n ** 12n;
  const { hash } = await ctx.chain.executeBuyback(usdgIn, minOut);
  return { usdg_in: usdgIn.toString(), min_anyr_out: minOut.toString(), twap_usd_per_anyr: price, tx: hash };
}
