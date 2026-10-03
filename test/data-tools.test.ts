import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getAddress, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generations, keys, ledger } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { usdToPico, usdgToPico } from "../src/lib/money.ts";
import { X402_TYPES } from "../src/pay/x402.ts";
import { inferenceRouteAllowed } from "../src/provisioning/scope.ts";
import { clearDataToolsCache, dataChain, decimal, feedVerdict, stockTokens, type TokenStatus } from "../src/data-tools/stock.ts";
import { loadConfig } from "../src/config.ts";
import { RHC_CHAIN_ID, RHC_STOCK_TOKENS } from "../src/data-tools/rhc-stock-tokens.ts";
import { NVDA, startRouter, type Harness } from "./helpers.ts";

// B: per-call market-data tools. Shape, the repo's staleness and multiplier rules, refusals that cost nothing, the x402
// offer and settlement, prepaid keys debited per call, rulebooks applied to the call, IPX, and the flag off.

const PAY_TO = "0x00000000000000000000000000000000000d0402";
const FEED = "0x00000000000000000000000000000000000fee01";
const STOCK = "/api/v1/data/stock/NVDA";
const E18 = 10n ** 18n;
const nowS = () => Math.floor(Date.now() / 1000);
const fresh = (answer = 23_499_711_907n, ageS = 60) => ({ answer, decimals: 8, updatedAt: nowS() - ageS });
const plain: TokenStatus = { uiMultiplier: E18, newUiMultiplier: E18, effectiveAt: nowS() - 86_400, paused: false, oraclePaused: false };
const original = { ...dataChain };
let feed: ReturnType<typeof fresh> | null = fresh();
let status: TokenStatus = plain;
const reads: string[] = [];

type Req = { scheme: string; network: string; maxAmountRequired: string; resource: string; payTo: Hex; maxTimeoutSeconds: number; asset: Hex; extra: { name: string; version: string; chainId: number } };
async function xPayment(req: Req) {
  const signer = privateKeyToAccount(generatePrivateKey());
  const authorization = { from: signer.address, to: req.payTo, value: BigInt(req.maxAmountRequired), validAfter: 0n, validBefore: BigInt(nowS() + req.maxTimeoutSeconds), nonce: `0x${randomBytes(32).toString("hex")}` as Hex };
  const signature = await signer.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: req.extra.chainId, verifyingContract: req.asset }, types: X402_TYPES, primaryType: "TransferWithAuthorization", message: authorization });
  const payload = { x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization: { ...authorization, value: String(authorization.value), validAfter: "0", validBefore: String(authorization.validBefore) } } };
  return { header: Buffer.from(JSON.stringify(payload)).toString("base64"), signer };
}
const accountOf = async (h: Harness, hash: string) => (await h.ctx.db.select({ id: keys.accountId }).from(keys).where(eq(keys.keyHash, hash)))[0].id;

test("feed rules match escrowPrice: positive, at most 36 decimals, within the age limit, at most five minutes ahead", () => {
  const t = 1_790_000_000;
  expect(feedVerdict({ answer: 23_499_711_907n, decimals: 8, updatedAt: t - 10 }, t, 302_400)).toEqual({ ok: true, price18: 234_997_119_070_000_000_000n, ageS: 10 });
  expect(feedVerdict({ answer: 1n, decimals: 8, updatedAt: t - 302_401 }, t, 302_400)).toMatchObject({ ok: false, code: "feed_stale", ageS: 302_401 });
  expect(feedVerdict({ answer: 1n, decimals: 8, updatedAt: t + 300 }, t, 302_400)).toMatchObject({ ok: false, code: "feed_stale" });
  expect(feedVerdict({ answer: 1n, decimals: 8, updatedAt: t + 299 }, t, 302_400).ok).toBe(true);
  for (const bad of [{ answer: 0n, decimals: 8, updatedAt: t }, { answer: -5n, decimals: 8, updatedAt: t }, { answer: 1n, decimals: 37, updatedAt: t }, { answer: 1n, decimals: 8, updatedAt: 0 }]) expect(feedVerdict(bad, t, 302_400)).toMatchObject({ ok: false, code: "feed_invalid" });
  expect(feedVerdict(null, t, 302_400)).toMatchObject({ ok: false, code: "feed_unreadable" });
  expect(feedVerdict({ answer: 5n * 10n ** 19n, decimals: 20, updatedAt: t }, t, 302_400)).toMatchObject({ ok: true, price18: E18 / 2n }); // 0.5 at 20 decimals
  expect([decimal(1_000_775_159_164_630_595n, 18), decimal(2n * E18, 18), decimal(5n, 3), decimal(0n, 8)]).toEqual(["1.000775159164630595", "2", "0.005", "0"]);
});

