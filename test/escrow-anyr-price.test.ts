import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NVDA, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { loadAnyrFixture } from "./anyr-twap-fixture.ts";
import mainnet from "../config/rhc-mainnet.json";
import { TwapError, poolId, readPool, v4Twap } from "../src/chain/twap.ts";
import { escrowDeposits } from "../src/db/schema.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { anyrEscrowQuote, anyrPricing, clearEscrowPriceCache, escrowAccountId, escrowStage, pollEscrow } from "../src/pay/escrow.ts";
import { readiness } from "../src/services/readiness.ts";
import { readinessMetrics } from "../src/services/readiness-metrics.ts";

// Pricing $ANYR for escrow: the mainnet pools on recorded RPC responses, then every way it can be unavailable and
// what a customer, the dashboard and an operator are told.
const ESCROW = "0x00000000000000000000000000000000000e5c20";
const FEED = "0x00000000000000000000000000000000000fee01";
const realTwap = anyrPricing.twap;
const LEGS = JSON.stringify(mainnet.anyr.escrowPoolLegs);
const escrowEnv = { PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: ESCROW, ESCROW_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18, feed: FEED }]), ESCROW_START_BLOCK: "1" };
const mainnetEnv = { ...escrowEnv, ANYR_TOKEN_ADDRESS: mainnet.anyr.address, ANYR_POOL_LEGS: LEGS };
const pm = mainnet.uniswap.v4PoolManager as Hex;
const legs = mainnet.anyr.escrowPoolLegs as never;
const whole = (n: bigint) => n * 10n ** 18n;

/** Run the real TWAP over a recording instead of the chain. The router learns the block rate between readings; a recording holds one starting point, so each reading starts fresh. */
const replay = (name: string) => {
  const r = loadAnyrFixture(name);
  anyrPricing.twap = ((_client, poolManager, l, opts) => realTwap(r.client, poolManager, l, { ...opts, state: {} })) as typeof v4Twap;
  return r;
};

