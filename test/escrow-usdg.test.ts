import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { NVDA, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { chainCursor, escrowDeposits, ledger } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { accountDeposits } from "../src/pay/deposit-progress.ts";
import { acceptedTokens, clearEscrowPriceCache, escrowAccountId, escrowDepositsFor, escrowReviewsOpen, pollEscrow } from "../src/pay/escrow.ts";

// Add funds with USDG through the escrow wallet: same watcher, finality, reorganization, idempotency and
// fast-credit rules as Stock Tokens and $ANYR, credited 1:1 at par with no price feed.
const ESCROW = "0x00000000000000000000000000000000000e5c20";
const FEED = "0x00000000000000000000000000000000000fee01";
const USDG = loadConfig().chain.usdg.toLowerCase() as Hex;
const stocks = JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18, feed: FEED }]);
const escrowEnv = { PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: ESCROW, ESCROW_TOKENS: stocks, ESCROW_HAIRCUT_BPS: "300", ESCROW_START_BLOCK: "1" };
const usdgEnv = { USDG_ESCROW_ENABLED: "true" };
const units = (n: number) => BigInt(Math.round(n * 1e6)); // USDG base units (6 decimals)
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 6n; // pico-USD
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
/** USDG has 6 decimals on-chain; every other token here has 18. */
const realDecimals = (r: Harness) => {
  (r.ctx.chain as unknown as { tokenDecimals: (t: Hex) => Promise<number> }).tokenDecimals = async (t) => (t.toLowerCase() === USDG ? 6 : 18);
};

