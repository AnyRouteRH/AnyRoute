import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { startRouter, type Harness } from "./helpers.ts";
import { requestHash } from "../src/api/chat.ts";
import { loadConfig } from "../src/config.ts";
import { applyCredits } from "../src/holders/credits.ts";
import { clearHolderCache, holderTier, scaleLimit, tierFor } from "../src/holders/tiers.ts";
import { usdToPico } from "../src/lib/money.ts";
import { priceUsage, type Usage } from "../src/router/pricing.ts";

const TOKEN = "0x00000000000000000000000000000000000a4e01";
// ANYR_TOKEN_ADDRESS also turns on $ANYR escrow pricing, which needs pool legs from the token to USDG.
const LEGS = JSON.stringify([{ key: { currency0: TOKEN, currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 0, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" }, sign: 1 }]);
const TIERS = JSON.stringify([
  { name: "Whale", min: "1000000", rpm_multiplier: 5, discount_bps: 100 },
  { name: "Holder", min: "100000", rpm_multiplier: 2, discount_bps: 50 },
]);
const tok = (n: bigint) => n * 10n ** 18n;
const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const chat = { model: LLAMA, messages: [{ role: "user", content: "hello" }], max_tokens: 20 };

async function signIn(h: Harness, wallet: PrivateKeyAccount) {
  const challenge = (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: wallet.address } })).json()).data;
  const r = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) } })).json();
  return { authorization: `Bearer ${r.key}` };
}

/** Stand in for the RPC node's token balanceOf; `fail` makes every read throw. */
function mockBalances(h: Harness) {
  const state = { balances: new Map<string, bigint>(), calls: 0, fail: false };
  (h.chain.client as unknown as { readContract: (a: { functionName: string; args?: unknown[]; address: string }) => Promise<bigint> }).readContract = async (a) => {
    state.calls++;
    if (state.fail) throw new Error("rpc down");
    if (a.functionName !== "balanceOf" || a.address.toLowerCase() !== TOKEN) throw new Error(`unexpected read ${a.functionName}`);
    return state.balances.get(String(a.args?.[0]).toLowerCase()) ?? 0n;
  };
  return state;
}

/** Statuses of `n` chat calls; unfunded keys answer 402 until the rate limit answers 429. */
async function statuses(h: Harness, headers: Record<string, string>, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await h.request("/api/v1/chat/completions", { method: "POST", headers, json: chat })).status);
  return out;
}