test("the token list: configured feeds first, then the 13 verified Robinhood Chain Stock Tokens on chain 4663 only", () => {
  const env = { ANYROUTE_ENV: "test", APP_SECRET: "x".repeat(40), PAYWITH_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18, feed: FEED }]) };
  const main = stockTokens({ cfg: loadConfig(env) } as never);
  expect(main).toHaveLength(13);
  expect(main.find((t) => t.symbol === "NVDA")).toEqual({ symbol: "NVDA", address: NVDA, decimals: 18, feed: FEED });
  expect(main.find((t) => t.symbol === "TSLA")?.feed).toBe("0x4A1166a659A55625345e9515b32adECea5547C38");
  expect(stockTokens({ cfg: loadConfig({ ...env, CHAIN_ID: "31337" }) } as never).map((t) => t.symbol)).toEqual(["NVDA"]);
});

test("the embedded Robinhood Chain token list is exactly the verified one in config/rhc-mainnet.json", async () => {
  const rhc = (await import("../config/rhc-mainnet.json")).default as { chainId: number; stockTokens: { symbol: string; address: string; decimals: number; feed: string }[] };
  expect(RHC_CHAIN_ID).toBe(rhc.chainId);
  expect(RHC_STOCK_TOKENS).toEqual(rhc.stockTokens.map(({ symbol, address, decimals, feed }) => ({ symbol, address, decimals, feed })));
});

test("inference-only keys may use the GET data tools and nothing else under /api/v1/data", () => {
  for (const path of ["/api/v1/data", STOCK, `${STOCK}/actions`, "/api/v1/data/ipx/IPX-OPEN-70B"]) expect(inferenceRouteAllowed("GET", path)).toBe(true);
  for (const [method, path] of [["POST", STOCK], ["GET", "/api/v1/data/other"], ["GET", `${STOCK}/actions/x`], ["DELETE", STOCK]]) expect(inferenceRouteAllowed(method, path)).toBe(false);
});

describe("DATA_TOOLS_ENABLED unset (the default)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h?.close(); });
  test("every route answers 404 data_tools_disabled before reading anything, and status says off", async () => {
    for (const path of ["/api/v1/data", STOCK, `${STOCK}/actions`, "/api/v1/data/ipx/IPX-OPEN-70B"]) {
      const r = await h.request(path);
      expect(r.status).toBe(404);
      expect((await r.json()).error.type).toBe("data_tools_disabled");
    }
    expect((await (await h.request("/api/v1/status")).json()).data.data_tools).toEqual({ enabled: false, price_usd: 0.001, tools: [], symbols: [], payment: { prepaid_key: false, x402: false, callpay: false } });
  });
});