describe("adding funds with USDG through escrow", () => {
  let h: Harness;
  let feedReads = 0;
  const send = (token: string, raw: bigint, from: Hex) => {
    h.chain.escrowHead += 10n;
    const t = { token: token as Hex, from, value: raw, txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n };
    h.chain.escrowLogs.push(t);
    return t;
  };
  const row = async (t: { txHash: Hex }) => (await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash)))[0];
  const balance = async (a: Hex) => (await balanceOf(h.ctx.db, escrowAccountId(a))).balance;

  beforeAll(async () => {
    h = await startRouter({ env: { ...escrowEnv, ...usdgEnv } });
    realDecimals(h);
    h.chain.client.getLogs = (async () => []) as never; // no Credits contract deposits here
    const readFeed = h.chain.readFeed.bind(h.chain);
    h.chain.readFeed = (async () => {
      feedReads++;
      return readFeed();
    }) as typeof h.chain.readFeed;
  });
  afterAll(async () => h.close());
  beforeEach(() => {
    clearEscrowPriceCache();
    feedReads = 0;
    h.chain.escrowFinalLag = 0n;
    h.ctx.cfg.usdgEscrow!.haircutBps = 0;
    h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
  });

  test("a USDG transfer is credited 1:1 at par once final, with its own ledger kind; stocks keep their haircut", async () => {
    const from = wallet(0xabab01);
    h.chain.escrowFinalLag = 5n;
    const u = send(USDG, units(40), from);
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, seen: 1, credited: 0 });
    expect(await row(u)).toMatchObject({ status: "pending_finality", symbol: "USDG", credited: null });
    expect(await balance(from)).toBe(0n);
    h.chain.escrowFinalLag = 0n;
    const s = send(NVDA, 10n ** 18n, from);
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 2, credited: 2, waiting: 0 });
    expect(await row(u)).toMatchObject({ status: "credited", symbol: "USDG", credited: usd(40), price18: (10n ** 18n).toString(), error: null, reviewReason: null });
    expect(await row(s)).toMatchObject({ status: "credited", credited: usd(174.6) }); // 1 NVDA x $180 x 97%
    expect(await balance(from)).toBe(usd(214.6));
    const [entry] = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow:${u.txHash}:0`));
    expect(entry).toMatchObject({ kind: "usdg_deposit", amount: usd(40) });
    expect(entry.description).toContain("40 USDG sent to escrow");
    // Deposit progress shows the USDG deposit, its worth fixed at par.
    const progress = (await accountDeposits(h.ctx, escrowAccountId(from))).deposits.find((d) => d.tx_hash === u.txHash);
    expect(progress).toMatchObject({ lane: "escrow", symbol: "USDG", amount: "40", worth_usd: 40, worth_fixed: true, credited_usd: 40, stage: "final" });
    expect((await escrowDepositsFor(h.ctx, escrowAccountId(from))).find((d) => d.tx_hash === u.txHash)).toMatchObject({ symbol: "USDG", amount: "40", price_usd: 1, credited_usd: 40, stage: "credited" });
  });

  test("idempotent: another poll, a repeated log and a rescan from the start block credit nothing more", async () => {
    const from = wallet(0xabab02);
    const u = send(USDG, units(12.5), from);
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1 });
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
    h.chain.escrowLogs.push({ ...u });
    await h.ctx.db.delete(chainCursor).where(eq(chainCursor.id, "escrow"));
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
    expect(await balance(from)).toBe(usd(12.5));
    expect(await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow:${u.txHash}:0`))).toHaveLength(1);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("USDG_ESCROW_HAIRCUT_BPS applies to USDG only", async () => {
    h.ctx.cfg.usdgEscrow!.haircutBps = 100;
    const from = wallet(0xabab03);
    const u = send(USDG, units(100), from);
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1 });
    expect(await row(u)).toMatchObject({ status: "credited", credited: usd(99) });
  });

  test("a deposit above the per-deposit limit is credited only up to it and flagged for operator review", async () => {
    const from = wallet(0xabab04);
    const u = send(USDG, units(1_500), from);
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1 });
    const r = await row(u);
    expect(r).toMatchObject({ status: "credited", credited: usd(1_000), reviewedAt: null });
    expect(r.error).toBe("Credited $1000.00 of $1500.00: USDG deposits are credited up to $1000.00 each. The rest is held for operator review.");
    expect(r.reviewReason).toContain("above the per-deposit limit");
    expect((await escrowReviewsOpen(h.ctx.db)).map((x) => x.id)).toContain(r.id);
    const [entry] = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow:${r.id}`));
    expect(entry).toMatchObject({ kind: "usdg_deposit", amount: usd(1_000) });
    expect(entry.description).toContain("per-deposit limit");
    // Exactly at the limit is credited in full, without a review.
    const at = send(USDG, units(1_000), from);
    await pollEscrow(h.ctx);
    expect(await row(at)).toMatchObject({ status: "credited", credited: usd(1_000), reviewReason: null, error: null });
    expect(await balance(from)).toBe(usd(2_000));
  });

  test("a transfer dropped before finality is orphaned uncredited; a credit reorganized away is reversed with its own kind", async () => {
    const from = wallet(0xabab05);
    h.chain.escrowFinalLag = 5n;
    const dropped = send(USDG, units(7), from);
    await pollEscrow(h.ctx);
    expect(await row(dropped)).toMatchObject({ status: "pending_finality" });
    h.chain.reorg(dropped.blockNumber, (logs) => logs.filter((l) => l.txHash !== dropped.txHash));
    h.chain.escrowFinalLag = 0n;
    await pollEscrow(h.ctx);
    expect(await row(dropped)).toMatchObject({ status: "orphaned", credited: null });
    expect(await balance(from)).toBe(0n);

    const u = send(USDG, units(3), from);
    await pollEscrow(h.ctx);
    expect(await balance(from)).toBe(usd(3));
    h.chain.reorg(u.blockNumber, (logs) => logs.filter((l) => l.txHash !== u.txHash));
    expect(await pollEscrow(h.ctx)).toMatchObject({ reversed: 1 });
    const [rev] = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow-reversal:${u.txHash}:0`));
    expect(rev).toMatchObject({ kind: "usdg_deposit_reversal", amount: -usd(3) });
    expect(await row(u)).toMatchObject({ status: "reversed" });
    expect((await escrowReviewsOpen(h.ctx.db)).map((x) => x.id)).toContain(`${u.txHash}:0`);
    expect(await balance(from)).toBe(0n);
    expect(await pollEscrow(h.ctx)).toMatchObject({ reversed: 0 });
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("USDG is never priced through a feed: it is credited while every feed is unreadable", async () => {
    h.chain.feedReading = null;
    const from = wallet(0xabab06);
    const u = send(USDG, units(5), from);
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1, waiting: 0 });
    expect(feedReads).toBe(0);
    expect(await row(u)).toMatchObject({ status: "credited", credited: usd(5), price18: (10n ** 18n).toString() });
    const tok = acceptedTokens(h.ctx).find((t) => t.address === USDG)!;
    expect(tok).toMatchObject({ kind: "usdg", symbol: "USDG", decimals: 6 });
    expect("feed" in tok).toBe(false);
    // The public rate stays $1 while the stock feed is down.
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    const bySymbol = Object.fromEntries(info.tokens.map((t: { symbol: string }) => [t.symbol, t]));
    expect(bySymbol.NVDA).toMatchObject({ price_usd: null });
    expect(bySymbol.USDG).toMatchObject({ price_usd: 1, credit_usd_per_token: 1, price_reason: null });
    // Listing USDG with a feed is refused while USDG escrow is on.
    expect(() => loadConfig({ ...usdgEnv, ESCROW_TOKENS: JSON.stringify([{ symbol: "USDG", address: USDG, decimals: 6, feed: FEED }]) })).toThrow(/never through a price feed/);
  });

  test("public escrow info and status list USDG at par with its haircut and limit", async () => {
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    const t = info.tokens.find((x: { symbol: string }) => x.symbol === "USDG");
    expect(t).toMatchObject({ address: USDG, decimals: 6, price_source: "par", price_usd: 1, credit_usd_per_token: 1, price_reason: null, haircut_bps: 0, max_usd_per_deposit: 1000 });
    const status = (await (await h.request("/api/v1/status")).json()).data;
    expect(status.escrow).toEqual({ enabled: true, tokens: ["NVDA", "USDG"], haircut_bps: 300, anyr: null, usdg: { enabled: true, haircut_bps: 0, max_usd_per_deposit: 1000 } });
  });
});

