import { BaseError, ContractFunctionRevertedError, parseAbi, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { AnyrStakingAbi } from "../chain/abis.ts";
import { v4Twap } from "../chain/twap.ts";
import { log } from "../lib/util.ts";

// Keeper: turn AnyrStaking's accrued buyback USDG into ANYR for stakers, at most the contract's daily
// cap. The minimum output is the quote of the buyback-floor oracle AnyrStaking itself reads
// (contracts/src/oracle/TwapBuybackPriceOracle.sol: the Uniswap V3 pool's 30-minute TWAP minus the
// approved haircut, for the pool the buyback swaps in), so it is never below the floor the contract
// enforces. When ANYR_POOL_LEGS is set, an independent off-chain TWAP must also agree and the higher of
// the two minimums is used. A refusing oracle (paused, route changed, thin or manipulated pool) skips
// the run; a zero, future or stale quote, or an oracle other than BUYBACK_ORACLE_ADDRESS, fails the job.
const twapState: { blockRate?: number } = {};

export const buybackOracleAbi = parseAbi([
  "function minimumOutput(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 minimumOut, uint256 updatedAt)",
  "error UnsupportedPair()",
  "error InvalidAmount()",
  "error OraclePaused()",
  "error RouteMismatch()",
  "error PoolLocked()",
  "error InsufficientCardinality(uint16 cardinality, uint16 required)",
  "error InsufficientHistory()",
  "error InsufficientLiquidity(uint128 liquidity, uint128 required)",
  "error PriceDeviation(int24 spotTick, int24 shortTick, int24 longTick)",
]);
/** AnyrStaking.MAX_PRICE_AGE: the contract refuses older quotes. */
export const MAX_FLOOR_AGE_S = 15n * 60n;
/** The keeper bids this far above the floor it read: the averages keep moving until its transaction
 * lands, and AnyrStaking refuses a minAnyrOut below the floor at execution (0.1% covers several seconds
 * of the fastest drift the oracle's deviation guard allows). */
export const FLOOR_MARGIN_BPS = 10n;
const ZERO = /^0x0{40}$/i;

/** The name of the custom error a contract call reverted with, or null for transport failures. */
function revertReason(e: unknown): string | null {
  const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return reverted.data?.errorName ?? reverted.reason ?? "reverted";
}

export async function runBuyback(ctx: Ctx, deps: { twap?: typeof v4Twap } = {}) {
  const b = ctx.cfg.buyback;
  const staking = ctx.chain.address("staking");
  if (!staking || !ctx.chain.roleAddress("keeper")) return { skipped: "buyback not configured" };
  const client = ctx.chain.client;
  const [oracle, anyr] = (await Promise.all([
    client.readContract({ address: staking, abi: AnyrStakingAbi, functionName: "buybackPriceOracle" }),
    client.readContract({ address: staking, abi: AnyrStakingAbi, functionName: "anyr" }),
  ])) as [Hex, Hex];
  if (ZERO.test(oracle)) return { skipped: "AnyrStaking has no buyback-floor oracle (buybacks are disabled on-chain)" };
  if (b.oracle && b.oracle.toLowerCase() !== oracle.toLowerCase())
    throw new Error("AnyrStaking reads a different buyback-floor oracle than BUYBACK_ORACLE_ADDRESS; refusing to buy back.");

  const { balance, remaining } = await ctx.chain.buybackState();
  const cap = BigInt(Math.floor(b.maxPerRunUsd * 1e6));
  const usdgIn = [balance, remaining, cap].reduce((a, x) => (x < a ? x : a));
  if (usdgIn < 1_000_000n) return { skipped: "less than $1 to buy back", balance: balance.toString() };

  // Quote at a pinned block so its time can be checked the way AnyrStaking checks it.
  const block = await client.getBlock({ blockTag: "latest" });
  let floor: bigint;
  let updatedAt: bigint;
  try {
    [floor, updatedAt] = (await client.readContract({
      address: oracle,
      abi: buybackOracleAbi,
      functionName: "minimumOutput",
      args: [ctx.cfg.chain.usdg, anyr, usdgIn],
      blockNumber: block.number,
    })) as readonly [bigint, bigint];
  } catch (e) {
    const reason = revertReason(e);
    if (!reason) throw e;
    log.warn("buyback skipped: the floor oracle refused to quote", { reason });
    return { skipped: `floor oracle refused: ${reason}`, oracle };
  }
  if (floor === 0n || updatedAt === 0n || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_FLOOR_AGE_S)
    throw new Error("The buyback-floor oracle returned a zero, future or stale quote; AnyrStaking would refuse it.");

  let minOut = floor + (floor * FLOOR_MARGIN_BPS + 9_999n) / 10_000n;
  let twap: number | undefined;
  if (b.legs) {
    try {
      // USDG per whole ANYR (ANYR 18 decimals, USDG 6).
      twap = (await (deps.twap ?? v4Twap)(client, ctx.cfg.chain.poolManager, b.legs, { windowSeconds: b.twapMinutes * 60, maxDeviation: b.maxDeviation, decimalsAdjust: 1e12, state: twapState })).average;
    } catch (e) {
      log.warn("buyback skipped: no trustworthy off-chain ANYR price", { error: (e as Error).message });
      return { skipped: `no trustworthy price: ${(e as Error).message}` };
    }
    const offChain = BigInt(Math.floor((Number(usdgIn) / 1e6 / twap) * (1 - b.slippageBps / 10_000) * 1e6)) * 10n ** 12n;
    if (offChain > minOut) minOut = offChain;
  }
  const { hash } = await ctx.chain.executeBuyback(usdgIn, minOut);
  return { usdg_in: usdgIn.toString(), min_anyr_out: minOut.toString(), oracle_floor: floor.toString(), oracle, twap_usd_per_anyr: twap, tx: hash };
}