describe("holder tiers: configuration and selection", () => {
  test("HOLDER_TIERS is parsed, sorted by min and validated", () => {
    const cfg = loadConfig({ ANYR_TOKEN_ADDRESS: TOKEN, ANYR_POOL_LEGS: LEGS, HOLDER_TIERS: TIERS });
    expect(cfg.holders.enabled).toBe(true);
    expect(cfg.holders.token).toEqual({ address: TOKEN, symbol: "ANYR" });
    expect(cfg.holders.tiers.map((t) => [t.name, t.min, t.rpmMultiplier, t.discountBps])).toEqual([
      ["Holder", "100000", 2, 50],
      ["Whale", "1000000", 5, 100],
    ]);
    expect(() => loadConfig({ HOLDER_TIERS: "not json" })).toThrow(/HOLDER_TIERS/);
    expect(() => loadConfig({ HOLDER_TIERS: JSON.stringify([{ name: "A", min: "10" }, { name: "B", min: "10.0" }]) })).toThrow(/same min/);
    expect(() => loadConfig({ HOLDER_TIERS: JSON.stringify([{ name: "A", min: "0" }]) })).toThrow(/above 0/);
    expect(() => loadConfig({ HOLDER_TIERS: JSON.stringify([{ name: "A", min: "10", rpm_multiplier: 0.5 }]) })).toThrow(/HOLDER_TIERS/);
    expect(() => loadConfig({ HOLDER_TIERS: JSON.stringify([{ name: "A", min: "10", discount_bps: 20000 }]) })).toThrow(/HOLDER_TIERS/);
  });

  test("tiers are off unless both ANYR_TOKEN_ADDRESS and HOLDER_TIERS are set", () => {
    expect(loadConfig({}).holders.enabled).toBe(false);
    expect(loadConfig({ HOLDER_TIERS: TIERS }).holders.enabled).toBe(false);
    expect(loadConfig({ ANYR_TOKEN_ADDRESS: TOKEN, ANYR_POOL_LEGS: LEGS }).holders.enabled).toBe(false);
    expect(loadConfig({ ANYR_TOKEN_ADDRESS: TOKEN, ANYR_POOL_LEGS: LEGS, ANYR_TOKEN_SYMBOL: "XANYR" }).holders.token?.symbol).toBe("XANYR");
  });

  test("the highest tier whose min the balance reaches wins", () => {
    const { tiers } = loadConfig({ ANYR_TOKEN_ADDRESS: TOKEN, ANYR_POOL_LEGS: LEGS, HOLDER_TIERS: TIERS }).holders;
    expect(tierFor(tiers, 0n, 18)).toBeNull();
    expect(tierFor(tiers, tok(99_999n), 18)).toBeNull();
    expect(tierFor(tiers, tok(100_000n), 18)?.name).toBe("Holder");
    expect(tierFor(tiers, tok(999_999n), 18)?.name).toBe("Holder");
    expect(tierFor(tiers, tok(1_000_000n), 18)?.name).toBe("Whale");
    expect(tierFor(tiers, 100_000n * 10n ** 6n, 6)?.name).toBe("Holder"); // decimals come from the token
    expect(scaleLimit(600, tiers[0])).toBe(1200);
    expect(scaleLimit(0, tiers[1])).toBe(0); // 0 = unlimited stays unlimited
    expect(scaleLimit(null, tiers[1])).toBeNull();
    expect(scaleLimit(600, null)).toBe(600);
  });

  test("the discount only lowers Anyroute's margin, and never below zero", () => {
    const { tiers } = loadConfig({ ANYR_TOKEN_ADDRESS: TOKEN, ANYR_POOL_LEGS: LEGS, HOLDER_TIERS: TIERS }).holders;
    const cand = { pricePrompt: usdToPico("0.000001"), priceCompletion: usdToPico("0.000002"), priceCacheRead: null, priceCacheWrite: null, priceReasoning: 0n, priceRequest: 0n, priceWebSearch: 0n, priceImage: 0n } as never;
    const model = { creator: null, royaltyBps: 0 } as never;
    const u: Usage = { prompt: 1000, completion: 500, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: false };
    const upstream = usdToPico("0.002");
    const fees = { royaltyBps: 0, perCallMarginBps: 100, byokFeeBps: 0 };
    const full = priceUsage(cand, model, u, "per_call", fees, false);
    expect(full.margin).toBe(usdToPico("0.00002"));
    const holder = priceUsage(cand, model, u, "per_call", { ...fees, discountBps: tiers[0].discountBps }, false);
    expect(holder.margin).toBe(usdToPico("0.00001"));
    expect(holder.holderDiscount).toBe(usdToPico("0.00001"));
    const whale = priceUsage(cand, model, u, "per_call", { ...fees, discountBps: 5000 }, false); // far above the margin
    expect(whale.margin).toBe(0n);
    expect(whale.holderDiscount).toBe(full.margin); // capped at the margin charged
    expect(whale.total).toBe(upstream); // never below the provider's cost
    // Prepaid calls carry no margin: nothing to discount.
    const prepaid = priceUsage(cand, model, u, "prepaid", { ...fees, discountBps: 100 }, false);
    expect(prepaid.margin).toBe(0n);
    expect(prepaid.holderDiscount).toBe(0n);
    expect(prepaid.total).toBe(upstream);
    // A BYOK fee is Anyroute's own fee too.
    const byok = priceUsage(cand, model, u, "byok", { ...fees, byokFeeBps: 200, discountBps: 50 }, true);
    expect(byok.margin).toBe(usdToPico("0.00003"));
    expect(byok.holderDiscount).toBe(usdToPico("0.00001"));
  });
});

