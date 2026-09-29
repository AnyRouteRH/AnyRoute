import { describe, expect, test } from "bun:test";
import { ContractFunctionRevertedError, encodeErrorResult, type Hex } from "viem";
import type { Ctx } from "../src/context.ts";
import { buybackOracleAbi, FLOOR_MARGIN_BPS, MAX_FLOOR_AGE_S, runBuyback } from "../src/services/buyback.ts";

const a = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as Hex;
const STAKING = a(36);
const ORACLE = a(90);
const ANYR = a(45);
const USDG = a(30);
const E18 = 10n ** 18n;
const NOW = 1_800_000_000n;
const FLOOR = 19_794n * E18 + 7n; // ~$1,000 at $0.05 minus 1%
const BID = FLOOR + (FLOOR * FLOOR_MARGIN_BPS + 9_999n) / 10_000n; // the floor plus the keeper's margin, rounded up
/** The keeper's off-chain minimum for $1,000 at `price` USDG per ANYR minus 1% (same arithmetic as runBuyback). */
const offChain = (price: number) => BigInt(Math.floor((1_000_000_000 / 1e6 / price) * (1 - 100 / 10_000) * 1e6)) * 10n ** 12n;

type Opts = {
  onChainOracle?: Hex;
  configured?: Hex | null;
  floor?: bigint;
  updatedAt?: bigint;
  refuse?: "OraclePaused" | "PriceDeviation";
  transportError?: boolean;
  legs?: boolean;
  twap?: number | Error;
};

function keeper(o: Opts = {}) {
  const executed: [bigint, bigint][] = [];
  const quotes: { args: unknown[]; blockNumber: bigint }[] = [];
  const client = {
    async readContract(p: { functionName: string; args?: unknown[]; blockNumber?: bigint }) {
      if (p.functionName === "buybackPriceOracle") return o.onChainOracle ?? ORACLE;
      if (p.functionName === "anyr") return ANYR;
      if (p.functionName !== "minimumOutput") throw new Error(`unexpected read ${p.functionName}`);
      quotes.push({ args: p.args!, blockNumber: p.blockNumber! });
      if (o.transportError) throw new Error("fetch failed");
      if (o.refuse) {
        const args = o.refuse === "PriceDeviation" ? [-306_900, -306_280, -306_280] : [];
        const data = encodeErrorResult({ abi: buybackOracleAbi, errorName: o.refuse, args } as never);
        throw new ContractFunctionRevertedError({ abi: buybackOracleAbi, data, functionName: "minimumOutput" });
      }
      return [o.floor ?? FLOOR, o.updatedAt ?? NOW] as const;
    },
    async getBlock() {
      return { number: 123n, timestamp: NOW };
    },
  };
  const ctx = {
    cfg: {
      chain: { usdg: USDG, poolManager: a(99) },
      buyback: {
        legs: o.legs ? [] : null,
        oracle: o.configured === undefined ? ORACLE : o.configured,
        twapMinutes: 30,
        maxDeviation: 0.05,
        slippageBps: 100,
        maxPerRunUsd: 1000,
      },
    },
    chain: {
      client,
      address: (name: string) => (name === "staking" ? STAKING : undefined),
      roleAddress: (role: string) => (role === "keeper" ? a(6) : undefined),
      async buybackState() {
        return { balance: 5_000_000_000n, remaining: 10_000_000_000n };
      },
      async executeBuyback(usdgIn: bigint, minOut: bigint) {
        executed.push([usdgIn, minOut]);
        return { hash: "0xabc" };
      },
    },
  } as unknown as Ctx;
  const twap = (async () => {
    if (o.twap instanceof Error) throw o.twap;
    return { average: o.twap ?? 0.05 };
  }) as never;
  return { run: () => runBuyback(ctx, { twap }), executed, quotes };
}

describe("buyback keeper: the on-chain floor oracle sets minAnyrOut", () => {
  test("quotes the oracle AnyrStaking reads, for the same tokens, amount and block, and never bids below it", async () => {
    const k = keeper();
    const r = await k.run();
    expect(k.quotes).toEqual([{ args: [USDG, ANYR, 1_000_000_000n], blockNumber: 123n }]);
    expect(k.executed).toEqual([[1_000_000_000n, BID]]);
    expect(BID - FLOOR).toBe(19_794_000_000_000_000_001n); // 0.1% of the floor, rounded up
    expect(r).toMatchObject({ min_anyr_out: BID.toString(), oracle_floor: FLOOR.toString(), oracle: ORACLE });
  });

  test("an off-chain TWAP can only raise the minimum, and its failure still skips", async () => {
    // $0.0499 minus 1% asks ~19,840 ANYR: above the bid, so the stricter value is used
    const higher = keeper({ legs: true, twap: 0.0499 });
    await higher.run();
    expect(offChain(0.0499)).toBeGreaterThan(BID);
    expect(higher.executed[0][1]).toBe(offChain(0.0499));
    // a pricier off-chain view would ask less: the floor plus margin stands
    const lower = keeper({ legs: true, twap: 0.05 });
    await lower.run();
    expect(offChain(0.05)).toBeLessThan(BID);
    expect(lower.executed[0][1]).toBe(BID);
    const broken = keeper({ legs: true, twap: new Error("spot is too far from the average") });
    expect(await broken.run()).toMatchObject({ skipped: expect.stringContaining("no trustworthy price") });
    expect(broken.executed).toEqual([]);
  });

  test("no oracle on-chain means buybacks are disabled; a different oracle than configured fails the job", async () => {
    const none = keeper({ onChainOracle: a(0) });
    expect(await none.run()).toMatchObject({ skipped: expect.stringContaining("no buyback-floor oracle") });
    expect(none.executed).toEqual([]);
    const other = keeper({ onChainOracle: a(91) });
    await expect(other.run()).rejects.toThrow(/different buyback-floor oracle/);
    expect(other.executed).toEqual([]);
    // unset in development: whatever AnyrStaking reads is used
    const dev = keeper({ configured: null, onChainOracle: a(91) });
    await dev.run();
    expect(dev.executed).toHaveLength(1);
  });

  test("a refusing oracle skips the run with its reason; transport errors fail the job", async () => {
    for (const reason of ["OraclePaused", "PriceDeviation"] as const) {
      const k = keeper({ refuse: reason });
      expect(await k.run()).toMatchObject({ skipped: `floor oracle refused: ${reason}` });
      expect(k.executed).toEqual([]);
    }
    const down = keeper({ transportError: true });
    await expect(down.run()).rejects.toThrow(/fetch failed/);
    expect(down.executed).toEqual([]);
  });

  test("zero, future and stale quotes fail the job, as AnyrStaking would refuse them", async () => {
    for (const bad of [{ floor: 0n }, { updatedAt: 0n }, { updatedAt: NOW + 1n }, { updatedAt: NOW - MAX_FLOOR_AGE_S - 1n }]) {
      const k = keeper(bad);
      await expect(k.run()).rejects.toThrow(/zero, future or stale/);
      expect(k.executed).toEqual([]);
    }
    const edge = keeper({ updatedAt: NOW - MAX_FLOOR_AGE_S });
    await edge.run();
    expect(edge.executed).toHaveLength(1);
  });
});