describe("$ANYR pools on recorded mainnet responses", () => {
  const { fixture, client } = loadAnyrFixture("anyr-twap-swinging.json.gz");

  test("the configured pools exist, the ANYR pool clears its liquidity floor, and both prices are sane", async () => {
    const [anyrLeg, ethLeg] = mainnet.anyr.escrowPoolLegs;
    expect(poolId(anyrLeg.key as never).startsWith(mainnet.anyr.v4Pools.anyrEth.idPrefix)).toBe(true);
    expect(poolId(ethLeg.key as never).startsWith(mainnet.anyr.v4Pools.ethUsdg.idPrefix)).toBe(true);
    const block = BigInt(fixture.reading.block);
    const anyr = await readPool(client, pm, anyrLeg.key as never, block);
    const eth = await readPool(client, pm, ethLeg.key as never, block);
    expect(anyr.sqrtPriceX96 > 0n && eth.sqrtPriceX96 > 0n).toBe(true);
    expect(anyr.liquidity).toBeGreaterThanOrEqual(BigInt(anyrLeg.minLiquidity!));
    // Price from the pools' own square-root prices, independent of the TWAP code: ETH per USD and ANYR per ETH.
    const p = (s: bigint) => (Number(s) / 2 ** 96) ** 2; // currency0 in currency1, raw units
    const ethUsd = p(eth.sqrtPriceX96) * 1e12; // USDG has 6 decimals, ETH 18
    const anyrPerEth = p(anyr.sqrtPriceX96); // both 18 decimals
    expect(ethUsd).toBeGreaterThan(500);
    expect(ethUsd).toBeLessThan(20_000);
    const spot = ethUsd / anyrPerEth;
    expect(Math.abs(spot / fixture.reading.spot - 1)).toBeLessThan(2e-4); // tick rounding only
    expect(spot).toBeGreaterThan(1e-7);
    expect(spot).toBeLessThan(1);
  });

  test("with the deviation guard off, the TWAP reproduces the recorded reading: the lower of spot and the average, over 30 minutes", async () => {
    const r = await v4Twap(client, pm, legs, { windowSeconds: 1800, maxDeviation: 1, decimalsAdjust: 1e12, state: {} });
    expect(r).toEqual(fixture.reading);
    expect(r.conservative).toBe(Math.min(r.spot, r.average));
    expect(r.windowSeconds).toBeGreaterThanOrEqual(1800);
    expect(r.windowSeconds).toBeLessThan(2000);
    expect(r.swaps).toBeGreaterThan(100);
  });

  test("at the default 5% guard the recorded moment gives no price, and says the ANYR leg strayed above its average", async () => {
    const err = await v4Twap(client, pm, legs, { windowSeconds: 1800, maxDeviation: 0.05, decimalsAdjust: 1e12, state: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(TwapError);
    expect(err.message).toBe("spot is too far from the average"); // the wording callers already match on
    expect(err.code).toBe("spot_deviates");
    expect(err.detail).toMatchObject({ leg: 0, limit: 0.05, direction: "above" });
    // The ANYR leg is priced in ETH, so the leg's own deviation is about the size of the gap between spot and the average USD price.
    expect(err.detail.deviation).toBeGreaterThan(0.05);
    expect(Math.abs(err.detail.deviation / (fixture.reading.spot / fixture.reading.average - 1) - 1)).toBeLessThan(0.05);
  });

  test("at a steadier moment the production settings (30 minutes, 5%) do price ANYR, at the lower of spot and average", async () => {
    const steady = loadAnyrFixture("anyr-twap-steady.json.gz");
    const r = await v4Twap(steady.client, pm, legs, { windowSeconds: 1800, maxDeviation: 0.05, decimalsAdjust: 1e12, state: {} });
    expect(r).toEqual(steady.fixture.reading);
    expect(Math.abs(r.spot / r.average - 1)).toBeLessThan(0.05);
    expect(r.conservative).toBe(Math.min(r.spot, r.average));
    expect(r.conservative).toBeGreaterThan(1e-6); // sane for a token worth well under a cent, not zero and not dollars
    expect(r.conservative).toBeLessThan(1e-2);
    expect(r.windowSeconds).toBeGreaterThanOrEqual(1800);
    expect(r.swaps).toBeGreaterThan(100);
  });

  test("the pool's liquidity floor is enforced: a floor above what the pool holds gives no price", async () => {
    const thin = [{ ...mainnet.anyr.escrowPoolLegs[0], minLiquidity: "1" + "0".repeat(30) }, mainnet.anyr.escrowPoolLegs[1]] as never;
    const err = await v4Twap(client, pm, thin, { windowSeconds: 1800, maxDeviation: 1, decimalsAdjust: 1e12, state: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(TwapError);
    expect(err).toMatchObject({ code: "thin_liquidity", detail: { leg: 0 } });
    expect(BigInt(err.detail.liquidity)).toBeGreaterThan(0n);
  });
});

describe("the ANYR rate the router uses, from recorded mainnet responses", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter({ env: mainnetEnv })));
  afterAll(async () => {
    anyrPricing.twap = realTwap;
    await h.close();
  });
  beforeEach(() => {
    clearEscrowPriceCache();
    h.ctx.cfg.anyrEscrow!.maxDeviation = 0.05;
  });

  test("the production settings (30 minutes, 5%) give no price at the recorded moment, and the endpoint says exactly why", async () => {
    const { fixture } = replay("anyr-twap-swinging.json.gz");
    const res = await h.request("/api/v1/escrow/anyr/price");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const d = (await res.json()).data;
    expect(d).toMatchObject({
      enabled: true,
      symbol: "ANYR",
      address: mainnet.anyr.address.toLowerCase(),
      available: false,
      source: "twap",
      window_minutes: 30,
      max_deviation: 0.05,
      haircut_bps: 0,
      max_usd_per_deposit: 250,
      price_usd: null,
      credit_usd_per_token: null,
      updated_at: null,
    });
    expect(d.reason).toMatchObject({ code: "price_swinging", limit: 0.05, direction: "above" });
    expect(d.reason.deviation).toBeGreaterThan(0.05);
    expect(d.reason.message).toMatch(/^The ANYR pool price is \d+% above its 30-minute average; deposits are credited only while the two are within 5%\. Deposits wait and are credited automatically/);
    expect(typeof d.checked_at).toBe("string");
    // The general escrow listing carries the same reason on the token, and the head/credit blocks the dashboard tracks finality with.
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    const anyr = info.tokens.find((t: { symbol: string }) => t.symbol === "ANYR");
    expect(anyr).toMatchObject({ price_usd: null, credit_usd_per_token: null, price_source: "twap", price_reason: { code: "price_swinging" } });
    expect(info.tokens.find((t: { symbol: string }) => t.symbol === "NVDA").price_reason).toBeNull();
    expect(BigInt(info.credit_block)).toBeLessThanOrEqual(BigInt(info.head_block));
    expect(fixture.reading.swaps).toBeGreaterThan(0);
  });

  test("at the steady moment a deposit is credited end to end at the priced rate, with the default guard", async () => {
    const { fixture } = replay("anyr-twap-steady.json.gz");
    const d = (await (await h.request("/api/v1/escrow/anyr/price")).json()).data;
    expect(d).toMatchObject({ available: true, max_deviation: 0.05, window_minutes: 30, reason: null, swaps: fixture.reading.swaps });
    expect(d.price_usd).toBeCloseTo(fixture.reading.conservative, 9);
    const from = privateKeyToAccount(("0x" + "9e".repeat(32)) as Hex).address.toLowerCase() as Hex;
    h.chain.escrowHead += 10n;
    h.chain.escrowLogs.push({ token: mainnet.anyr.address.toLowerCase() as Hex, from, value: whole(1_000n), txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n });
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1, waiting: 0 });
    // 1,000 ANYR at the recorded conservative price, in pico-USD, to within the price's own rounding.
    const expected = 1000 * fixture.reading.conservative * 1e12;
    const got = Number((await balanceOf(h.ctx.db, escrowAccountId(from))).balance);
    expect(Math.abs(got / expected - 1)).toBeLessThan(1e-9);
    expect(got / 1e12).toBeGreaterThan(0.01);
    expect(got / 1e12).toBeLessThan(10);
  });

  test("with a wider guard the same recording is priced at the lower of spot and average, with its window and source", async () => {
    const { fixture } = replay("anyr-twap-swinging.json.gz");
    h.ctx.cfg.anyrEscrow!.maxDeviation = 0.25;
    const d = (await (await h.request("/api/v1/escrow/anyr/price")).json()).data;
    expect(d).toMatchObject({ enabled: true, available: true, source: "twap", window_minutes: 30, max_deviation: 0.25, reason: null, swaps: fixture.reading.swaps, block: fixture.reading.block });
    expect(d.price_usd).toBeCloseTo(fixture.reading.conservative, 9);
    expect(d.price_usd).toBeLessThanOrEqual(d.spot_usd);
    expect(d.price_usd).toBeLessThanOrEqual(d.average_usd);
    expect(d.credit_usd_per_token).toBe(d.price_usd); // no haircut on ANYR
    expect(d.window_seconds).toBeGreaterThanOrEqual(1800);
    expect(new Date(d.updated_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // 1,000 ANYR at this rate is a few cents to a few dollars: nowhere near the per-deposit limit.
    expect(1000 * d.credit_usd_per_token).toBeLessThan(250);
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    expect(info.tokens.find((t: { symbol: string }) => t.symbol === "ANYR")).toMatchObject({ price_usd: d.price_usd, price_reason: null });
  });
});

describe("when $ANYR cannot be priced", () => {
  const ANYR = "0x00000000000000000000000000000000000a0a0a";
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const key = { currency0: ANYR as Hex, currency1: USDG as Hex, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" as Hex };
  let h: Harness;
  let priced: number | Error = new Error("unset");
  const stub = (p: number | Error) => {
    priced = p;
  };
  const wallet = privateKeyToAccount(("0x" + "8d".repeat(32)) as Hex);
  const from = wallet.address.toLowerCase() as Hex;
  const send = (raw: bigint) => {
    h.chain.escrowHead += 10n;
    const t = { token: ANYR as Hex, from, value: raw, txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n };
    h.chain.escrowLogs.push(t);
    return t;
  };
  const deposits = async (auth: Record<string, string>) => (await (await h.request("/api/v1/escrow/deposits", { headers: auth })).json()).data.deposits as { tx_hash: string; status: string; stage: string; note: string | null; price_reason: { code: string } | null; credited_usd: number | null }[];
  const price = async () => (await (await h.request("/api/v1/escrow/anyr/price")).json()).data;

  beforeAll(async () => {
    h = await startRouter({ env: { ...escrowEnv, ANYR_TOKEN_ADDRESS: ANYR, ANYR_POOL_LEGS: JSON.stringify([{ key, sign: 1 }]) } });
    anyrPricing.twap = (async () => {
      if (priced instanceof Error) throw priced;
      return { spot: priced * 1.01, average: priced, conservative: priced, windowSeconds: 1800, block: 7, swaps: 12 };
    }) as typeof v4Twap;
  });
  afterAll(async () => {
    anyrPricing.twap = realTwap;
    await h.close();
  });
  beforeEach(() => clearEscrowPriceCache());
  afterEach(() => {
    h.chain.escrowFinalLag = 0n;
  });

  const cases: [string, Error, string, RegExp][] = [
    ["spot outside the guard, from the TWAP itself", new TwapError("spot_deviates", "spot is too far from the average", { leg: 0, deviation: 0.141, limit: 0.05, direction: "below" }), "price_swinging", /^The ANYR pool price is 14% below its 30-minute average; deposits are credited only while the two are within 5%\./],
    ["the same, from a plain error with the TWAP's wording", new Error("spot is too far from the average"), "price_swinging", /^The ANYR pool price is too far from its 30-minute average\./],
    ["a later leg straying is described without a direction", new TwapError("spot_deviates", "spot is too far from the average", { leg: 1, deviation: 0.2, limit: 0.05, direction: "above" }), "price_swinging", /^The ANYR pool price is 20% away from its 30-minute average/],
    ["a pool below its liquidity floor", new TwapError("thin_liquidity", "too little liquidity", { leg: 0 }), "pool_thin", /too little liquidity to price a deposit safely/],
    ["a pool that was never initialized", new TwapError("pool_uninitialized", "pool not initialized"), "pool_missing", /not initialized on-chain/],
    ["too little chain history", new Error("chain history too short"), "history_short", /30 minutes of history/],
    ["swap history that disagrees with the pool", new Error("swap history doesn't match the pool"), "history_inconsistent", /does not match its current state/],
    ["a non-positive result", new Error("no usable price"), "no_price", /No usable ANYR price/],
    ["an unreachable node: its text is never published", new Error("fetch failed for https://rpc.internal.example/key/abc123"), "source_unreachable", /^The ANYR price source could not be read right now\./],
  ];
  for (const [name, err, code, message] of cases)
    test(`${name} -> ${code}`, async () => {
      stub(err);
      const d = await price();
      expect(d).toMatchObject({ available: false, price_usd: null, credit_usd_per_token: null, reason: { code } });
      expect(d.reason.message).toMatch(message);
      expect(JSON.stringify(d)).not.toMatch(/rpc\.internal|abc123|fetch failed/);
    });

  test("the reading, good or bad, is cached briefly and shared", async () => {
    let calls = 0;
    const before = anyrPricing.twap;
    anyrPricing.twap = ((...a: Parameters<typeof v4Twap>) => {
      calls++;
      return (before as typeof v4Twap)(...a);
    }) as typeof v4Twap;
    try {
      stub(new Error("spot is too far from the average"));
      await Promise.all([price(), price(), h.request("/api/v1/escrow")]);
      await price();
      expect(calls).toBe(1);
    } finally {
      anyrPricing.twap = before;
    }
  });

  test("the endpoint reports ANYR as off when the router does not take it", async () => {
    const r = await startRouter({ env: escrowEnv });
    try {
      expect((await (await r.request("/api/v1/escrow/anyr/price")).json()).data).toEqual({ enabled: false });
    } finally {
      await r.close();
    }
  });

  test("a deposit follows confirming -> awaiting_price (with the reason) -> credited, and the wallet's credit balance follows", async () => {
    const challenge = (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: wallet.address } })).json()).data;
    const signIn = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) } })).json();
    const auth = { authorization: `Bearer ${signIn.key}` };
    // Above the finality point: only shown.
    h.chain.escrowFinalLag = 50n;
    stub(new Error("spot is too far from the average"));
    const t = send(whole(1_000n));
    await pollEscrow(h.ctx);
    let [d] = await deposits(auth);
    expect(d).toMatchObject({ tx_hash: t.txHash, status: "pending_finality", stage: "confirming", price_reason: null, credited_usd: null });
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    expect(BigInt(t.blockNumber)).toBeGreaterThan(BigInt(info.credit_block)); // still above the point credits are made from
    // Final, but no trustworthy price: a clear stage and the live reason, not a silent wait.
    h.chain.escrowHead += 60n;
    clearEscrowPriceCache();
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 0, waiting: 1 });
    [d] = await deposits(auth);
    expect(d).toMatchObject({ status: "pending", stage: "awaiting_price", credited_usd: null, price_reason: { code: "price_swinging" } });
    expect(d.note).toMatch(/^The ANYR pool price is too far from its 30-minute average/);
    expect((await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash)))[0].error).toBe("waiting for a fresh ANYR price"); // the stored line is unchanged
    // The price settles: credited on the next poll.
    clearEscrowPriceCache();
    stub(0.002);
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1, waiting: 0 });
    [d] = await deposits(auth);
    expect(d).toMatchObject({ status: "credited", stage: "credited", credited_usd: 2, price_reason: null, note: null });
    const credits = (await (await h.request("/api/v1/credits", { headers: auth })).json()).data;
    expect(credits.available).toBeCloseTo(2, 6);
  });

  test("readiness warns while ANYR has no price, without failing any check, and the metrics carry the warning", async () => {
    stub(new Error("spot is too far from the average"));
    clearEscrowPriceCache();
    await price(); // one reading, as any dashboard visit or watcher poll makes
    const warned = await readiness(h.ctx);
    expect(warned.warnings).toEqual([{ code: "anyr_price_unavailable", reason: "price_swinging", message: expect.stringContaining("30-minute average") }]);
    expect(Object.keys(warned.checks)).not.toContain("anyr_price_unavailable"); // a warning is not a check, so alerts on checks are unchanged
    expect(readinessMetrics(warned)).toContain('anyroute_readiness_warning{warning="anyr_price_unavailable"} 1\n');
    clearEscrowPriceCache();
    stub(0.5);
    await price();
    expect((await readiness(h.ctx)).warnings).toEqual([]);
    expect(readinessMetrics({ ok: true, checks: { database: true }, warnings: [] })).not.toContain("anyroute_readiness_warning");
    // The public /ready body carries the same warnings.
    stub(new Error("chain history too short"));
    clearEscrowPriceCache();
    await price();
    expect((await (await h.request("/ready")).json()).warnings).toEqual([expect.objectContaining({ code: "anyr_price_unavailable", reason: "history_short" })]);
  });

  test("a good reading is described with the quote it came from", async () => {
    stub(0.25);
    clearEscrowPriceCache();
    const { price: p, quote } = await anyrEscrowQuote(h.ctx, h.ctx.cfg.anyrEscrow!);
    expect(p?.price18).toBe(250_000_000_000_000_000n);
    expect(quote).toMatchObject({ available: true, priceUsd: 0.25, spotUsd: 0.2525, averageUsd: 0.25, windowSeconds: 1800, swaps: 12 });
  });
});

describe("deposit stages", () => {
  test("map each stored status to one word for the dashboard", () => {
    expect(escrowStage("pending_finality", false)).toBe("confirming");
    expect(escrowStage("pending_finality", true)).toBe("confirming");
    expect(escrowStage("pending", true)).toBe("awaiting_price");
    expect(escrowStage("pending", false)).toBe("crediting");
    expect(escrowStage("credited", false)).toBe("credited");
    expect(escrowStage("orphaned", false)).toBe("orphaned");
    expect(escrowStage("reversed", false)).toBe("reversed");
  });
});