describe("DATA_TOOLS_ENABLED=true with x402", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { DATA_TOOLS_ENABLED: "true", X402_PAY_TO: PAY_TO, AGENT_POLICY_ENABLED: "true", IPX_ENABLED: "true", PAYWITH_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18, feed: FEED }]) } });
    h.chain.noCallPay = true;
    dataChain.readFeed = async (_ctx, f) => { reads.push(`feed:${f}`); if (!feed) throw new Error("unreadable"); return { ...feed }; };
    dataChain.tokenStatus = async (_ctx, t) => { reads.push(`token:${t}`); return { ...status }; };
  });
  afterEach(() => { feed = fresh(); status = plain; clearDataToolsCache(); reads.length = 0; });
  afterAll(async () => { Object.assign(dataChain, original); clearDataToolsCache(); await h?.close(); });

  test("the free index and /status describe the same tools, price, symbols and payment options", async () => {
    const index = (await (await h.request("/api/v1/data")).json()).data;
    expect(index.price_usd).toBe(0.001);
    expect(index.tools.map((t: { path: string }) => t.path)).toEqual(["/api/v1/data/stock/{symbol}", "/api/v1/data/stock/{symbol}/actions", "/api/v1/data/ipx/{class}"]);
    expect(index.symbols).toContain("NVDA");
    expect(index.ipx_classes).toEqual(["IPX-OPEN-70B"]);
    expect(index.note).toMatch(/never places orders/);
    const status = (await (await h.request("/api/v1/status")).json()).data.data_tools;
    expect(status).toMatchObject({ enabled: true, price_usd: 0.001, payment: { prepaid_key: true, x402: true, callpay: false } });
    expect(status.symbols).toEqual(index.symbols);
  });

  test("a keyless call gets an x402 402 offer for the exact resource at the configured price", async () => {
    const r = await h.request(STOCK);
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "robinhood-chain", maxAmountRequired: "1000", resource: `${h.ctx.cfg.publicUrl}${STOCK}`, description: "Data tool: NVDA Stock Token price", mimeType: "application/json", payTo: getAddress(PAY_TO), extra: { name: "Global Dollar", version: "1", chainId: 4663 } });
    // The actions and IPX tools are their own resources.
    expect((await (await h.request(`${STOCK}/actions`)).json()).accepts[0].resource).toBe(`${h.ctx.cfg.publicUrl}${STOCK}/actions`);
  });

  test("paying the offer serves the price once, settles exactly the price and leaves nothing behind", async () => {
    const req = (await (await h.request(STOCK)).json()).accepts[0] as Req;
    const pay = await xPayment(req);
    const r = await h.request(STOCK, { headers: { "x-payment": pay.header } });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-payment-response")).toBeTruthy();
    expect(r.headers.get("payment-response")).toBe(r.headers.get("x-payment-response"));
    const body = await r.json();
    expect(body.charge).toEqual({ usd: "0.001", paid_with: "per_call", payment_tx: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(body.data).toMatchObject({
      object: "data.stock_price", symbol: "NVDA", token: NVDA, chain_id: 4663, price_usd: "234.99711907", price_e18: "234997119070000000000",
      source: { kind: "chainlink", feed: FEED, decimals: 8, age_seconds: expect.any(Number), max_age_seconds: 302_400 },
      multiplier: { included_in_price: true, ui_multiplier: "1", pending_change: false },
      status: { paused: false, oracle_paused: false },
    });
    const wallet = `w_${pay.signer.address.slice(2).toLowerCase()}`;
    expect((await balanceOf(h.ctx.db, wallet)).balance).toBe(0n);
    const rows = await h.ctx.db.select().from(ledger).where(and(eq(ledger.accountId, wallet), eq(ledger.kind, "data_tool")));
    expect(rows.map((x) => x.amount)).toEqual([-usdgToPico(1000n)]);
    // The same authorization cannot pay twice.
    expect((await h.request(STOCK, { headers: { "x-payment": pay.header } })).status).toBe(402);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a prepaid key is debited the price per call, once per call, with no 402", async () => {
    const key = await h.fundedKey();
    const account = await accountOf(h, key.hash);
    const before = (await balanceOf(h.ctx.db, account)).balance;
    for (const path of [STOCK, `${STOCK}/actions`]) {
      const r = await h.request(path, { headers: key.auth });
      expect(r.status).toBe(200);
      expect((await r.json()).charge).toEqual({ usd: "0.001", paid_with: "key", payment_tx: null });
    }
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(before - 2n * usdToPico(0.001));
    const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
    expect(k.spentTotal).toBe(2n * usdToPico(0.001));
  });

  test("the multiplier is reported, never applied twice, and a scheduled change shows as pending", async () => {
    const key = await h.fundedKey();
    status = { ...plain, uiMultiplier: 2n * E18, newUiMultiplier: 3n * E18, effectiveAt: nowS() + 3600 };
    const price = (await (await h.request(STOCK, { headers: key.auth })).json()).data;
    expect(price.price_usd).toBe("234.99711907");
    expect(price.multiplier).toMatchObject({ included_in_price: true, ui_multiplier: "2", ui_multiplier_raw: "2000000000000000000", pending_change: true, scheduled: { ui_multiplier: "3", in_effect: false } });
    const actions = (await (await h.request(`${STOCK}/actions`, { headers: key.auth })).json()).data;
    expect(actions).toMatchObject({ object: "data.stock_actions", ui_multiplier: "2", pending_change: true, price_feed_includes_multiplier: true, status: { paused: false, oracle_paused: false, price_served: true } });
    expect(actions.scheduled.effective_at).toBe(new Date(status.effectiveAt! * 1000).toISOString());
    // Readings are shared for 15 seconds: two calls, one chain read.
    expect(reads.filter((r) => r.startsWith("feed:"))).toHaveLength(1);
  });

  test("refusals are 503s before any offer or charge: stale, future-dated, unreadable feed and paused tokens", async () => {
    const key = await h.fundedKey();
    const account = await accountOf(h, key.hash);
    const before = (await balanceOf(h.ctx.db, account)).balance;
    const cases: [() => void, string][] = [
      [() => { feed = fresh(23_499_711_907n, 302_401); }, "feed_stale"],
      [() => { feed = fresh(23_499_711_907n, -600); }, "feed_stale"],
      [() => { feed = null; }, "feed_unreadable"],
      [() => { feed = fresh(0n); }, "feed_invalid"],
      [() => { status = { ...plain, paused: true }; }, "token_paused"],
      [() => { status = { ...plain, oraclePaused: true }; }, "token_paused"],
    ];
    for (const [arrange, type] of cases) {
      clearDataToolsCache(); feed = fresh(); status = plain; arrange();
      for (const headers of [key.auth, {}]) {
        const r = await h.request(STOCK, { headers });
        expect(r.status, type).toBe(503);
        const error = (await r.json()).error;
        expect(error.type).toBe(type);
        expect(error.message).toContain("Nothing was charged");
      }
    }
    clearDataToolsCache(); feed = fresh(); status = { ...plain, uiMultiplier: null };
    expect((await (await h.request(`${STOCK}/actions`, { headers: key.auth })).json()).error.type).toBe("multiplier_unreadable");
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(before);
  });

  test("unknown symbols are a free 404", async () => {
    for (const path of ["/api/v1/data/stock/NOPE", "/api/v1/data/stock/%3Cscript%3E", "/api/v1/data/stock/AAAAAAAAAAAAAAAAAAAA/actions"]) {
      const r = await h.request(path);
      expect(r.status).toBe(404);
      expect((await r.json()).error.type).toBe("unknown_symbol");
    }
    expect(reads).toEqual([]);
  });

  test("an agent rulebook sees the call as the tool data_tool: a tools allowlist without it refuses, nothing is charged", async () => {
    const owner = await h.fundedKey();
    const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Trader" } })).json();
    const agent = { authorization: `Bearer ${child.key}` };
    await h.ctx.db.update(keys).set({ budget: null }).where(eq(keys.keyHash, child.data.hash));
    const put = (tools: string[]) => h.request(`/api/v1/agents/${child.data.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, tools: { allow: tools }, on_breach: "deny" } });
    expect((await put(["get_quote"])).status).toBe(200);
    const account = await accountOf(h, owner.hash);
    const before = (await balanceOf(h.ctx.db, account)).balance;
    const refused = await h.request(STOCK, { headers: agent });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.metadata.reasons.map((r: { code: string }) => r.code)).toEqual(["tool_not_allowed"]);
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(before);
    expect((await put(["data_tool"])).status).toBe(200);
    expect((await h.request(STOCK, { headers: agent })).status).toBe(200);
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(before - usdToPico(0.001));
  });

  test("IPX: an unknown class is a free 404 and a class with no fills is a free 503", async () => {
    const key = await h.fundedKey();
    const account = await accountOf(h, key.hash);
    const before = (await balanceOf(h.ctx.db, account)).balance;
    const empty = await h.request("/api/v1/data/ipx/IPX-OPEN-70B", { headers: key.auth });
    expect(empty.status).toBe(503);
    expect((await empty.json()).error.type).toBe("ipx_no_price");
    expect((await h.request("/api/v1/data/ipx/NOPE", { headers: key.auth })).status).toBe(404);
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(before);
  });
});

describe("IPX through the data tool, with a fill already in the window", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { DATA_TOOLS_ENABLED: "true", IPX_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });
  test("the index snapshot is served with its receipt root and the call is charged", async () => {
    const lastHour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 1_800_000;
    await h.ctx.db.insert(generations).values({ id: "gen-data-ipx-2", ts: new Date(lastHour), accountId: "acct-ipx", modelId: "meta-llama/llama-3.3-70b-instruct", providerId: "alpha", tokensIn: 600_000, tokensOut: 400_000, cost: usdToPico("0.42"), mode: "prepaid", isByok: false, cancelled: false, attestationHash: "0xattest", receiptLeaf: keccak256(toHex("data-ipx-leaf-2")) });
    const key = await h.fundedKey();
    const r = await h.request("/api/v1/data/ipx/ipx-open-70b", { headers: key.auth });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data).toMatchObject({ object: "data.ipx", class: "IPX-OPEN-70B", unit: "USDG per 1,000,000 tokens", price: "0.42", fills_24h: 1, receipt_root: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(body.charge).toEqual({ usd: "0.001", paid_with: "key", payment_tx: null });
  });
});
