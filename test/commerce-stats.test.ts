import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { keccak256, toBytes } from "viem";
import { loadConfig } from "../src/config.ts";
import { ApiError } from "../src/lib/errors.ts";
import { anchors, chainCursor, generations, quotes } from "../src/db/schema.ts";
import { commerceTransfers } from "../src/commerce/schema.ts";
import { ensureAccount, post } from "../src/ledger/ledger.ts";
import { usdgToPico } from "../src/lib/money.ts";
import { COMMERCE_KINDS, EXCLUSIONS, classify, figures, median, report, type FundingView, type Settlement } from "../src/commerce/ledger.ts";
import { COMMERCE_CURSOR, fundingView, linkedWithin, pollCommerceTransfers } from "../src/commerce/funding.ts";
import { COMMERCE_STATS_CACHE_MS, commerceStatsRoutes, commerceStatus, readCommerceStats } from "../src/commerce/stats.ts";
import { registerCommerceSource } from "../src/commerce/sources.ts";
import { statsCache } from "../src/network/stats.ts";
import type { UsdgTransfer } from "../src/chain/service.ts";
import { ADDR, MODELS, startRouter, type Harness } from "./helpers.ts";

const addr = (n: string) => `0x${n.padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const P = addr("a1"), Q = addr("b2");
const s = (o: Partial<Settlement> = {}): Settlement => ({ kind: "model.call", payer: P, payee: Q, amountUsdg: 1_000_000n, at: new Date(T0), anchored: true, refunded: false, ...o });
const noFunding: FundingView = { linked: () => false, returned: () => false };
const graph = (edges: [string, string][]) => {
  const m = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (!m.has(to)) m.set(to, new Set());
    m.get(to)!.add(from);
  }
  return (a: string) => m.get(a) ?? [];
};

describe("configuration", () => {
  test("off by default, with conservative funding defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.commerce).toEqual({ enabled: false, funding: { fromBlock: null, hops: 2, minUnits: 1_000_000n, hubFanout: 25, hubs: [] }, operators: [], relayers: [] });
    const on = loadConfig({ COMMERCE_STATS_ENABLED: "true", COMMERCE_FUNDING_FROM_BLOCK: "123", COMMERCE_FUNDING_HOPS: "3", COMMERCE_HUB_ADDRESSES: ` ${addr("AB")} ,${addr("cd")}`, COMMERCE_RELAYER_ADDRESSES: addr("ef") });
    expect(on.commerce.enabled).toBe(true);
    expect(on.commerce.funding).toMatchObject({ fromBlock: 123n, hops: 3, hubs: [addr("ab"), addr("cd")] });
    expect(on.commerce.relayers).toEqual([addr("ef")]);
    for (const bad of [{ COMMERCE_FUNDING_HOPS: "4" }, { COMMERCE_FUNDING_HOPS: "0" }, { COMMERCE_HUB_ADDRESSES: "not-an-address" }, { COMMERCE_FUNDING_MIN_UNITS: "0" }]) expect(() => loadConfig(bad)).toThrow();
  });

  test("the transfer job needs the ledger and a start block; production accepts both", () => {
    expect(() => loadConfig({ RUNTIME_ROLE: "worker", WORKER_JOBS: "commerce-transfers" })).toThrow("COMMERCE_FUNDING_FROM_BLOCK");
    expect(() => loadConfig({ RUNTIME_ROLE: "worker", WORKER_JOBS: "commerce-transfers", COMMERCE_STATS_ENABLED: "true" })).toThrow("COMMERCE_FUNDING_FROM_BLOCK");
    const address = "0x" + "1".repeat(40);
    const base = { NODE_ENV: "production", ANYROUTE_ENV: "production", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, COMMERCE_STATS_ENABLED: "true" };
    expect(loadConfig({ ...base, RUNTIME_ROLE: "api", ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) }).commerce.enabled).toBe(true);
    const worker = loadConfig({ ...base, RUNTIME_ROLE: "worker", WORKER_JOBS: "commerce-transfers", COMMERCE_FUNDING_FROM_BLOCK: "5" });
    expect(worker.workerJobs).toEqual(["commerce-transfers"]);
    expect(worker.commerce.funding.fromBlock).toBe(5n);
  });
});

describe("filters", () => {
  test("unanchored settlements are excluded before every other rule", () => {
    expect(classify([s({ anchored: false, payee: P })], noFunding)).toEqual(["unanchored"]);
    expect(classify([s()], noFunding)).toEqual([null]);
  });

  test("self-dealing: same wallet, same owner key, or both operator wallets", () => {
    const operators = new Set([P, Q]);
    expect(classify([s({ payee: P })], null)).toEqual(["same_owner"]);
    expect(classify([s({ payerOwner: "acct_1", payeeOwner: "acct_1" })], null)).toEqual(["same_owner"]);
    expect(classify([s({ payerOwner: "acct_1", payeeOwner: "acct_2" }), s({ payerOwner: null, payeeOwner: null })], null)).toEqual([null, null]);
    expect(classify([s()], null, operators)).toEqual(["same_owner"]);
    expect(classify([s()], null, new Set([Q]))).toEqual([null]); // a customer paying the operator is commerce
  });

  test("round trips within 24 hours exclude both legs; a day and a millisecond apart do not", () => {
    const back = (ms: number) => s({ payer: Q, payee: P, at: new Date(T0 + ms) });
    expect(classify([s(), back(DAY)], null)).toEqual(["round_trip", "round_trip"]);
    expect(classify([s(), back(-5 * HOUR)], null)).toEqual(["round_trip", "round_trip"]);
    expect(classify([s(), back(DAY + 1)], null)).toEqual([null, null]);
    // A plain transfer back from the payee (seen in the transfer index) is a round trip too.
    const returned: FundingView = { linked: () => false, returned: (from, to, at, within) => from === Q && to === P && Math.abs(at.getTime() - (T0 + HOUR)) <= within };
    expect(classify([s()], returned)).toEqual(["round_trip"]);
    expect(classify([s({ at: new Date(T0 + 3 * DAY) })], returned)).toEqual([null]);
  });

  test("funding links apply only with the transfer index, and only between on-chain wallets", () => {
    const linked: FundingView = { linked: (a, b) => [a, b].sort().join() === [P, Q].sort().join(), returned: () => false };
    expect(classify([s()], linked)).toEqual(["funding_link"]);
    expect(classify([s()], null)).toEqual([null]);
    expect(classify([s({ payer: "acct:1", payee: "acct:2" })], { linked: () => true, returned: () => true })).toEqual([null]);
  });

  test("the first failing rule names the exclusion, so each settlement is excluded once", () => {
    const all: FundingView = { linked: () => true, returned: () => true };
    expect(classify([s({ anchored: false }), s({ payee: P }), s(), s({ payer: addr("c3") })], all, new Set())).toEqual(["unanchored", "same_owner", "round_trip", "round_trip"]);
  });
});

describe("funding graph", () => {
  const A = "a", B = "b", X = "x", Y = "y", Z = "z", HUB = "hub";
  const none = () => false;
  test("one side funded the other, directly or through other wallets, within the hop limit", () => {
    expect(linkedWithin(A, B, 2, graph([[B, A]]), none)).toBe(true);
    expect(linkedWithin(A, B, 2, graph([[A, B]]), none)).toBe(true);
    expect(linkedWithin(A, B, 2, graph([[B, X], [X, A]]), none)).toBe(true);
    const three = graph([[B, X], [X, Y], [Y, A]]);
    expect(linkedWithin(A, B, 2, three, none)).toBe(false);
    expect(linkedWithin(A, B, 3, three, none)).toBe(true);
    expect(linkedWithin(A, B, 1, graph([[B, X], [X, A]]), none)).toBe(false);
  });

  test("a shared funder links both sides, unless it is a hub", () => {
    const shared = graph([[X, A], [X, B]]);
    expect(linkedWithin(A, B, 2, shared, none)).toBe(true);
    expect(linkedWithin(A, B, 1, shared, none)).toBe(false); // two transfers in total
    expect(linkedWithin(A, B, 2, graph([[HUB, A], [HUB, B]]), (a) => a === HUB)).toBe(false);
    expect(linkedWithin(A, B, 3, graph([[Z, X], [X, A], [Z, B]]), none)).toBe(true);
  });

  test("paths never pass through a hub, but a hub can still be the payer or payee", () => {
    expect(linkedWithin(A, B, 2, graph([[B, HUB], [HUB, A]]), (a) => a === HUB)).toBe(false);
    expect(linkedWithin(A, HUB, 2, graph([[HUB, A]]), (a) => a === HUB)).toBe(true);
    const view = fundingView({ funders: new Map([[A, new Set([B])]]), hubs: new Set(), returns: [{ from: B, to: A, at: T0 }] }, 2);
    expect(view.linked(B, A)).toBe(true);
    expect(view.returned(B, A, new Date(T0 + DAY), DAY)).toBe(true);
    expect(view.returned(B, A, new Date(T0 + DAY + 1), DAY)).toBe(false);
  });
});

describe("aggregates", () => {
  test("exact medians, refund rates and distinct counts", () => {
    expect(median([])).toBeNull();
    expect(median([5n, 1n, 3n])).toBe(3n);
    expect(median([4n, 1n, 2n, 3n])).toBe(2n); // floor of (2 + 3) / 2
    expect(median([1n, 2n])).toBe(1n);
    expect(figures([])).toEqual({ settlements: 0, payers: 0, payees: 0, volume_usdg: "0", median_price_usdg: null, refunds: 0, refund_rate: null });
    expect(figures([s({ amountUsdg: 3n }), s({ amountUsdg: 1n, refunded: true }), s({ payer: addr("c3"), amountUsdg: 2n })])).toEqual({ settlements: 3, payers: 2, payees: 1, volume_usdg: "6", median_price_usdg: "2", refunds: 1, refund_rate: 0.3333 });
  });

  test("every window and every known kind carries gross and filtered figures side by side, even when empty", () => {
    const asOf = new Date(T0);
    const empty = report([], [], asOf, COMMERCE_KINDS.map((k) => k.kind));
    expect(Object.keys(empty)).toEqual(["24h", "7d", "30d"]);
    for (const w of Object.values(empty)) {
      expect(Object.keys(w.kinds)).toEqual(["model.call", "tool.call", "facilitator.settle", "job.release"]);
      for (const b of [w.total, ...Object.values(w.kinds)]) {
        expect(b.gross.settlements).toBe(0);
        expect(b.filtered).toEqual(b.gross);
        expect(Object.keys(b.excluded)).toEqual([...EXCLUSIONS]);
      }
    }
  });

  test("windows are (as_of - length, as_of]; excluded plus filtered adds up to gross; kinds are split", () => {
    const asOf = new Date(T0);
    const list = [
      s({ at: new Date(T0 - HOUR) }),
      s({ at: new Date(T0 - DAY) }), // on the 24h edge: outside 24h, inside 7d
      s({ kind: "tool.call", payer: "acct:1", payee: "acct:2", at: new Date(T0 - 3 * DAY), anchored: false }),
      s({ at: new Date(T0 - 20 * DAY), amountUsdg: 9n }),
      s({ at: new Date(T0 - 30 * DAY) }), // outside every window
      s({ at: new Date(T0 + 1) }), // after as_of
    ];
    const r = report(list, classify(list, null), asOf, ["model.call", "tool.call"]);
    expect([r["24h"].total.gross.settlements, r["7d"].total.gross.settlements, r["30d"].total.gross.settlements]).toEqual([1, 3, 4]);
    expect(r["7d"].kinds["tool.call"]).toMatchObject({ gross: { settlements: 1 }, filtered: { settlements: 0 }, excluded: { unanchored: 1 } });
    expect(r["7d"].kinds["model.call"].filtered.settlements).toBe(2);
    expect(r["30d"].total.filtered.median_price_usdg).toBe("1000000");
    for (const w of Object.values(r)) {
      const b = w.total;
      expect(b.filtered.settlements + Object.values(b.excluded).reduce((a, n) => a + n, 0)).toBe(b.gross.settlements);
    }
    expect(r["24h"].from).toBe(new Date(T0 - DAY).toISOString());
  });
});

test("the 60-second cache shares concurrent reads, expires on time and never serves a failure as data", async () => {
  let now = 0, reads = 0, failed = false;
  const get = statsCache(async () => { reads++; if (failed) throw Error("fixture failure"); return reads; }, () => now, COMMERCE_STATS_CACHE_MS);
  const results = await Promise.all([get(), get(), get()]);
  expect(reads).toBe(1);
  expect(results.every((r) => r.data === 1 && r.expires === 60_000)).toBe(true);
  now = 59_999; expect((await get()).data).toBe(1);
  now = 60_000; failed = true; await expect(get()).rejects.toThrow("fixture failure");
  failed = false; expect((await get()).data).toBe(3);
});

// ---- stored records, the HTTP surface and Dune parity ------------------------------------------------------------

const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)")).slice(2);
const AUTH_USED = keccak256(toBytes("AuthorizationUsed(address,bytes32)")).slice(2);
const ANCHORED = keccak256(toBytes("Anchored(uint256,bytes32,uint64,uint64,uint32)")).slice(2);
const word = (v: bigint | string) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");

type ChainTransfer = { from: string; to: string; units: bigint; at: number; tx: string; authorized?: boolean };

describe("commerce ledger over stored records", () => {
  let h: Harness;
  const PAY_TO = addr("d0402");
  const ROUTER = addr("1"); // FakeChain gives every signing role this address
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const asOf = new Date(Math.floor(Date.now() / 1000) * 1000);
  const ago = (ms: number) => asOf.getTime() - ms;
  const anchorEnd = ago(HOUR);
  const W = { A: addr("a"), B: addr("b"), C: addr("c"), E: addr("e"), F: addr("f"), G: addr("6"), H: addr("7"), I: addr("9"), J: addr("4a"), K: addr("4b"), X: addr("5a"), Y: addr("5b"), Z1: addr("5c"), Z2: addr("5d"), EXCH: addr("ee") };
  let txn = 0;
  const transfers: ChainTransfer[] = [];
  const settle: { payer: string; units: bigint; at: number; tx: string; refunded?: boolean; private?: boolean }[] = [];
  const plain = (from: string, to: string, units: bigint, at: number) => transfers.push({ from, to, units, at, tx: hash(++txn) });
  const pay = (payer: string, usdg: number, at: number, extra: { refunded?: boolean; private?: boolean; onlyOnChain?: boolean } = {}) => {
    const t = { from: payer, to: PAY_TO, units: BigInt(Math.round(usdg * 1e6)), at, tx: hash(++txn), authorized: true };
    transfers.push(t);
    if (!extra.onlyOnChain) settle.push({ payer, units: t.units, at, tx: t.tx, refunded: extra.refunded, private: extra.private });
  };

  beforeAll(async () => {
    h = await startRouter({ env: { COMMERCE_STATS_ENABLED: "true", X402_PAY_TO: PAY_TO, COMMERCE_FUNDING_FROM_BLOCK: "1" } });
    // Funding: an exchange (a hub by fan-out) funds most payers and 26 other wallets.
    for (const w of [W.A, W.C, W.I, W.J, W.K, W.H]) plain(W.EXCH, w, 50_000_000n, ago(30 * DAY));
    for (let i = 0; i < 26; i++) plain(W.EXCH, addr(`dd${i.toString(16).padStart(2, "0")}`), 1_000_000n, ago(29 * DAY));
    plain(W.EXCH, PAY_TO, 5_000_000n, ago(29 * DAY));
    plain(PAY_TO, W.B, 5_000_000n, ago(12 * DAY)); // the payee funded this payer
    plain(W.X, W.F, 2_000_000n, ago(20 * DAY)); // one wallet funded payer and payee
    plain(W.X, PAY_TO, 3_000_000n, ago(20 * DAY));
    plain(PAY_TO, W.Y, 10_000_000n, ago(15 * DAY)); // two hops
    plain(W.Y, W.G, 5_000_000n, ago(14 * DAY));
    plain(PAY_TO, W.Z1, 10_000_000n, ago(15 * DAY)); // three hops: beyond the default limit
    plain(W.Z1, W.Z2, 9_000_000n, ago(14 * DAY));
    plain(W.Z2, W.H, 8_000_000n, ago(13 * DAY));
    pay(W.J, 1, ago(40 * DAY), { onlyOnChain: true }); // an old settlement is never funding
    // Settlements.
    pay(W.A, 1, ago(2 * HOUR));
    pay(W.A, 2, ago(5 * HOUR), { refunded: true });
    pay(W.B, 3, ago(3 * HOUR));
    pay(W.C, 4, ago(HOUR / 2)); // after the newest anchor
    pay(ROUTER, 5, ago(4 * HOUR)); // the operator paying itself
    pay(W.E, 6, ago(6 * HOUR));
    plain(PAY_TO, W.E, 500_000n, ago(2 * HOUR)); // sent back within 24 hours (below the funding minimum)
    pay(W.F, 7, ago(7 * HOUR));
    pay(W.G, 8, ago(8 * HOUR));
    pay(W.H, 9, ago(3 * DAY));
    pay(W.I, 10.5, ago(10 * DAY));
    pay(W.J, 1.5, ago(9 * HOUR));
    pay(W.K, 2.5, ago(10 * HOUR), { private: true });

    const db = h.ctx.db;
    await db.insert(anchors).values({ index: 0, root: hash(9_999), fromTs: new Date(ago(40 * DAY)), toTs: new Date(anchorEnd), count: settle.length, txHash: hash(9_998), status: "confirmed" });
    let n = 0;
    for (const st of settle) {
      n++;
      const gen = `gen-commerce-${n}`;
      await db.insert(quotes).values({ nonce: `x402:${st.payer}:${hash(n)}`, priceUsdg: st.units, pricePico: usdgToPico(st.units), requestSha256: "a".repeat(64), modelId: MODELS.llama.id, expiresAt: new Date(st.at + 60_000), status: "used", payer: st.payer, txHash: st.tx, accountId: `w_${st.payer.slice(2)}`, createdAt: new Date(st.at) });
      await ensureAccount(db, `w_${st.payer.slice(2)}`, "wallet", st.payer);
      await post(db, { accountId: `w_${st.payer.slice(2)}`, amount: usdgToPico(st.units), kind: "per_call_payment", ref: `x402:${st.tx}`, description: "fixture" });
      await db.insert(generations).values({ id: gen, ts: new Date(st.at + 2_000), modelId: MODELS.llama.id, providerId: "alpha", mode: "per_call", paymentTx: st.tx, receiptLeaf: hash(50_000 + n), anchorIndex: st.at < anchorEnd ? 0 : null, private: !!st.private, receipt: st.private ? { lane: "attested" } : null });
      if (st.refunded) await post(db, { accountId: `w_${st.payer.slice(2)}`, amount: 100n, kind: "refund", ref: `refund:${gen}`, generationId: gen, description: "fixture" });
    }
    let block = 0n;
    for (const t of [...transfers].sort((a, b) => a.at - b.at)) {
      block++;
      await db.insert(commerceTransfers).values({ txHash: t.tx, logIndex: 1, blockNumber: block, blockTime: new Date(t.at), fromAddress: t.from, toAddress: t.to, valueUsdg: t.units, authorized: !!t.authorized, txFrom: t.authorized ? ROUTER : null });
    }
    await db.insert(chainCursor).values({ id: COMMERCE_CURSOR, block });
  });
  afterAll(async () => h?.close());

  test("disabled: no route, and /status says so", async () => {
    const off = { ...h.ctx, cfg: { ...h.ctx.cfg, commerce: { ...h.ctx.cfg.commerce, enabled: false } } };
    const app = new Hono();
    commerceStatsRoutes(app, off);
    expect((await app.request("/api/v1/commerce/stats")).status).toBe(404);
    expect(commerceStatus(off)).toEqual({ enabled: false, stats_url: null, kinds: [], receipt_anchor_configured: true, funding_filter: false });
    const status = (await (await h.request("/api/v1/status")).json()).data.commerce;
    expect(status).toEqual({ enabled: true, stats_url: "/api/v1/commerce/stats", kinds: ["model.call"], receipt_anchor_configured: true, funding_filter: true });
  });

  test("filters: anchored only, no self-dealing, no round trips, no funding links; gross beside filtered", async () => {
    const data = await readCommerceStats(h.ctx, asOf);
    expect(data.filters.funding).toMatchObject({ available: true, hops: 2, min_units: "1000000", hub_fanout: 25, from_block: "1" });
    expect(data.kinds).toEqual([
      { kind: "model.call", label: "Model calls (x402)", wired: true },
      { kind: "tool.call", label: "Tool calls", wired: false },
      { kind: "facilitator.settle", label: "Facilitator settlements", wired: false },
      { kind: "job.release", label: "Job releases", wired: false },
    ]);
    const day = data.windows["24h"].kinds["model.call"];
    expect(day.excluded).toEqual({ unanchored: 1, same_owner: 1, round_trip: 1, funding_link: 3 });
    expect(day.gross).toEqual({ settlements: 10, payers: 9, payees: 1, volume_usdg: "40000000", median_price_usdg: "3500000", refunds: 1, refund_rate: 0.1 });
    expect(day.filtered).toEqual({ settlements: 4, payers: 3, payees: 1, volume_usdg: "7000000", median_price_usdg: "1750000", refunds: 1, refund_rate: 0.25 });
    expect(data.windows["7d"].kinds["model.call"].filtered.settlements).toBe(5); // three hops away is not linked
    expect(data.windows["30d"].kinds["model.call"]).toMatchObject({ gross: { settlements: 12 }, filtered: { settlements: 6 } }); // a hub links nobody
    expect(data.windows["30d"].total).toEqual(data.windows["30d"].kinds["model.call"]);
    for (const kind of ["tool.call", "facilitator.settle", "job.release"]) expect(data.windows["30d"].kinds[kind].gross.settlements).toBe(0);
  });

  test("the published query recomputes the same on-chain figures from chain logs alone", async () => {
    const data = await readCommerceStats(h.ctx, asOf);
    const rows = await runDuneQuery({ transfers, asOf, anchorEnd, payTo: PAY_TO, router: ROUTER, usdg: USDG, anchor: ADDR.receiptAnchor, operators: [PAY_TO, ROUTER], hubs: Object.values(h.ctx.chain.status().contracts).filter((a): a is `0x${string}` => !!a) });
    const num = (v: unknown) => (v === null || v === undefined ? null : String(v).replace(/\.0+$/, ""));
    for (const w of ["24h", "7d", "30d"] as const) {
      const r = rows.find((x) => x.window_name === w && x.kind === "model.call")!;
      const all = rows.find((x) => x.window_name === w && x.kind === "all")!;
      const b = data.windows[w].kinds["model.call"];
      expect(num(all.filtered_settlements)).toBe(num(r.filtered_settlements));
      expect({
        gross: [num(r.gross_settlements), num(r.gross_payers), num(r.gross_payees), num(r.gross_volume_units), num(r.gross_median_units)],
        filtered: [num(r.filtered_settlements), num(r.filtered_payers), num(r.filtered_payees), num(r.filtered_volume_units), num(r.filtered_median_units)],
        excluded: [num(r.excluded_unanchored), num(r.excluded_same_owner), num(r.excluded_round_trip), num(r.excluded_funding_link)],
      }).toEqual({
        gross: [String(b.gross.settlements), String(b.gross.payers), String(b.gross.payees), b.gross.volume_usdg, b.gross.median_price_usdg],
        filtered: [String(b.filtered.settlements), String(b.filtered.payers), String(b.filtered.payees), b.filtered.volume_usdg, b.filtered.median_price_usdg],
        excluded: [String(b.excluded.unanchored), String(b.excluded.same_owner), String(b.excluded.round_trip), String(b.excluded.funding_link)],
      });
    }
  });

  test("other receipt kinds plug in by registering a source; off-chain ids get every rule but funding", async () => {
    const at = (h: number) => new Date(asOf.getTime() - h * HOUR);
    const tool = (o: Partial<Settlement>): Settlement => ({ kind: "tool.call", payer: "acct:buyer", payee: "acct:seller", amountUsdg: 250_000n, at: at(1), anchored: true, refunded: false, ...o });
    const remove = registerCommerceSource({ kind: "tool.call", read: async (_ctx, since, until) => [
      tool({}),
      tool({ payer: "acct:seller", payee: "acct:buyer", at: at(3) }), // the seller paid the buyer back: both legs are a round trip
      tool({ payer: "acct:other", payerOwner: "owner:1", payeeOwner: "owner:1" }),
      tool({ payer: "acct:third", at: at(2), refunded: true }),
      tool({ payer: "acct:late", anchored: false }),
    ].filter((x) => x.at > since && x.at <= until) });
    try {
      const data = await readCommerceStats(h.ctx, asOf);
      expect(data.kinds.find((k) => k.kind === "tool.call")?.wired).toBe(true);
      const b = data.windows["24h"].kinds["tool.call"];
      expect(b.excluded).toEqual({ unanchored: 1, same_owner: 1, round_trip: 2, funding_link: 0 });
      expect(b.filtered).toEqual({ settlements: 1, payers: 1, payees: 1, volume_usdg: "250000", median_price_usdg: "250000", refunds: 1, refund_rate: 1 });
      expect(data.windows["24h"].total.gross.settlements).toBe(data.windows["24h"].kinds["model.call"].gross.settlements + 5);
      expect(commerceStatus(h.ctx).kinds).toEqual(["model.call", "tool.call"]);
    } finally {
      remove();
    }
    expect(commerceStatus(h.ctx).kinds).toEqual(["model.call"]);
  });

  test("public, cached, and never names a payer, payee, transaction or lane", async () => {
    const first = await h.request("/api/v1/commerce/stats");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toMatch(/^public, max-age=([0-5]?\d|60), must-revalidate$/);
    const text = await first.text();
    const { data } = JSON.parse(text);
    expect(data.cache_seconds).toBe(60);
    expect(data.windows["24h"].total.filtered.settlements).toBe(4);
    for (const secret of [...Object.values(W), ROUTER, PAY_TO, ...settle.map((x) => x.tx), "attested", "unlinkable", "w_", "gen-commerce"]) expect(text).not.toContain(secret);
    // The snapshot is reused until it expires: new records do not show before then.
    await h.ctx.db.update(quotes).set({ status: "failed" });
    expect((await (await h.request("/api/v1/commerce/stats")).json()).data.windows["24h"].total.gross.settlements).toBe(10);
    expect((await readCommerceStats(h.ctx, asOf)).windows["24h"].total.gross.settlements).toBe(0);
  });

  test("a failed read is a 503 with no stale snapshot and no detail", async () => {
    const remove = registerCommerceSource({ kind: "job.release", read: async () => { throw new Error("fixture source failure"); } });
    try {
      const app = new Hono();
      app.onError((error, c) => (error instanceof ApiError ? c.json(error.toJSON(), error.status as 503) : c.json({}, 500)));
      commerceStatsRoutes(app, h.ctx);
      const res = await app.request("/api/v1/commerce/stats");
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toContain("fixture source failure");
    } finally {
      remove();
    }
  });
});

describe("empty ledger", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { COMMERCE_STATS_ENABLED: "true" } });
  });
  afterAll(async () => h?.close());

  test("zeros everywhere, both columns, with the funding filter reported as unavailable", async () => {
    const res = await h.request("/api/v1/commerce/stats");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.filters.funding).toMatchObject({ available: false, from_block: null, indexed_block: null });
    for (const w of ["24h", "7d", "30d"]) {
      const b = data.windows[w].total;
      expect(b.gross).toEqual({ settlements: 0, payers: 0, payees: 0, volume_usdg: "0", median_price_usdg: null, refunds: 0, refund_rate: null });
      expect(b.filtered).toEqual(b.gross);
      expect(Object.keys(data.windows[w].kinds)).toEqual(["model.call", "tool.call", "facilitator.settle", "job.release"]);
    }
    expect((await (await h.request("/api/v1/status")).json()).data.commerce).toMatchObject({ enabled: true, funding_filter: false });
  });

  test("the transfer index copies USDG transfers once, behind the confirmation depth", async () => {
    h.ctx.cfg.commerce.funding.fromBlock = 90n;
    const seen: [bigint, bigint][] = [];
    const logs: UsdgTransfer[] = [
      { from: addr("a"), to: addr("b"), value: 5n, txHash: hash(1) as `0x${string}`, logIndex: 0, blockNumber: 91n, blockTime: 1_790_000_000, authorized: false, txFrom: null },
      { from: addr("b"), to: addr("c"), value: (1n << 70n), txHash: hash(2) as `0x${string}`, logIndex: 3, blockNumber: 99n, blockTime: 1_790_000_100, authorized: true, txFrom: addr("1") as `0x${string}` },
      { from: addr("c"), to: addr("d"), value: 7n, txHash: hash(3) as `0x${string}`, logIndex: 0, blockNumber: 100n, blockTime: 1_790_000_200, authorized: false, txFrom: null },
    ];
    h.chain.usdgTransfers = async (from: bigint, to: bigint) => { seen.push([from, to]); return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to); };
    h.chain.escrowHead = 100n; // two confirmations: block 99 is the newest read
    expect(await pollCommerceTransfers(h.ctx, 5n)).toEqual({ head: "100", indexed: "99", recorded: 2 });
    expect(seen).toEqual([[90n, 94n], [95n, 99n]]);
    expect(await pollCommerceTransfers(h.ctx, 5n)).toEqual({ head: "100", indexed: "99", recorded: 0 });
    h.chain.escrowHead = 101n;
    expect(await pollCommerceTransfers(h.ctx, 5n)).toEqual({ head: "101", indexed: "100", recorded: 1 });
    const rows = await h.ctx.db.select().from(commerceTransfers).orderBy(commerceTransfers.blockNumber);
    expect(rows.map((r) => [r.blockNumber, r.fromAddress, r.authorized, r.txFrom])).toEqual([[91n, addr("a"), false, null], [99n, addr("b"), true, addr("1")], [100n, addr("c"), false, null]]);
    expect(rows[1].valueUsdg).toBe((1n << 63n) - 1n); // clamped, never wrapped
    expect(rows[1].blockTime.getTime()).toBe(1_790_000_100_000);
    h.ctx.cfg.commerce.enabled = false;
    expect(await pollCommerceTransfers(h.ctx)).toEqual({ skipped: "not configured" });
  });
});

/** Run integrations/dune/commerce.sql on an in-process Postgres holding the same chain logs. */
async function runDuneQuery(o: { transfers: ChainTransfer[]; asOf: Date; anchorEnd: number; payTo: string; router: string; usdg: string; anchor: string; operators: string[]; hubs: string[] }) {
  const db = new PGlite();
  await db.exec(`
    create schema robinhood_chain;
    create table robinhood_chain.logs (block_time timestamptz, block_number bigint, tx_hash bytea, index int, tx_from bytea, contract_address bytea, topic0 bytea, topic1 bytea, topic2 bytea, topic3 bytea, data bytea);
    create function bytearray_substring(b bytea, s int, n int) returns bytea language sql immutable as $$ select substr(b, s, n) $$;
    create function bytearray_to_bigint(b bytea) returns bigint language sql immutable as $$ select ('x' || lpad(encode(b, 'hex'), 16, '0'))::bit(64)::bigint $$;
    create function from_unixtime(x double precision) returns timestamptz language sql immutable as $$ select to_timestamp(x) $$;
    create function to_unixtime(t timestamptz) returns double precision language sql immutable as $$ select extract(epoch from t)::double precision $$;
  `);
  const hex = (v: string) => `decode('${v.replace(/^0x/, "")}', 'hex')`;
  const rows: string[] = [];
  let block = 0;
  for (const t of [...o.transfers].sort((a, b) => a.at - b.at)) {
    block++;
    const time = `to_timestamp(${t.at / 1000})`;
    rows.push(`(${time}, ${block}, ${hex(t.tx)}, 1, ${hex(t.authorized ? o.router : t.from)}, ${hex(o.usdg)}, ${hex(TRANSFER)}, ${hex(word(t.from))}, ${hex(word(t.to))}, null, ${hex(word(t.units))})`);
    if (t.authorized) rows.push(`(${time}, ${block}, ${hex(t.tx)}, 0, ${hex(o.router)}, ${hex(o.usdg)}, ${hex(AUTH_USED)}, ${hex(word(t.from))}, ${hex(word(BigInt(block)))}, null, ${hex("")})`);
  }
  const anchorData = word(9_999n) + word(BigInt(Math.floor((o.anchorEnd - 40 * DAY) / 1000))) + word(BigInt(Math.floor(o.anchorEnd / 1000))) + word(12n);
  rows.push(`(to_timestamp(${o.anchorEnd / 1000 + 60}), ${block + 1}, ${hex(word(1n))}, 0, ${hex(o.router)}, ${hex(o.anchor)}, ${hex(ANCHORED)}, ${hex(word(0n))}, null, null, ${hex(anchorData)})`);
  await db.exec(`insert into robinhood_chain.logs values ${rows.join(",\n")}`);
  const zero = "0x0000000000000000000000000000000000000000";
  const list = (xs: string[]) => xs.map((x) => `(${x.toLowerCase()})`).join(", ");
  let q = readFileSync(new URL("../integrations/dune/commerce.sql", import.meta.url), "utf8");
  for (const [from, to] of [
    [`${zero} as pay_to,`, `${o.payTo} as pay_to,`],
    [`${zero} as receipt_anchor,`, `${o.anchor.toLowerCase()} as receipt_anchor,`],
    ["cast(0 as bigint) as from_block,", "cast(1 as bigint) as from_block,"],
    ["now() as as_of", `timestamptz '${o.asOf.toISOString()}' as as_of`],
    [`router_signers (address) as (values (${zero}))`, `router_signers (address) as (values ${list([o.router])})`],
    [`operators (address) as (values (${zero}))`, `operators (address) as (values ${list(o.operators)})`],
    [`extra_hubs (address) as (values (${zero}))`, `extra_hubs (address) as (values ${list(o.hubs)})`],
    ["as double)", "as double precision)"],
  ]) {
    expect(q).toContain(from);
    q = q.replace(from, to);
  }
  q = q.replace(/\b0x([0-9a-fA-F]+)\b/g, (_m, h: string) => `'\\x${h}'::bytea`);
  const result = await db.query<Record<string, unknown>>(q);
  await db.close();
  return result.rows;
}
