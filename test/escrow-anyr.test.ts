import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NVDA, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { poolId, v4Twap, type PoolKey } from "../src/chain/twap.ts";
import { escrowDeposits, ledger } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { anyrPricing, clearEscrowPriceCache, escrowAccountId, escrowReviewsOpen, pollEscrow } from "../src/pay/escrow.ts";

// Pay with $ANYR through the escrow wallet: same watcher as Stock Tokens, priced by the pool TWAP.
const ESCROW = "0x00000000000000000000000000000000000e5c20";
const FEED = "0x00000000000000000000000000000000000fee01";
const ANYR = "0x00000000000000000000000000000000000a0a0a";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ZERO = "0x0000000000000000000000000000000000000000";
const key = (currency0: string, currency1: string): PoolKey => ({ currency0: currency0 as Hex, currency1: currency1 as Hex, fee: 3000, tickSpacing: 60, hooks: ZERO as Hex });
const LEGS = JSON.stringify([{ key: key(ANYR, USDG), sign: 1 }]);
const escrowEnv = { PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: ESCROW, ESCROW_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18, feed: FEED }]), ESCROW_HAIRCUT_BPS: "300", ESCROW_START_BLOCK: "1" };
const anyrEnv = { ANYR_TOKEN_ADDRESS: ANYR, ANYR_POOL_LEGS: LEGS };
const whole = (n: bigint) => n * 10n ** 18n;
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 6n; // pico-USD
const realTwap = anyrPricing.twap;

type TwapCall = Parameters<typeof v4Twap>;
let twapCalls: TwapCall[] = [];
/** Price the pool at `conservative` USDG per ANYR (spot a little higher), or fail like a thin or moving pool. */
const stubTwap = (conservative: number | Error) => {
  anyrPricing.twap = (async (...args: TwapCall) => {
    twapCalls.push(args);
    if (conservative instanceof Error) throw conservative;
    return { spot: conservative * 1.01, average: conservative, conservative, windowSeconds: 1800, block: 1, swaps: 3 };
  }) as typeof v4Twap;
};

