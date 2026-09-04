import { expect, test } from "bun:test";
import { createPublicClient, http } from "viem";
import { averageTick, v4Twap } from "../src/chain/twap.ts";

test("averageTick weights ticks by time", () => {
  const at = (b: number) => b; // block == second
  expect(averageTick([], 100, at, 0, 10).average).toBe(100);
  // tick 0 for 5s then 100 for 5s -> 50
  expect(averageTick([{ block: 5, tick: 100 }], 0, at, 0, 10).average).toBe(50);
  // a swap spike at the very end barely moves the average
  const r = averageTick([{ block: 9.9, tick: 10_000 }], 0, at, 0, 10);
  expect(r.average).toBeCloseTo(100, 6); // 10_000 for 0.1s of 10s
  expect(r.last).toBe(10_000);
});

test.skipIf(process.env.RHC_LIVE !== "1")("live RHC: ETH/USDG v4 TWAP matches a sane ETH price", async () => {
  const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com"), cacheTime: 0 });
  const r = await v4Twap(
    client as never,
    "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    [{ key: { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 100, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" }, sign: 1 }],
    { windowSeconds: 600, maxDeviation: 0.1, decimalsAdjust: 1e12 },
  );
  console.log("ETH/USD", { spot: r.spot.toFixed(2), twap10m: r.average.toFixed(2), swaps: r.swaps, window_s: r.windowSeconds });
  expect(r.spot).toBeGreaterThan(500);
  expect(r.spot).toBeLessThan(20_000);
  expect(Math.abs(r.spot - r.average) / r.average).toBeLessThan(0.1);
}, 120_000);
