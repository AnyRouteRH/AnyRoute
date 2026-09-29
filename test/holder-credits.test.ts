import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { kv, ledger } from "../src/db/schema.ts";
import { allocateCredits, applyCredits, BURN, creditRef, defaultExclusions, holderCreditsFor, recordRun, takeSnapshot, walletAccount, ZERO, type Holding, type SnapshotChain } from "../src/holders/credits.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";

const TOKEN = "0x00000000000000000000000000000000000a4e01" as Hex;
// ANYR_TOKEN_ADDRESS also turns on $ANYR escrow pricing, which needs pool legs from the token to USDG.
const LEGS = JSON.stringify([{ key: { currency0: TOKEN, currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 0, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" }, sign: 1 }]);
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const D = "0x00000000000000000000000000000000000000d4";
const tok = (n: bigint) => n * 10n ** 18n;
const usd = (v: string | number) => usdToPico(String(v));
const holdings: Holding[] = [
  { address: A, balance: tok(600n) },
  { address: B, balance: tok(300n) },
  { address: C, balance: tok(100n) },
];
const creditOf = (rows: { address: string; credit: bigint }[], a: string) => rows.find((r) => r.address === a)?.credit ?? 0n;

describe("holder credits: snapshot math", () => {
  test("pro-rata by balance splits the whole budget", () => {
    const r = allocateCredits({ holdings, minRaw: 0n, budget: usd(100) });
    expect(r.rows.map((x) => [x.address, x.credit])).toEqual([
      [A, usd(60)],
      [B, usd(30)],
      [C, usd(10)],
    ]);
    expect(r.total).toBe(usd(100));
    expect(r.unallocated).toBe(0n);
    expect(r.eligible).toBe(3);
  });

  test("a per-wallet cap re-splits the excess among the others until nobody is over", () => {
    // Round 1: 60/30/10, A capped at 40. Round 2: 60 left for B:C = 45/15, B capped. Round 3: C gets 20.
    const r = allocateCredits({ holdings, minRaw: 0n, budget: usd(100), max: usd(40) });
    expect(creditOf(r.rows, A)).toBe(usd(40));
    expect(creditOf(r.rows, B)).toBe(usd(40));
    expect(creditOf(r.rows, C)).toBe(usd(20));
    expect(r.rows.filter((x) => x.capped).map((x) => x.address)).toEqual([A, B]);
    expect(r.total).toBe(usd(100));
  });

  test("when every wallet is capped the rest stays unallocated", () => {
    const r = allocateCredits({ holdings, minRaw: 0n, budget: usd(100), max: usd(10) });
    expect(r.rows.every((x) => x.credit === usd(10) && x.capped)).toBe(true);
    expect(r.total).toBe(usd(30));
    expect(r.unallocated).toBe(usd(70));
  });

  test("--equal gives every eligible wallet the same amount", () => {
    const r = allocateCredits({ holdings, minRaw: 0n, budget: usd(90), split: "equal" });
    expect(r.rows.map((x) => x.credit)).toEqual([usd(30), usd(30), usd(30)]);
    const capped = allocateCredits({ holdings, minRaw: 0n, budget: usd(90), split: "equal", max: usd(25) });
    expect(capped.total).toBe(usd(75));
  });

  test("--min drops smaller holders; the budget goes to the rest", () => {
    const r = allocateCredits({ holdings, minRaw: tok(300n), budget: usd(90) });
    expect(r.eligible).toBe(2);
    expect(r.belowMin).toBe(1);
    expect(creditOf(r.rows, A)).toBe(usd(60));
    expect(creditOf(r.rows, B)).toBe(usd(30));
    expect(r.rows.find((x) => x.address === C)).toBeUndefined();
  });

  test("excluded addresses never receive credits, whatever they hold", () => {
    const r = allocateCredits({ holdings, minRaw: 0n, budget: usd(100), exclude: new Set([A]) });
    expect(r.excluded).toBe(1);
    expect(creditOf(r.rows, A)).toBe(0n);
    expect(creditOf(r.rows, B)).toBe(usd(75));
    expect(creditOf(r.rows, C)).toBe(usd(25));
  });

  test("credits are whole micro-dollars and never exceed the budget", () => {
    const odd: Holding[] = [
      { address: A, balance: 7n },
      { address: B, balance: 5n },
      { address: C, balance: 3n },
    ];
    const r = allocateCredits({ holdings: odd, minRaw: 0n, budget: usd("0.00001") });
    expect(r.total).toBe(usd("0.00001"));
    for (const row of r.rows) expect(row.credit % 1_000_000n).toBe(0n);
  });

  test("default exclusions: zero, burn, token, v4 PoolManager, escrow, treasury and HOLDER_CREDITS_EXCLUDE", () => {
    const pool = "0x00000000000000000000000000000000000000Ee";
    const cfg = loadConfig({ ANYR_TOKEN_ADDRESS: TOKEN, ANYR_POOL_LEGS: LEGS, HOLDER_CREDITS_EXCLUDE: `${pool}, ${D}`, CALLPAY_TREASURY: "0x0000000000000000000000000000000000000Fee" });
    const set = defaultExclusions(cfg, [B]);
    const poolManager = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Uniswap v4 on Robinhood Chain (config/rhc-mainnet.json)
    for (const a of [ZERO, BURN, TOKEN, poolManager, pool.toLowerCase(), D, B, "0x0000000000000000000000000000000000000fee"]) expect(set.has(a)).toBe(true);
    expect(set.has(A)).toBe(false);
    expect(() => loadConfig({ HOLDER_CREDITS_EXCLUDE: "pool" })).toThrow(/comma list of 0x addresses/);
  });

  /** A plain ERC-20 on a fake node: balances follow the transfers; `archive` = it keeps historical state. */
  function fakeToken(o: { archive: boolean; head?: bigint; maxRange?: bigint }) {
    const E = "0x00000000000000000000000000000000000000e5";
    const log: { block: bigint; from: string; to: string; value: bigint }[] = [
      { block: 105n, from: ZERO, to: A, value: tok(1000n) }, // mint
      { block: 150n, from: A, to: B, value: tok(300n) },
      { block: 199n, from: B, to: C, value: tok(300n) }, // B ends at 0
      { block: 210n, from: A, to: C, value: tok(5n) },
      { block: 220n, from: A, to: D, value: tok(90n) }, // a pool contract
      { block: 260n, from: A, to: BURN, value: tok(5n) },
      { block: 320n, from: A, to: E, value: tok(100n) }, // after the snapshot block: A moves
    ];
    const calls = { ranges: [] as [bigint, bigint][], reads: [] as (bigint | undefined)[], balanceOf: [] as string[] };
    const state = { log, calls, feeOn: null as string | null };
    const head = o.head ?? 330n;
    const at = (who: string, block: bigint) => log.filter((l) => l.block <= block).reduce((s, l) => s + (l.to === who ? l.value : 0n) - (l.from === who ? l.value : 0n), 0n);
    const chain: SnapshotChain = {
      finalizedBlock: async () => 300n,
      headBlock: async () => head,
      decimals: async () => 18,
      async transfers(_t, from, to) {
        calls.ranges.push([from, to]);
        if (to - from + 1n > (o.maxRange ?? 10_000n)) throw new Error("query exceeds max block range");
        return log.filter((l) => l.block >= from && l.block <= to).map(({ from, to, value }) => ({ from, to, value }));
      },
      async balanceOf(_t, holder, block) {
        calls.reads.push(block);
        calls.balanceOf.push(holder);
        if (block !== undefined && !o.archive) throw new Error(`historical state for block ${block} is not available`);
        const v = at(holder, block ?? head);
        return holder === state.feeOn ? v - 1n : v; // a token that skims transfers would disagree with its logs
      },
      isContract: async (a) => a === D,
    };
    return { chain, state, E };
  }

  test("snapshot on an archive node: balanceOf at the block; refused log ranges are halved", async () => {
    const { chain, state } = fakeToken({ archive: true, maxRange: 64n });
    const snap = await takeSnapshot(chain, { token: TOKEN, fromBlock: 100n, chunk: 200n, exclude: new Set([ZERO, BURN]), minRaw: tok(1n) });
    expect(snap).toMatchObject({ block: 300n, source: "archive", contracts: [D], moved: 0 });
    expect(snap.holdings).toEqual([
      { address: A, balance: tok(600n) },
      { address: C, balance: tok(305n) },
    ]);
    expect(state.calls.balanceOf).not.toContain(ZERO); // excluded before any balance call
    expect(state.calls.balanceOf).not.toContain(BURN);
    expect(new Set(state.calls.reads)).toEqual(new Set([300n]));
    // 200 → 100 → 50 blocks per request after refusals, and the scan covered 100..300 without gaps.
    const ok = state.calls.ranges.filter(([f, t]) => t - f + 1n <= 64n);
    expect(ok[0][0]).toBe(100n);
    expect(ok.at(-1)![1]).toBe(300n);
    for (let i = 1; i < ok.length; i++) expect(ok[i][0]).toBe(ok[i - 1][1] + 1n);
  });

  test("snapshot on a node without historical state: replayed logs, checked against the latest balances", async () => {
    const { chain, E } = fakeToken({ archive: false });
    const snap = await takeSnapshot(chain, { token: TOKEN, fromBlock: 100n, exclude: new Set([ZERO, BURN]), minRaw: tok(1n) });
    expect(snap.source).toBe("logs");
    // A moved after the snapshot (block 320): its balance at block 300 comes from the logs, not from now.
    expect(snap.holdings).toEqual([
      { address: A, balance: tok(600n) },
      { address: C, balance: tok(305n) },
    ]);
    expect(snap.moved).toBe(1);
    expect(snap.verified).toBe(3); // B (0), C and D matched balanceOf exactly
    expect(snap.holdings.find((x) => x.address === E)).toBeUndefined(); // received after the snapshot
  });

  test("a snapshot whose logs disagree with balanceOf is refused", async () => {
    const { chain, state } = fakeToken({ archive: false });
    state.feeOn = C;
    await expect(takeSnapshot(chain, { token: TOKEN, fromBlock: 100n, exclude: new Set([ZERO, BURN]) })).rejects.toThrow(/disagree for 1 holder/);
    // Starting after the mint leaves a sender negative: the deploy block is wrong.
    await expect(takeSnapshot(chain, { token: TOKEN, fromBlock: 106n, exclude: new Set([ZERO, BURN]) })).rejects.toThrow(/negative balance; check the deploy block/);
  });
});

describe("holder credits: --apply", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("credits each wallet once per period; re-running the period changes nothing", async () => {
    const rows = allocateCredits({ holdings, minRaw: 0n, budget: usd(100) }).rows;
    const first = await applyCredits(h.ctx.db, { period: "2026-09", symbol: "ANYR", rows });
    expect(first).toMatchObject({ credited: 3, alreadyCredited: 0, creditedTotal: usd(100) });
    const again = await applyCredits(h.ctx.db, { period: "2026-09", symbol: "ANYR", rows });
    expect(again).toMatchObject({ credited: 0, alreadyCredited: 3, creditedTotal: 0n });
    // A later snapshot for the same period (balances moved) still credits nobody twice.
    const moved = allocateCredits({ holdings: [...holdings, { address: D, balance: tok(1000n) }], minRaw: 0n, budget: usd(100) }).rows;
    const rerun = await applyCredits(h.ctx.db, { period: "2026-09", symbol: "ANYR", rows: moved });
    expect(rerun).toMatchObject({ credited: 1, alreadyCredited: 3 });
    expect((await balanceOf(h.ctx.db, walletAccount(A))).balance).toBe(usd(60));
    const refs = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, creditRef("2026-09", A)));
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("holder_credit");
    // A new period credits again.
    await applyCredits(h.ctx.db, { period: "2026-10", symbol: "ANYR", rows });
    expect((await balanceOf(h.ctx.db, walletAccount(A))).balance).toBe(usd(120));
    expect((await holderCreditsFor(h.ctx.db, walletAccount(A))).map((c) => [c.period, c.usd])).toEqual([
      ["2026-10", 60],
      ["2026-09", 60],
    ]);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
    await expect(applyCredits(h.ctx.db, { period: "bad:period", symbol: "ANYR", rows })).rejects.toThrow(/period/);
  });

  test("each --apply run leaves a queryable summary row", async () => {
    const key = await recordRun(h.ctx.db, "2026-09", { credited: 3, credited_usd: "100" });
    const [row] = await h.ctx.db.select().from(kv).where(and(eq(kv.key, key), like(kv.key, "holder-credits-run:2026-09:%")));
    expect(row.value).toMatchObject({ period: "2026-09", credited: 3, credited_usd: "100" });
  });

  test("credits land on the wallet sign-in account and pay for inference", async () => {
    const wallet = privateKeyToAccount(("0x" + "7c".repeat(32)) as Hex);
    const address = wallet.address.toLowerCase();
    await applyCredits(h.ctx.db, { period: "2026-09", symbol: "ANYR", rows: [{ address, balance: tok(1n), credit: usd(1), capped: false }] });
    const challenge = (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address } })).json()).data;
    const signIn = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address, nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) } })).json();
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${signIn.key}` }, json: { model: "meta-llama/llama-3.3-70b-instruct", messages: [{ role: "user", content: "hi" }], max_tokens: 20 } });
    expect(r.status).toBe(200);
    const bal = await balanceOf(h.ctx.db, walletAccount(address));
    expect(bal.balance).toBeLessThan(usd(1));
    expect(bal.balance).toBeGreaterThan(0n);
  });
});