describe("USDG fast credit", () => {
  let h: Harness;
  const env = { FAST_CREDIT_ENABLED: "true", ESCROW_ADDRESS: ESCROW, ESCROW_START_BLOCK: "1", CHAIN_START_BLOCK: "1", CHAIN_CONFIRMATIONS: "1", ESCROW_HAIRCUT_BPS: "0", ESCROW_TOKENS: stocks, ...usdgEnv };
  const send = (n: number, raw: bigint, block: bigint) => {
    const t = { token: USDG, from: wallet(n), value: raw, txHash: fakeTx(), logIndex: 0, blockNumber: block };
    h.chain.escrowLogs.push(t);
    return t;
  };
  const bal = async (n: number) => (await balanceOf(h.ctx.db, escrowAccountId(wallet(n)))).balance;
  const row = async (t: { txHash: Hex }) => (await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash)))[0];
  beforeAll(async () => {
    h = await startRouter({ env });
    realDecimals(h);
    h.chain.feedReading = null; // no feed is needed for USDG on the fast path either
  });
  afterAll(async () => h.close());

  test("credits up to the $25 fast-credit limit after confirmations, the rest at par once final, once", async () => {
    h.chain.escrowHead = 100n;
    h.chain.escrowFinalLag = 50n;
    const t = send(0xabab11, units(40), 95n);
    await pollEscrow(h.ctx);
    expect(await bal(0xabab11)).toBe(0n); // 6 of 10 confirmations
    h.chain.escrowHead = 104n;
    await pollEscrow(h.ctx);
    expect(await bal(0xabab11)).toBe(usd(25));
    expect(await row(t)).toMatchObject({ status: "provisional", credited: usd(25) });
    await pollEscrow(h.ctx);
    expect(await bal(0xabab11)).toBe(usd(25));
    h.chain.escrowFinalLag = 0n;
    await pollEscrow(h.ctx);
    await pollEscrow(h.ctx);
    expect(await bal(0xabab11)).toBe(usd(40));
    expect(await row(t)).toMatchObject({ status: "credited", credited: usd(40), price18: (10n ** 18n).toString(), reviewReason: null });
    const [settled] = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow:${t.txHash}:0`));
    expect(settled).toMatchObject({ kind: "usdg_deposit", amount: usd(15) });
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a provisional USDG credit reorganized away is reversed once with its own kind", async () => {
    h.chain.escrowHead = 200n;
    h.chain.escrowFinalLag = 80n;
    const t = send(0xabab12, units(10), 180n);
    await pollEscrow(h.ctx);
    expect(await bal(0xabab12)).toBe(usd(10));
    h.chain.reorg(180n, (logs) => logs.filter((l) => l.txHash !== t.txHash));
    await pollEscrow(h.ctx);
    await pollEscrow(h.ctx);
    expect(await bal(0xabab12)).toBe(0n);
    const reversals = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow-reversal:${t.txHash}:0`));
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({ kind: "usdg_deposit_reversal", amount: -usd(10) });
    expect(await row(t)).toMatchObject({ status: "reversed" });
  });

  test("the per-deposit limit still applies, with operator review, when the credit starts early", async () => {
    h.ctx.cfg.usdgEscrow!.maxUsdPerDeposit = 30;
    try {
      h.chain.escrowHead = 300n;
      h.chain.escrowFinalLag = 80n;
      const t = send(0xabab13, units(100), 280n);
      await pollEscrow(h.ctx);
      expect(await bal(0xabab13)).toBe(usd(25));
      h.chain.escrowFinalLag = 0n;
      await pollEscrow(h.ctx);
      expect(await bal(0xabab13)).toBe(usd(30));
      const r = await row(t);
      expect(r).toMatchObject({ status: "credited", credited: usd(30), reviewedAt: null });
      expect(r.reviewReason).toContain("per-deposit ceiling");
      expect((await escrowReviewsOpen(h.ctx.db)).map((x) => x.id)).toContain(r.id);
    } finally {
      h.ctx.cfg.usdgEscrow!.maxUsdPerDeposit = 1000;
    }
  });
});