describe("holder tiers: live", () => {
  let h: Harness;
  let rpc: ReturnType<typeof mockBalances>;
  const holder = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
  const whale = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
  const nobody = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);

  beforeAll(async () => {
    h = await startRouter({ env: { ANYR_TOKEN_ADDRESS: TOKEN, ANYR_POOL_LEGS: LEGS, HOLDER_TIERS: TIERS, DEFAULT_RPM: "2" } });
    rpc = mockBalances(h);
    rpc.balances.set(holder.address.toLowerCase(), tok(250_000n));
    rpc.balances.set(whale.address.toLowerCase(), tok(2_000_000n));
  });
  afterAll(async () => h.close());
  beforeEach(() => {
    clearHolderCache(h.ctx);
    rpc.fail = false;
  });

  test("a holder's key gets the tier's rate-limit multiplier; others keep the default", async () => {
    // DEFAULT_RPM=2. Unfunded keys pass the rate limit and stop at 402; over the limit they get 429.
    expect(await statuses(h, await signIn(h, holder), 5)).toEqual([402, 402, 402, 402, 429]);
    expect(await statuses(h, await signIn(h, nobody), 3)).toEqual([402, 402, 429]);
    const plain = await h.newKey(); // not a wallet account: no chain read at all
    const before = rpc.calls;
    expect(await statuses(h, plain.auth, 3)).toEqual([402, 402, 429]);
    expect(rpc.calls).toBe(before);
  });

  test("balances are cached per address", async () => {
    const auth = await signIn(h, whale);
    const before = rpc.calls;
    await statuses(h, auth, 3);
    expect(rpc.calls - before).toBe(1);
  });

  test("an RPC failure means no tier (fail closed)", async () => {
    rpc.fail = true;
    expect(await holderTier(h.ctx, holder.address)).toBeNull();
    clearHolderCache(h.ctx);
    expect(await statuses(h, await signIn(h, holder), 3)).toEqual([402, 402, 429]);
    const r = await (await h.request("/api/v1/holder", { headers: await signIn(h, holder) })).json();
    expect(r.data).toMatchObject({ enabled: true, balance: null, balance_error: true, tier: null, perks: null });
  });

  test("GET /api/v1/holder: balance, tier, perks, next tier and credits received", async () => {
    await applyCredits(h.ctx.db, { period: "2026-09", symbol: "ANYR", rows: [{ address: holder.address.toLowerCase(), balance: tok(250_000n), credit: usdToPico("2.5"), capped: false }] });
    const r = await h.request("/api/v1/holder", { headers: await signIn(h, holder) });
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d).toMatchObject({
      enabled: true,
      token: { address: TOKEN, symbol: "ANYR" },
      wallet: holder.address.toLowerCase(),
      balance: "250000",
      tier: { name: "Holder", min: "100000", rpm_multiplier: 2, discount_bps: 50 },
      next_tier: { name: "Whale", min: "1000000", remaining: "750000" },
      perks: { rpm_multiplier: 2, rpm: 4, discount_bps: 50, fees: { prepaid_bps: 0, per_call_margin_bps: 50, byok_fee_bps: 0 } },
      credits_total_usd: 2.5,
    });
    expect(d.perks.note).toMatch(/Prepaid calls carry no Anyroute margin/);
    expect(d.tiers.map((t: { name: string }) => t.name)).toEqual(["Holder", "Whale"]);
    expect(d.credits_received).toEqual([{ period: "2026-09", usd: 2.5, at: expect.any(String) }]);
    // A key that is not from wallet sign-in has no wallet.
    const plain = await (await h.request("/api/v1/holder", { headers: (await h.newKey()).auth })).json();
    expect(plain.data).toMatchObject({ wallet: null, tier: null, balance: null, credits_received: [] });
    expect(plain.data.hint).toMatch(/Sign in with the wallet/);
    expect((await h.request("/api/v1/holder")).status).toBe(401);
  });

  test("status lists the tiers", async () => {
    const s = (await (await h.request("/api/v1/status")).json()).data.holders;
    expect(s).toEqual({
      enabled: true,
      token: { address: TOKEN, symbol: "ANYR" },
      tiers: [
        { name: "Holder", min: "100000", rpm_multiplier: 2, discount_bps: 50 },
        { name: "Whale", min: "1000000", rpm_multiplier: 5, discount_bps: 100 },
      ],
    });
  });

  test("prepaid: the tier applies, but there is no margin to discount", async () => {
    await applyCredits(h.ctx.db, { period: "fund-prepaid", symbol: "ANYR", rows: [{ address: whale.address.toLowerCase(), balance: tok(1n), credit: usdToPico(1), capped: false }] });
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: await signIn(h, whale), json: chat });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.holder).toEqual({ tier: "Whale", rpm_multiplier: 5, discount_bps: 100 });
    expect(j.usage.cost_details.margin).toBe(0);
    expect(j.usage.cost_details.holder_discount).toBe(0);
    expect(j.usage.cost).toBe(j.usage.cost_details.upstream_inference_cost);
    expect(j.receipt.payload.cost_details.margin).toBe("0"); // receipt format unchanged
  });

  test("per-call wallet payments: the discount comes off the margin, capped at the margin charged", async () => {
    const pay = async (w: PrivateKeyAccount, prompt: string) => {
      const body = { ...chat, messages: [{ role: "user", content: prompt }] };
      const ts = Math.floor(Date.now() / 1000);
      const sig = await w.signMessage({ message: `anyroute:${ts}:${requestHash(body)}` });
      const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-wallet-auth": `${w.address}:${ts}:${sig}` }, json: body });
      expect(r.status).toBe(200);
      return (await r.json()).usage;
    };
    await applyCredits(h.ctx.db, { period: "fund-per-call", symbol: "ANYR", rows: [holder, nobody].map((w) => ({ address: w.address.toLowerCase(), balance: tok(1n), credit: usdToPico(1), capped: false })) });
    await applyCredits(h.ctx.db, { period: "fund-per-call", symbol: "ANYR", rows: [{ address: whale.address.toLowerCase(), balance: tok(1n), credit: usdToPico(1), capped: false }] });
    // Mock completions vary in length, so each call is checked against its own upstream cost.
    const plain = await pay(nobody, "per call one");
    expect(plain.cost_details.holder_discount).toBeUndefined();
    expect(plain.cost_details.margin).toBeCloseTo(plain.cost_details.upstream_inference_cost * 0.01, 10); // PER_CALL_MARGIN_BPS=100
    const half = await pay(holder, "per call one");
    expect(half.cost_details.margin).toBeCloseTo(half.cost_details.upstream_inference_cost * 0.005, 10); // 100 - 50 bps
    expect(half.cost_details.holder_discount).toBeCloseTo(half.cost_details.upstream_inference_cost * 0.005, 10);
    const zero = await pay(whale, "per call one");
    expect(zero.cost_details.margin).toBe(0); // 100 - 100 bps
    expect(zero.cost_details.holder_discount).toBeCloseTo(zero.cost_details.upstream_inference_cost * 0.01, 10); // capped at the margin
    expect(zero.cost).toBe(zero.cost_details.upstream_inference_cost); // exactly the provider's cost, never below it
  });
});

describe("holder tiers: disabled", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter({ env: { DEFAULT_RPM: "2", HOLDER_TIERS: TIERS } }))); // no token: off
  afterAll(async () => h.close());

  test("no token address: no chain reads, default limits, status says disabled", async () => {
    const rpc = mockBalances(h);
    const wallet = privateKeyToAccount(("0x" + "44".repeat(32)) as Hex);
    rpc.balances.set(wallet.address.toLowerCase(), tok(5_000_000n));
    const auth = await signIn(h, wallet);
    expect(await statuses(h, auth, 3)).toEqual([402, 402, 429]);
    expect(rpc.calls).toBe(0);
    const s = (await (await h.request("/api/v1/status")).json()).data.holders;
    expect(s.enabled).toBe(false);
    expect(s.token).toBeNull();
    const d = (await (await h.request("/api/v1/holder", { headers: auth })).json()).data;
    expect(d).toMatchObject({ enabled: false, token: null, wallet: wallet.address.toLowerCase(), balance: null, tier: null, perks: null });
  });
});

