import { BaseError, ContractFunctionRevertedError, parseAbi } from "viem";
import type { Ctx } from "../context.ts";
import { v4Twap } from "../chain/twap.ts";
import { networkBurnAbi } from "./burn-chain.ts";

export const buybackOracleAbi = parseAbi([
  "function minimumOutput(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 minimumOut, uint256 updatedAt)",
  "error UnsupportedPair()", "error InvalidAmount()", "error OraclePaused()", "error RouteMismatch()", "error PoolLocked()",
  "error InsufficientCardinality(uint16 cardinality, uint16 required)", "error InsufficientHistory()",
  "error InsufficientLiquidity(uint128 liquidity, uint128 required)", "error PriceDeviation(int24 spotTick, int24 shortTick, int24 longTick)",
]);
export const MAX_FLOOR_AGE_S = 900n;
export const FLOOR_MARGIN_BPS = 10n;
const twapState: { blockRate?: number } = {};

/** Quote the executor's own oracle at a pinned block; never bid below its floor. */
export async function quoteNetworkBurn(ctx: Ctx, deps: { twap?: typeof v4Twap; quoteOnly: bigint }) {
  const address = ctx.cfg.networkPayouts.burnAddress;
  if (!address || !ctx.chain.roleAddress("keeper")) return { skipped: "network fee burn not configured" };
  const client = ctx.chain.client;
  const block = await client.getBlock({ blockTag: "latest" });
  const [oracle, anyr, usdg] = await Promise.all([
    client.readContract({ address, abi: networkBurnAbi, functionName: "buybackPriceOracle", blockNumber: block.number }),
    client.readContract({ address, abi: networkBurnAbi, functionName: "anyr", blockNumber: block.number }),
    client.readContract({ address, abi: networkBurnAbi, functionName: "usdg", blockNumber: block.number }),
  ]);
  if (/^0x0{40}$/i.test(oracle)) return { skipped: "network fee executor has no floor oracle" };
  if (oracle.toLowerCase() !== ctx.cfg.networkPayouts.burnOracle?.toLowerCase() || usdg.toLowerCase() !== ctx.cfg.chain.usdg.toLowerCase() || anyr.toLowerCase() !== ctx.cfg.networkPayouts.burnToken.toLowerCase())
    throw new Error("Network fee executor uses different oracle or tokens than configured.");
  const amount = deps.quoteOnly;
  if (amount <= 0n) return { skipped: "no fee units to swap" };
  let floor: bigint, updatedAt: bigint;
  try {
    [floor, updatedAt] = await client.readContract({ address: oracle, abi: buybackOracleAbi, functionName: "minimumOutput", args: [usdg, anyr, amount], blockNumber: block.number });
  } catch (e) {
    const reverted = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null;
    if (!(reverted instanceof ContractFunctionRevertedError)) throw e;
    return { skipped: `floor oracle refused: ${reverted.data?.errorName ?? reverted.reason ?? "reverted"}` };
  }
  if (floor === 0n || updatedAt === 0n || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_FLOOR_AGE_S)
    throw new Error("Network fee floor oracle returned a zero, future or stale quote.");
  let minOut = floor + (floor * FLOOR_MARGIN_BPS + 9_999n) / 10_000n;
  const b = ctx.cfg.buyback; // Existing optional TWAP settings also price escrow deposits.
  if (b.legs) {
    let average: number;
    try {
      average = (await (deps.twap ?? v4Twap)(client, ctx.cfg.chain.poolManager, b.legs, { windowSeconds: b.twapMinutes * 60, maxDeviation: b.maxDeviation, decimalsAdjust: 1e12, state: twapState })).average;
    } catch { return { skipped: "no trustworthy independent token price" }; }
    const independent = BigInt(Math.floor((Number(amount) / 1e6 / average) * (1 - b.slippageBps / 10_000) * 1e6)) * 10n ** 12n;
    if (independent > minOut) minOut = independent;
  }
  return { quoted: true, minOut, oracle, anyr };
}