describe("USDG escrow is off unless switched on", () => {
  test("without USDG_ESCROW_ENABLED, USDG transfers to escrow are ignored and nothing lists USDG", async () => {
    const h = await startRouter({ env: escrowEnv });
    try {
      realDecimals(h);
      expect(h.ctx.cfg.usdgEscrow).toBeNull();
      h.chain.escrowHead += 10n;
      h.chain.escrowLogs.push({ token: USDG, from: wallet(0xabab21), value: units(50), txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n });
      expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
      expect(await h.ctx.db.select().from(escrowDeposits)).toHaveLength(0);
      expect(await balanceOf(h.ctx.db, escrowAccountId(wallet(0xabab21)))).toMatchObject({ balance: 0n });
      const info = (await (await h.request("/api/v1/escrow")).json()).data;
      expect(info.tokens.map((t: { symbol: string }) => t.symbol)).toEqual(["NVDA"]);
      const status = (await (await h.request("/api/v1/status")).json()).data;
      expect(status.escrow).toEqual({ enabled: true, tokens: ["NVDA"], haircut_bps: 300, anyr: null, usdg: { enabled: false, haircut_bps: null, max_usd_per_deposit: null } });
    } finally {
      await h.close();
    }
  });

  test("a decimals mismatch for USDG stops the watcher before anything is recorded or credited", async () => {
    const h = await startRouter({ env: { ...escrowEnv, ...usdgEnv } });
    try {
      // The fake token contract reports 18 decimals for every token, so USDG does not match its 6.
      h.chain.escrowLogs.push({ token: USDG, from: wallet(0xabab22), value: units(50), txHash: fakeTx(), logIndex: 0, blockNumber: 5n });
      await expect(pollEscrow(h.ctx)).rejects.toThrow(/USDG has 18 decimals on-chain but 6 in configuration/);
      expect(await h.ctx.db.select().from(escrowDeposits)).toHaveLength(0);
      expect(await balanceOf(h.ctx.db, escrowAccountId(wallet(0xabab22)))).toMatchObject({ balance: 0n });
    } finally {
      await h.close();
    }
  });
});

describe("USDG escrow configuration", () => {
  test("off by default; when on, credited at par with 6 decimals, and refusals for anything that could misprice it", () => {
    expect(loadConfig({}).usdgEscrow).toBeNull();
    expect(loadConfig({ USDG_ESCROW_ENABLED: "false" }).usdgEscrow).toBeNull();
    expect(loadConfig(usdgEnv).usdgEscrow).toEqual({ address: USDG, symbol: "USDG", decimals: 6, haircutBps: 0, maxUsdPerDeposit: 1000 });
    expect(loadConfig({ ...usdgEnv, USDG_ESCROW_HAIRCUT_BPS: "50", USDG_ESCROW_MAX_USD_PER_DEPOSIT: "250" }).usdgEscrow).toMatchObject({ haircutBps: 50, maxUsdPerDeposit: 250 });
    expect(() => loadConfig({ ...usdgEnv, USDG_ESCROW_HAIRCUT_BPS: "10000" })).toThrow(/USDG_ESCROW_HAIRCUT_BPS/);
    expect(() => loadConfig({ ...usdgEnv, USDG_ESCROW_HAIRCUT_BPS: "-1" })).toThrow(/USDG_ESCROW_HAIRCUT_BPS/);
    expect(() => loadConfig({ ...usdgEnv, USDG_ESCROW_MAX_USD_PER_DEPOSIT: "0" })).toThrow(/USDG_ESCROW_MAX_USD_PER_DEPOSIT/);
    expect(() => loadConfig({ USDG_ESCROW_MAX_USD_PER_DEPOSIT: "-5" })).toThrow(/USDG_ESCROW_MAX_USD_PER_DEPOSIT/);
    expect(() => loadConfig({ ...usdgEnv, USDG_ADDRESS: "0x0000000000000000000000000000000000000000" })).toThrow(/requires USDG_ADDRESS/);
    expect(() => loadConfig({ ...usdgEnv, ESCROW_TOKENS: JSON.stringify([{ symbol: "X", address: USDG, decimals: 6, feed: FEED }]) })).toThrow(/also listed in ESCROW_TOKENS/);
    // x402 settlements into the escrow wallet would otherwise be credited a second time as deposits.
    expect(() => loadConfig({ ...usdgEnv, ESCROW_ADDRESS: ESCROW, X402_PAY_TO: ESCROW })).toThrow(/X402_PAY_TO to differ from ESCROW_ADDRESS/);
    expect(loadConfig({ ESCROW_ADDRESS: ESCROW, X402_PAY_TO: ESCROW }).usdgEscrow).toBeNull();
  });
});
