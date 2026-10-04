import { describe, expect, test } from "bun:test";
import { ContractFunctionRevertedError, encodeErrorResult, type Hex } from "viem";
import type { Ctx } from "../src/context.ts";
import { buybackOracleAbi, FLOOR_MARGIN_BPS, MAX_FLOOR_AGE_S, quoteNetworkBurn } from "../src/network/burn-quote.ts";
import { networkBurnChain } from "../src/network/burn-chain.ts";
const a = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as Hex;
const NOW = 1_800_000_000n, FLOOR = 19_794n * 10n ** 18n + 7n;
const BID = FLOOR + (FLOOR * FLOOR_MARGIN_BPS + 9_999n) / 10_000n;
type Options = { floor?: bigint; updated?: bigint; refuse?: boolean; transport?: boolean; oracle?: Hex; token?: Hex; adapter?: Hex; cap?: bigint; signer?: Hex; twap?: number | Error };
function fixture(o: Options = {}) {
  const reads: { functionName: string; blockNumber?: bigint; args?: unknown[] }[] = [];
  const ctx = {
    cfg: { chain: { usdg: a(1), poolManager: a(9) }, networkPayouts: { burnAddress: a(2), burnOracle: a(3), burnAdapter: a(4), burnDailyCap: 10_000_000_000n, burnToken: a(5) }, buyback: { legs: o.twap === undefined ? null : [], twapMinutes: 30, maxDeviation: .05, slippageBps: 100 } },
    chain: { roleAddress: () => a(6), client: {
      getBlock: async () => ({ number: 123n, timestamp: NOW }),
      readContract: async (p: { functionName: string; blockNumber?: bigint; args?: unknown[] }) => {
        reads.push(p);
        if (p.functionName === "buybackPriceOracle") return o.oracle ?? a(3);
        if (p.functionName === "anyr") return o.token ?? a(5);
        if (p.functionName === "usdg") return a(1);
        if (p.functionName === "adapter") return o.adapter ?? a(4);
        if (p.functionName === "keeper") return o.signer ?? a(6);
        if (p.functionName === "maxDailyBuyback") return o.cap ?? 10_000_000_000n;
        if (p.functionName === "remainingToday") return 10_000_000_000n;
        if (o.transport) throw new Error("fetch failed");
        if (o.refuse) throw new ContractFunctionRevertedError({ abi: buybackOracleAbi, data: encodeErrorResult({ abi: buybackOracleAbi, errorName: "OraclePaused" }), functionName: "minimumOutput" });
        return [o.floor ?? FLOOR, o.updated ?? NOW];
      },
    } },
  } as unknown as Ctx;
  const twap = (async () => { if (o.twap instanceof Error) throw o.twap; return { average: o.twap }; }) as never;
  return { ctx, reads, run: () => quoteNetworkBurn(ctx, { quoteOnly: 1_000_000_000n, twap }) };
}
describe("independent network fee quote", () => {
  test("pins oracle and token reads to one block and rounds the floor margin up", async () => {
    const f = fixture(); expect(await f.run()).toMatchObject({ quoted: true, minOut: BID });
    expect(f.reads.every(p => p.blockNumber === 123n)).toBe(true);
    expect(f.reads.at(-1)?.args).toEqual([a(1), a(5), 1_000_000_000n]);
  });
  test("zero/mismatched oracle and token fail closed", async () => {
    expect(await fixture({ oracle: a(0) }).run()).toMatchObject({ skipped: expect.any(String) });
    for (const o of [{ oracle: a(8) }, { token: a(8) }]) await expect(fixture(o).run()).rejects.toThrow(/different oracle or tokens/);
  });
  test("refusing oracle skips; transport and invalid freshness fail", async () => {
    expect(await fixture({ refuse: true }).run()).toEqual({ skipped: "floor oracle refused: OraclePaused" });
    await expect(fixture({ transport: true }).run()).rejects.toThrow(/fetch failed/);
    for (const o of [{ floor: 0n }, { updated: 0n }, { updated: NOW + 1n }, { updated: NOW - MAX_FLOOR_AGE_S - 1n }]) await expect(fixture(o).run()).rejects.toThrow(/zero, future or stale/);
    expect(await fixture({ updated: NOW - MAX_FLOOR_AGE_S }).run()).toMatchObject({ quoted: true });
  });
  test("independent TWAP can only raise the bid; unavailable price skips", async () => {
    expect((await fixture({ twap: .0499 }).run()).minOut!).toBeGreaterThan(BID);
    expect((await fixture({ twap: .05 }).run()).minOut).toBe(BID);
    expect(await fixture({ twap: new Error("unavailable") }).run()).toMatchObject({ skipped: expect.any(String) });
  });
  test("executor adapter, oracle, cap, keeper and tokens must match configured settings", async () => {
    expect(await networkBurnChain(fixture().ctx).remaining()).toBe(10_000_000_000n);
    for (const o of [{ oracle: a(8) }, { adapter: a(8) }, { cap: 0n }, { signer: a(8) }, { token: a(8) }]) await expect(networkBurnChain(fixture(o).ctx).remaining()).rejects.toThrow(/configuration differs/);
  });
});