describe("paying with $ANYR through escrow", () => {
  let h: Harness;
  const wallet = privateKeyToAccount(("0x" + "7c".repeat(32)) as Hex);
  const from = wallet.address.toLowerCase() as Hex;
  const send = (token: string, raw: bigint, sender: Hex = from) => {
    h.chain.escrowHead += 10n;
    const t = { token: token as Hex, from: sender, value: raw, txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n };
    h.chain.escrowLogs.push(t);
    return t;
  };
  const row = async (t: { txHash: Hex }) => (await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash)))[0];
  const balance = async (a: Hex = from) => (await balanceOf(h.ctx.db, escrowAccountId(a))).balance;

  beforeAll(async () => (h = await startRouter({ env: { ...escrowEnv, ...anyrEnv } })));
  afterAll(async () => {
    anyrPricing.twap = realTwap;
    await h.close();
  });
  beforeEach(() => {
    clearEscrowPriceCache();
    twapCalls = [];
    stubTwap(0.5);
    h.ctx.cfg.anyrEscrow!.haircutBps = 0;
    h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
  });

  test("an ANYR transfer is credited at the conservative pool TWAP with no haircut; stocks keep theirs", async () => {
    const a = send(ANYR, whole(100n));
    const s = send(NVDA, whole(1n));
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 2, credited: 2, waiting: 0 });
    // 100 ANYR x $0.50 (the lower of spot and average) x 100% + 1 NVDA x $180 x 97%
    expect(await row(a)).toMatchObject({ status: "credited", symbol: "ANYR", credited: usd(50), price18: (5n * 10n ** 17n).toString(), error: null, reviewReason: null });
    expect(await row(s)).toMatchObject({ status: "credited", symbol: "NVDA", credited: usd(174.6) });
    expect(await balance()).toBe(usd(224.6));
    const [entry] = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow:${a.txHash}:0`));
    expect(entry).toMatchObject({ kind: "anyr_deposit", amount: usd(50) });
    // The TWAP ran over ANYR_POOL_LEGS for USDG per whole ANYR (18 - 6 decimals), with the buyback window and deviation guard.
    const [, poolManager, legs, opts] = twapCalls[0];
    expect(poolManager).toBe(h.ctx.cfg.chain.poolManager);
    expect(legs).toEqual(JSON.parse(LEGS));
    expect(opts).toMatchObject({ windowSeconds: 30 * 60, maxDeviation: 0.05, decimalsAdjust: 1e12 });
    // Idempotent: another poll credits nothing more.
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
    expect(await balance()).toBe(usd(224.6));
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("ANYR_ESCROW_HAIRCUT_BPS is applied to ANYR only", async () => {
    h.ctx.cfg.anyrEscrow!.haircutBps = 250;
    const w = privateKeyToAccount(("0x" + "7d".repeat(32)) as Hex).address.toLowerCase() as Hex;
    const a = send(ANYR, whole(100n), w);
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1 });
    expect(await row(a)).toMatchObject({ status: "credited", credited: usd(48.75) }); // $50 x 97.5%
  });

  test("with no trustworthy price the deposit stays pending, then is credited at the next good price", async () => {
    const w = privateKeyToAccount(("0x" + "7e".repeat(32)) as Hex).address.toLowerCase() as Hex;
    stubTwap(new Error("spot is too far from the average"));
    const a = send(ANYR, whole(10n), w);
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 1, credited: 0, waiting: 1 });
    expect(await row(a)).toMatchObject({ status: "pending", credited: null, error: "waiting for a fresh ANYR price" });
    // The failed reading is cached briefly, like a price, so the public endpoint cannot hammer the RPC.
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    expect(info.tokens.find((t: { symbol: string }) => t.symbol === "ANYR")).toMatchObject({ price_usd: null, credit_usd_per_token: null });
    expect(twapCalls).toHaveLength(1);
    clearEscrowPriceCache();
    stubTwap(0); // a zero price is no price
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 0, waiting: 1 });
    clearEscrowPriceCache();
    stubTwap(0.8);
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1, waiting: 0 });
    expect(await row(a)).toMatchObject({ status: "credited", credited: usd(8), error: null });
    expect(await balance(w)).toBe(usd(8));
  });

  test("a deposit above the per-deposit limit is credited only up to it and flagged for operator review", async () => {
    const w = privateKeyToAccount(("0x" + "7f".repeat(32)) as Hex).address.toLowerCase() as Hex;
    const a = send(ANYR, whole(1_000n), w); // $500 at $0.50, limit $250
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1 });
    const r = await row(a);
    expect(r).toMatchObject({ status: "credited", credited: usd(250), reviewedAt: null });
    expect(r.error).toBe("Credited $250.00 of $500.00: ANYR deposits are credited up to $250.00 each. The rest is held for operator review.");
    expect(r.reviewReason).toContain("above the per-deposit limit");
    expect(await balance(w)).toBe(usd(250));
    expect((await escrowReviewsOpen(h.ctx.db)).map((x) => x.id)).toContain(r.id);
    const [entry] = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow:${r.id}`));
    expect(entry.amount).toBe(usd(250));
    expect(entry.description).toContain("per-deposit limit");
    // Exactly at the limit is credited in full, without a review.
    const b = send(ANYR, whole(500n), w);
    await pollEscrow(h.ctx);
    expect(await row(b)).toMatchObject({ status: "credited", credited: usd(250), reviewReason: null, error: null });
  });

  test("an ANYR credit reorganized away is reversed with its own ledger kind", async () => {
    const w = privateKeyToAccount(("0x" + "80".repeat(32)) as Hex).address.toLowerCase() as Hex;
    const a = send(ANYR, whole(4n), w);
    await pollEscrow(h.ctx);
    expect(await balance(w)).toBe(usd(2));
    h.chain.reorg(a.blockNumber, (logs) => logs.filter((l) => l.txHash !== a.txHash));
    expect(await pollEscrow(h.ctx)).toMatchObject({ reversed: 1 });
    const [rev] = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow-reversal:${a.txHash}:0`));
    expect(rev).toMatchObject({ kind: "anyr_deposit_reversal", amount: -usd(2) });
    expect(await balance(w)).toBe(0n);
  });

  test("public escrow info and status list ANYR with its haircut, limit and price source", async () => {
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    expect(info.haircut_bps).toBe(300);
    expect(info.anyr).toEqual({ symbol: "ANYR", address: ANYR, decimals: 18, haircut_bps: 0, max_usd_per_deposit: 250, price_source: "twap", twap_minutes: 30 });
    const bySymbol = Object.fromEntries(info.tokens.map((t: { symbol: string }) => [t.symbol, t]));
    expect(bySymbol.ANYR).toMatchObject({ address: ANYR, price_source: "twap", price_usd: 0.5, credit_usd_per_token: 0.5, haircut_bps: 0, max_usd_per_deposit: 250 });
    expect(bySymbol.NVDA).toMatchObject({ price_source: "chainlink", price_usd: 180, credit_usd_per_token: 174.6, haircut_bps: 300, max_usd_per_deposit: null });
    const status = (await (await h.request("/api/v1/status")).json()).data;
    expect(status.escrow).toEqual({ enabled: true, tokens: ["NVDA", "ANYR"], haircut_bps: 300, anyr: info.anyr });
  });

  test("a decimals mismatch for ANYR stops the watcher before anything is recorded or credited", async () => {
    const r = await startRouter({ env: { ...escrowEnv, ...anyrEnv, ANYR_TOKEN_DECIMALS: "18" } });
    try {
      (r.ctx.chain as unknown as { tokenDecimals: (t: Hex) => Promise<number> }).tokenDecimals = async (t) => (t.toLowerCase() === ANYR ? 9 : 18);
      r.chain.escrowLogs.push({ token: ANYR as Hex, from, value: whole(1n), txHash: fakeTx(), logIndex: 0, blockNumber: 5n });
      await expect(pollEscrow(r.ctx)).rejects.toThrow(/ANYR has 9 decimals on-chain but 18/);
      expect(await r.ctx.db.select().from(escrowDeposits)).toHaveLength(0);
    } finally {
      await r.close();
    }
  });
});

describe("$ANYR escrow is off unless configured", () => {
  test("without ANYR_TOKEN_ADDRESS, ANYR transfers are ignored and nothing lists ANYR", async () => {
    const h = await startRouter({ env: { ...escrowEnv, ANYR_POOL_LEGS: LEGS } });
    try {
      expect(h.ctx.cfg.anyrEscrow).toBeNull();
      twapCalls = [];
      stubTwap(0.5);
      h.chain.escrowHead += 10n;
      h.chain.escrowLogs.push({ token: ANYR as Hex, from: "0x0000000000000000000000000000000000000abc", value: whole(1n), txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n });
      expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
      expect(await h.ctx.db.select().from(escrowDeposits)).toHaveLength(0);
      const info = (await (await h.request("/api/v1/escrow")).json()).data;
      expect(info.anyr).toBeNull();
      expect(info.tokens.map((t: { symbol: string }) => t.symbol)).toEqual(["NVDA"]);
      expect((await (await h.request("/api/v1/status")).json()).data.escrow).toMatchObject({ tokens: ["NVDA"], anyr: null });
      expect(twapCalls).toHaveLength(0);
    } finally {
      anyrPricing.twap = realTwap;
      await h.close();
    }
  });
});

describe("$ANYR escrow configuration", () => {
  test("defaults, and a refusal for anything that could misprice or double-list ANYR", () => {
    expect(loadConfig({}).anyrEscrow).toBeNull();
    expect(loadConfig({ ANYR_TOKEN_ADDRESS: "" }).anyrEscrow).toBeNull();
    expect(loadConfig(anyrEnv).anyrEscrow).toEqual({ address: ANYR, symbol: "ANYR", decimals: 18, haircutBps: 0, maxUsdPerDeposit: 250, legs: JSON.parse(LEGS) });
    expect(loadConfig({ ...anyrEnv, ANYR_ESCROW_HAIRCUT_BPS: "100", ANYR_ESCROW_MAX_USD_PER_DEPOSIT: "50" }).anyrEscrow).toMatchObject({ haircutBps: 100, maxUsdPerDeposit: 50 });
    // Two legs through ETH (currency 0x0), the second inverted: ANYR -> ETH -> USDG.
    const viaEth = JSON.stringify([{ key: key(ZERO, ANYR), sign: -1, minLiquidity: "1000000" }, { key: key(ZERO, USDG), sign: 1 }]);
    expect(loadConfig({ ...anyrEnv, ANYR_POOL_LEGS: viaEth }).anyrEscrow?.legs).toHaveLength(2);
    expect(() => loadConfig({ ANYR_TOKEN_ADDRESS: ANYR })).toThrow(/needs ANYR_POOL_LEGS/);
    expect(() => loadConfig({ ...anyrEnv, ANYR_POOL_LEGS: JSON.stringify([{ key: key(ANYR, USDG), sign: -1 }]) })).toThrow(/must price ANYR_TOKEN_ADDRESS/);
    expect(() => loadConfig({ ...anyrEnv, ANYR_POOL_LEGS: JSON.stringify([{ key: key(ZERO, ANYR), sign: -1 }]) })).toThrow(/must end in USDG/);
    expect(() => loadConfig({ ...anyrEnv, ANYR_POOL_LEGS: "[]" })).toThrow(/ANYR_POOL_LEGS must be/);
    expect(() => loadConfig({ ...anyrEnv, ANYR_POOL_LEGS: JSON.stringify([{ key: key(ANYR, USDG), sign: 1, minLiquidity: "1e21" }]) })).toThrow(/ANYR_POOL_LEGS must be/);
    expect(() => loadConfig({ ...anyrEnv, ANYR_ESCROW_HAIRCUT_BPS: "10000" })).toThrow(/ANYR_ESCROW_HAIRCUT_BPS/);
    expect(() => loadConfig({ ...anyrEnv, ANYR_ESCROW_MAX_USD_PER_DEPOSIT: "0" })).toThrow(/ANYR_ESCROW_MAX_USD_PER_DEPOSIT/);
    expect(() => loadConfig({ ...anyrEnv, ANYR_TOKEN_SYMBOL: "" })).toThrow(/ANYR_TOKEN_SYMBOL/);
    expect(() => loadConfig({ ...anyrEnv, ESCROW_TOKENS: JSON.stringify([{ symbol: "X", address: ANYR, decimals: 18, feed: FEED }]) })).toThrow(/also listed in ESCROW_TOKENS/);
  });
});

describe("pool TWAP liquidity floor", () => {
  // One pool at tick 0 (price 1.0) with no swaps in the window, read through a minimal client.
  const pool = key(ANYR, USDG);
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(pool), 6n])));
  const client = {
    getBlockNumber: async () => 1_000_000n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber }), // one block per second
    request: async () => [],
    call: async ({ data }: { data: Hex }) => {
      const slot = BigInt("0x" + data.slice(10));
      return { data: toHex(slot === base ? 1n << 96n : slot === base + 3n ? 5_000n : 0n, { size: 32 }) };
    },
  } as never;
  const twap = (minLiquidity?: string) => v4Twap(client, ZERO as Hex, [{ key: pool, sign: 1, minLiquidity }], { windowSeconds: 600, maxDeviation: 0.05, decimalsAdjust: 1e12 });

  test("a pool below a leg's minLiquidity gives no price; at or above it, the conservative price", async () => {
    await expect(twap("5001")).rejects.toThrow(/too little liquidity/);
    const r = await twap("5000");
    expect(r).toMatchObject({ spot: 1e12, average: 1e12, conservative: 1e12, swaps: 0 });
    expect((await twap()).conservative).toBe(1e12);
  });
});
