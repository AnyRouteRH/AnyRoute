import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { BlockNotFoundError, TransactionReceiptNotFoundError, keccak256, pad, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NVDA, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { ChainService } from "../src/chain/service.ts";
import { chainCursor, escrowDeposits, kv, ledger } from "../src/db/schema.ts";
import { balanceOf, reserve, verifyInvariants } from "../src/ledger/ledger.ts";
import { clearEscrowPriceCache, escrowAccountId, escrowDepositsFor, escrowReviewsOpen, markEscrowReviewed, pollEscrow, reconcileEscrowDeposits } from "../src/pay/escrow.ts";
import { ESCROW_CRITICAL_JOBS, readiness } from "../src/services/readiness.ts";

const ESCROW = "0x00000000000000000000000000000000000e5c20";
const FEED = "0x00000000000000000000000000000000000fee01";
const TSLA = "0x00000000000000000000000000000000000000bb";
const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const tokens = JSON.stringify([
  { symbol: "NVDA", address: NVDA, decimals: 18, feed: FEED },
  { symbol: "TSLA", address: TSLA, decimals: 18, feed: FEED },
]);
const escrowEnv = { PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: ESCROW, ESCROW_TOKENS: tokens, ESCROW_HAIRCUT_BPS: "300" };
const whole = (n: bigint) => n * 10n ** 18n;

describe("stock escrow payments", () => {
  let h: Harness;
  const wallet = privateKeyToAccount(("0x" + "5a".repeat(32)) as Hex);
  const from = wallet.address.toLowerCase() as Hex;
  // Each transfer lands in a new block a few blocks below a head that keeps moving, as on a real chain.
  const send = (token: string, raw: bigint, sender: Hex = from) => {
    h.chain.escrowHead += 10n;
    const t = { token: token as Hex, from: sender, value: raw, txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n };
    h.chain.escrowLogs.push(t);
    return t;
  };

  beforeAll(async () => (h = await startRouter({ env: { ...escrowEnv, ESCROW_START_BLOCK: "1" } })));
  afterAll(async () => h.close());
  beforeEach(() => {
    clearEscrowPriceCache();
    h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
    h.chain.escrowDecimals = 18;
  });

  test("a confirmed transfer credits the sending wallet at the feed price minus the haircut, exactly once", async () => {
    const t = send(NVDA, whole(2n));
    const r = await pollEscrow(h.ctx);
    expect(r).toMatchObject({ recorded: 1, credited: 1, waiting: 0 });
    // 2 NVDA x $180 x 97% = $349.20
    const bal = await balanceOf(h.ctx.db, escrowAccountId(from));
    expect(bal.balance).toBe(349_200_000_000_000n);
    const [row] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash));
    expect(row).toMatchObject({ status: "credited", symbol: "NVDA", fromAddress: from, credited: 349_200_000_000_000n, price18: (180n * 10n ** 18n).toString() });
    // Replaying the same logs (cursor rewound) and re-running credit changes nothing.
    await h.ctx.db.update(chainCursor).set({ block: 0n }).where(eq(chainCursor.id, "escrow"));
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
    expect((await balanceOf(h.ctx.db, escrowAccountId(from))).balance).toBe(349_200_000_000_000n);
    const rows = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow:${t.txHash}:0`));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("stock_deposit");
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("large 18-decimal amounts are stored and priced exactly", async () => {
    send(TSLA, whole(1_000n) + 123n); // above the int64 range in raw units
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 1, credited: 1 });
    const [tsla] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.symbol, "TSLA"));
    expect(tsla.rawAmount).toBe((whole(1_000n) + 123n).toString());
    expect(tsla.credited).toBe(174_600_000_000_000_000n); // 1000 x $180 x 97%
  });

  test("a stale, non-positive or unreadable price leaves the deposit pending until a fresh price arrives", async () => {
    const t = send(NVDA, whole(1n));
    h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) - 400_000 };
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 1, credited: 0, waiting: 1 });
    const [pending] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash));
    expect(pending).toMatchObject({ status: "pending", error: "waiting for a fresh NVDA price" });
    clearEscrowPriceCache();
    h.chain.feedReading = { answer: 0n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 0, waiting: 1 });
    clearEscrowPriceCache();
    h.chain.feedReading = null;
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 0, waiting: 1 });
    clearEscrowPriceCache();
    h.chain.feedReading = { answer: 200n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 1, waiting: 0 });
    const [done] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash));
    expect(done).toMatchObject({ status: "credited", credited: 194_000_000_000_000n, error: null });
  });

  test("a decimals mismatch between configuration and chain stops the watcher before anything is credited", async () => {
    const { ctx, close } = await startRouter({ env: { ...escrowEnv, ESCROW_START_BLOCK: "1" } });
    try {
      (ctx.chain as unknown as { escrowDecimals: number }).escrowDecimals = 6;
      (ctx.chain as unknown as { escrowLogs: unknown[] }).escrowLogs.push({ token: NVDA, from, value: whole(1n), txHash: fakeTx(), logIndex: 0, blockNumber: 5n });
      await expect(pollEscrow(ctx)).rejects.toThrow(/decimals/);
      expect(await ctx.db.select().from(escrowDeposits)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test("the wallet signs in and spends its stock credits; deposit history is per wallet", async () => {
    const challenge = (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: wallet.address } })).json()).data;
    const signIn = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) } })).json();
    const auth = { authorization: `Bearer ${signIn.key}` };
    const before = (await (await h.request("/api/v1/credits", { headers: auth })).json()).data.available;
    expect(before).toBeGreaterThan(500);
    const chat = await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "paid with NVDA" }] } });
    expect(chat.status).toBe(200);
    const after = (await (await h.request("/api/v1/credits", { headers: auth })).json()).data.available;
    expect(after).toBeLessThan(before);
    const history = (await (await h.request("/api/v1/escrow/deposits", { headers: auth })).json()).data;
    expect(history.wallet).toBe(from);
    expect(history.deposits.map((d: { symbol: string }) => d.symbol).sort()).toEqual(["NVDA", "NVDA", "TSLA"]);
    expect(history.deposits.every((d: { status: string }) => d.status === "credited")).toBe(true);
    // A plain API key has no wallet, so it sees a hint instead of someone else's deposits.
    const k = await h.newKey();
    const other = (await (await h.request("/api/v1/escrow/deposits", { headers: k.auth })).json()).data;
    expect(other.deposits).toEqual([]);
    expect(other.hint).toContain("Sign in with that wallet");
    expect((await h.request("/api/v1/escrow/deposits")).status).toBe(401);
  });

  test("public escrow info lists the address, tokens, live price and credit rate", async () => {
    const info = (await (await h.request("/api/v1/escrow")).json()).data;
    expect(info).toMatchObject({ enabled: true, address: ESCROW, chain_id: 4663, haircut_bps: 300, finality: "finalized", confirmations: 2, expected_credit_delay_s: 0 });
    expect(info.tokens[0]).toMatchObject({ symbol: "NVDA", address: NVDA, price_usd: 180, credit_usd_per_token: 174.6 });
  });

  test("readiness in escrow mode follows the escrow watcher, not contract custody", async () => {
    const oldChainId = h.ctx.chain.client.getChainId;
    h.ctx.chain.client.getChainId = async () => h.ctx.cfg.chain.id;
    try {
      for (const name of ESCROW_CRITICAL_JOBS) {
        const value = { name, every_ms: 5000, last_error: null, last_success: new Date().toISOString() };
        await h.ctx.db.insert(kv).values({ key: `job-health:${name}`, value }).onConflictDoUpdate({ target: kv.key, set: { value } });
      }
      await h.ctx.db.update(chainCursor).set({ block: h.chain.escrowHead }).where(eq(chainCursor.id, "escrow"));
      const ok = await (await h.request("/ready")).json();
      expect(ok.checks).toMatchObject({ chain: true, "escrow-indexer": true, escrow_finality: true, escrow_reconciliation: true });
      expect(ok.checks).not.toHaveProperty("custody_controls");
      expect(ok.checks).not.toHaveProperty("receipt_anchor_configured");
      expect(ok.checks).not.toHaveProperty("settlement");
      const head = h.chain.escrowHead;
      h.chain.escrowHead = head + 1_000n; // ~100 s of Robinhood Chain blocks: normal polling lag
      expect((await (await h.request("/ready")).json()).checks.chain).toBe(true);
      h.chain.escrowHead = head + 20_000n; // watcher far behind the finality point
      expect((await (await h.request("/ready")).json()).checks.chain).toBe(false);
      h.chain.escrowHead = head + 40_000n;
      h.chain.escrowFinalLag = 40_000n; // the chain's finality point is over an hour behind its head
      expect((await (await h.request("/ready")).json()).checks).toMatchObject({ chain: true, escrow_finality: false });
      h.chain.escrowFinalLag = 0n;
      h.chain.escrowHead = head;
      const value = { name: "escrow-indexer", every_ms: 5000, last_error: "rpc down", last_success: new Date().toISOString() };
      await h.ctx.db.update(kv).set({ value }).where(eq(kv.key, "job-health:escrow-indexer"));
      expect((await (await h.request("/ready")).json()).checks["escrow-indexer"]).toBe(false);
    } finally {
      h.ctx.chain.client.getChainId = oldChainId;
    }
  });
});

describe("escrow finality and chain reorganizations", () => {
  let h: Harness;
  const account = (n: number) => privateKeyToAccount(("0x" + n.toString(16).padStart(2, "0").repeat(32)) as Hex);
  const addr = (n: number) => account(n).address.toLowerCase() as Hex;
  const send = (sender: Hex, raw = whole(1n), token: string = NVDA) => {
    h.chain.escrowHead += 10n;
    const t = { token: token as Hex, from: sender, value: raw, txHash: fakeTx(), logIndex: 0, blockNumber: h.chain.escrowHead - 3n };
    h.chain.escrowLogs.push(t);
    return t;
  };
  const drop = (t: { txHash: Hex }) => (logs: typeof h.chain.escrowLogs) => logs.filter((l) => l.txHash !== t.txHash);
  const row = async (t: { txHash: Hex; logIndex: number }) => (await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.id, `${t.txHash}:${t.logIndex}`)))[0];
  const refs = (prefix: string, t: { txHash: Hex; logIndex: number }) => h.ctx.db.select().from(ledger).where(eq(ledger.ref, `${prefix}:${t.txHash}:${t.logIndex}`));
  const balance = async (a: Hex) => (await balanceOf(h.ctx.db, escrowAccountId(a))).balance;
  const ONE = 174_600_000_000_000n; // 1 token x $180 x 97%

  beforeAll(async () => (h = await startRouter({ env: { ...escrowEnv, ESCROW_START_BLOCK: "1" } })));
  afterAll(async () => h.close());
  beforeEach(() => {
    clearEscrowPriceCache();
    h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
    h.chain.escrowFinalLag = 0n;
  });

  test("a transfer above the finality point is shown as pending_finality and credited only once final, exactly once", async () => {
    const w = addr(0x11);
    h.chain.escrowFinalLag = 50n;
    const t = send(w, whole(2n));
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 0 });
    expect(await row(t)).toMatchObject({ status: "pending_finality", credited: null });
    expect((await escrowDepositsFor(h.ctx, escrowAccountId(w)))[0]).toMatchObject({ status: "pending_finality", credited_usd: null });
    expect(await balance(w)).toBe(0n);
    h.chain.escrowHead += 40n; // final is now 7 blocks below the transfer
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
    expect(await row(t)).toMatchObject({ status: "pending_finality" });
    h.chain.escrowHead += 20n;
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 1, credited: 1 });
    expect(await row(t)).toMatchObject({ status: "credited", blockHash: h.chain.escrowBlockHash(t.blockNumber), credited: 2n * ONE });
    expect(await balance(w)).toBe(2n * ONE);
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 0, credited: 0 });
    expect(await refs("escrow", t)).toHaveLength(1);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a transfer dropped by a reorganization before finality is orphaned without crediting or alerting", async () => {
    const w = addr(0x12);
    h.chain.escrowFinalLag = 50n;
    const t = send(w);
    await pollEscrow(h.ctx);
    expect(await row(t)).toMatchObject({ status: "pending_finality" });
    h.chain.reorg(t.blockNumber, drop(t));
    h.chain.escrowHead += 60n;
    await pollEscrow(h.ctx);
    expect(await row(t)).toMatchObject({ status: "orphaned", reviewReason: null, credited: null });
    expect(await balance(w)).toBe(0n);
    expect(await refs("escrow", t)).toHaveLength(0);
  });

  test("a final transfer whose receipt is missing, reverted or different is orphaned, flagged for review and never credited", async () => {
    const w = addr(0x13);
    const missing = send(w);
    h.chain.escrowMissingReceipts.add(missing.txHash);
    const reverted = send(w);
    h.chain.escrowReverted.add(reverted.txHash);
    h.chain.feedReading = null; // record first, verify once a price arrives
    await pollEscrow(h.ctx);
    const changed = send(w);
    await pollEscrow(h.ctx);
    expect(await row(changed)).toMatchObject({ status: "pending" });
    h.chain.escrowLogs.find((l) => l.txHash === changed.txHash)!.value = whole(1n) / 2n; // the receipt no longer holds the recorded log
    clearEscrowPriceCache();
    h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 0, orphaned: 3 });
    for (const t of [missing, reverted, changed]) {
      expect(await row(t)).toMatchObject({ status: "orphaned", credited: null, reviewReason: expect.stringContaining("orphaned after finality") });
      expect(await refs("escrow", t)).toHaveLength(0);
    }
    expect(await balance(w)).toBe(0n);
    // Flagged deposits fail readiness (and so alert) until an operator marks them reviewed.
    const getChainId = h.ctx.chain.client.getChainId;
    h.ctx.chain.client.getChainId = async () => h.ctx.cfg.chain.id;
    try {
      expect((await readiness(h.ctx)).checks.escrow_reconciliation).toBe(false);
      for (const open of await escrowReviewsOpen(h.ctx.db)) expect(await markEscrowReviewed(h.ctx.db, open.id)).toBe(true);
      expect((await readiness(h.ctx)).checks.escrow_reconciliation).toBe(true);
    } finally {
      h.ctx.chain.client.getChainId = getChainId;
    }
  });

  test("a block replaced after recording but before crediting orphans the deposit, which is never credited", async () => {
    const w = addr(0x14);
    h.chain.feedReading = null;
    const t = send(w);
    await pollEscrow(h.ctx);
    expect(await row(t)).toMatchObject({ status: "pending", blockHash: h.chain.escrowBlockHash(t.blockNumber) });
    h.chain.reorg(t.blockNumber, drop(t));
    clearEscrowPriceCache();
    h.chain.feedReading = { answer: 180n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) };
    expect(await pollEscrow(h.ctx)).toMatchObject({ credited: 0, orphaned: 1 });
    expect(await row(t)).toMatchObject({ status: "orphaned", reviewReason: expect.stringContaining("reorganization") });
    expect(await balance(w)).toBe(0n);
    expect(await refs("escrow", t)).toHaveLength(0);
  });

  test("a credited transfer that is reorganized away is reversed by exactly one compensating debit", async () => {
    const w = addr(0x15);
    const t = send(w, whole(2n));
    await pollEscrow(h.ctx);
    expect(await balance(w)).toBe(2n * ONE);
    h.chain.reorg(t.blockNumber, drop(t));
    expect(await pollEscrow(h.ctx)).toMatchObject({ reversed: 1 });
    expect(await row(t)).toMatchObject({ status: "reversed", credited: 2n * ONE, reviewReason: expect.stringContaining("credit reversed") });
    expect(await balance(w)).toBe(0n);
    const [rev] = await refs("escrow-reversal", t);
    expect(rev).toMatchObject({ kind: "stock_deposit_reversal", amount: -2n * ONE, accountId: escrowAccountId(w) });
    // Idempotent: more polls and forced re-verification post nothing further.
    await pollEscrow(h.ctx);
    expect(await reconcileEscrowDeposits(h.ctx, { since: 0n })).toMatchObject({ reversed: 0 });
    expect(await refs("escrow-reversal", t)).toHaveLength(1);
    expect(await refs("escrow", t)).toHaveLength(1);
    expect(await balance(w)).toBe(0n);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a reversed credit that was partly spent leaves a negative balance that refuses spending until covered", async () => {
    const wallet = account(0x16);
    const w = wallet.address.toLowerCase() as Hex;
    const t = send(w);
    await pollEscrow(h.ctx);
    const challenge = (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: wallet.address } })).json()).data;
    const signIn = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) } })).json();
    const auth = { authorization: `Bearer ${signIn.key}` };
    const chat = () => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "paid with NVDA" }] } });
    expect((await chat()).status).toBe(200);
    const spent = ONE - (await balance(w));
    expect(spent).toBeGreaterThan(0n);
    h.chain.reorg(t.blockNumber, drop(t));
    expect(await pollEscrow(h.ctx)).toMatchObject({ reversed: 1 });
    const after = await balanceOf(h.ctx.db, escrowAccountId(w));
    expect(after.balance).toBe(-spent);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
    // Frozen: no request can reserve anything while the account is in debt.
    expect((await chat()).status).toBe(402);
    await expect(reserve(h.ctx.db, { id: `frozen-${t.txHash}`, accountId: escrowAccountId(w), amount: 1n })).rejects.toThrow(/Insufficient balance/);
    // A later, genuine deposit pays the shortfall first.
    send(w);
    await pollEscrow(h.ctx);
    expect(await balance(w)).toBe(ONE - spent);
    expect((await chat()).status).toBe(200);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a reorganization inside the already scanned range rewinds the scan, so no transfer is skipped", async () => {
    const w = addr(0x17);
    const a = send(w);
    await pollEscrow(h.ctx);
    for (let i = 0; i < 3; i++) {
      h.chain.escrowHead += 10n;
      await pollEscrow(h.ctx);
    }
    const [cursor] = await h.ctx.db.select().from(chainCursor).where(eq(chainCursor.id, "escrow"));
    // The new branch starts at a's block and keeps a (same transaction and log index, new block hash),
    // and holds a transfer b in a block the scan had already passed.
    const b = { token: TSLA as Hex, from: w, value: whole(1n), txHash: fakeTx(), logIndex: 0, blockNumber: a.blockNumber + 5n };
    expect(b.blockNumber).toBeLessThan(cursor.block);
    h.chain.reorg(a.blockNumber, (logs) => [...logs, b]);
    expect(await pollEscrow(h.ctx)).toMatchObject({ recorded: 1, credited: 1, reversed: 0 });
    expect(await row(b)).toMatchObject({ status: "credited", blockHash: h.chain.escrowBlockHash(b.blockNumber) });
    expect(await row(a)).toMatchObject({ status: "credited", blockHash: h.chain.escrowBlockHash(a.blockNumber) });
    expect(await balance(w)).toBe(2n * ONE);
    expect(await refs("escrow-reversal", a)).toHaveLength(0);
  });

  test("credits recorded before block hashes existed are re-verified: backfilled when canonical, reversed when gone", async () => {
    const w = addr(0x18);
    const keep = send(w);
    const gone = send(w);
    await pollEscrow(h.ctx);
    const ids = [keep, gone].map((t) => `${t.txHash}:${t.logIndex}`);
    await h.ctx.db.update(escrowDeposits).set({ blockHash: null, checkedAt: null }).where(inArray(escrowDeposits.id, ids));
    h.chain.escrowLogs = drop(gone)(h.chain.escrowLogs);
    expect(await reconcileEscrowDeposits(h.ctx)).toMatchObject({ reversed: 1 });
    expect(await row(keep)).toMatchObject({ status: "credited", blockHash: h.chain.escrowBlockHash(keep.blockNumber) });
    expect(await row(gone)).toMatchObject({ status: "reversed" });
    expect(await balance(w)).toBe(ONE);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });
});

describe("escrow transfer filtering on the real chain client", () => {
  test("only allowlisted token contracts, the escrow recipient and positive amounts count", async () => {
    const svc = new ChainService(loadConfig({ ANYROUTE_ENV: "test" }));
    const log = (address: string, to: string, value: bigint) => ({ address, args: { from: "0x0000000000000000000000000000000000000abc", to, value }, transactionHash: fakeTx(), logIndex: 0, blockNumber: 1n });
    let asked: unknown;
    (svc.client as unknown as { getLogs: (a: unknown) => Promise<unknown[]> }).getLogs = async (a) => {
      asked = a;
      return [log(NVDA, ESCROW, 5n), log("0x00000000000000000000000000000000000000ff", ESCROW, 5n), log(NVDA, "0x0000000000000000000000000000000000000001", 5n), log(NVDA, ESCROW, 0n)];
    };
    const got = await svc.escrowTransfers([NVDA], ESCROW, 1n, 2n);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ token: NVDA, value: 5n });
    expect(asked).toMatchObject({ address: [NVDA], args: { to: ESCROW }, fromBlock: 1n, toBlock: 2n });
  });

  test("receipts yield only ERC-20 Transfer logs into escrow; a missing receipt or block is null", async () => {
    const svc = new ChainService(loadConfig({ ANYROUTE_ENV: "test" }));
    const client = svc.client as unknown as { getTransactionReceipt: (a: unknown) => Promise<unknown>; getBlock: (a: unknown) => Promise<unknown> };
    const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
    const word = (a: Hex) => pad(a, { size: 32 });
    const sender = "0x0000000000000000000000000000000000000abc" as Hex;
    const five = pad(toHex(5n), { size: 32 });
    const tx = fakeTx();
    client.getTransactionReceipt = async () => ({
      status: "success",
      blockNumber: 7n,
      blockHash: "0x" + "77".repeat(32),
      logs: [
        { address: NVDA, topics: [TRANSFER, word(sender), word(ESCROW)], data: five, logIndex: 3 },
        { address: NVDA, topics: [TRANSFER, word(sender), word("0x0000000000000000000000000000000000000001")], data: five, logIndex: 4 },
        { address: NVDA, topics: [TRANSFER, word(sender), word(ESCROW), word("0x01")], data: "0x", logIndex: 5 }, // ERC-721
        { address: NVDA, topics: [keccak256(toBytes("Approval(address,address,uint256)")), word(sender), word(ESCROW)], data: five, logIndex: 6 },
      ],
    });
    const r = await svc.escrowReceipt(tx, ESCROW);
    expect(r).toMatchObject({ success: true, blockNumber: 7n });
    expect(r!.transfers.map((t) => ({ ...t, from: t.from.toLowerCase() }))).toEqual([{ token: NVDA, from: sender, value: 5n, logIndex: 3 }]);
    client.getTransactionReceipt = async () => {
      throw new TransactionReceiptNotFoundError({ hash: tx });
    };
    expect(await svc.escrowReceipt(tx, ESCROW)).toBeNull();
    client.getBlock = async () => {
      throw new BlockNotFoundError({ blockNumber: 9n });
    };
    expect(await svc.blockHashAt(9n)).toBeNull();
  });
});

describe("escrow configuration", () => {
  const prod = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379" };
  test("escrow mode runs in production without contracts or a router key, but needs an address, feeds and a start block", () => {
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "123" })).not.toThrow();
    expect(() => loadConfig({ ...prod, ...escrowEnv })).toThrow(/ESCROW_START_BLOCK/);
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_ADDRESS: "" })).toThrow(/requires ESCROW_ADDRESS/);
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18 }]) })).toThrow(/feed/);
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_HAIRCUT_BPS: "10000" })).toThrow(/HAIRCUT/);
    expect(loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1" }).escrow).toMatchObject({ finality: "finalized", reorgHorizonBlocks: 864_000 });
    expect(loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_FINALITY: "safe" }).escrow.finality).toBe("safe");
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_FINALITY: "latest" })).toThrow();
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_REORG_HORIZON_BLOCKS: "0" })).toThrow(/HORIZON/);
    // Contract mode is unchanged: production still requires its contracts.
    expect(() => loadConfig({ ...prod })).toThrow(/CREDITS_ADDRESS is required/);
  });
  test("escrow mode refuses to run beside live contracts", () => {
    expect(() => loadConfig({ ...escrowEnv, CREDITS_ADDRESS: "0x0000000000000000000000000000000000000001" })).toThrow(/must not configure contracts/);
  });
  test("an escrow worker runs the watcher and local receipt batching without any signing key", () => {
    const worker = { ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", RUNTIME_ROLE: "worker", WORKER_JOBS: "health-flush,holds-expire,catalog-refresh,provider-registry,health-probes,attestor,receipts-anchor,receipt-key-rotation,escrow-indexer" };
    expect(() => loadConfig(worker)).not.toThrow();
    expect(() => loadConfig({ ...worker, ANCHORER_PRIVATE_KEY: "0x" + "4".repeat(64) })).toThrow(/must not receive/);
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", SETTLEMENT_PRIVATE_KEY: "0x" + "4".repeat(64), RUNTIME_ROLE: "worker", WORKER_JOBS: "settlement" })).toThrow(/must not receive/);
    // Contract mode keeps requiring the anchoring key for its job.
    expect(() => loadConfig({ ...prod, CREDITS_ADDRESS: "0x0000000000000000000000000000000000000001", CALLPAY_ADDRESS: "0x0000000000000000000000000000000000000001", PROVIDER_BOND_ADDRESS: "0x0000000000000000000000000000000000000001", RECEIPT_ANCHOR_ADDRESS: "0x0000000000000000000000000000000000000001", RUNTIME_ROLE: "worker", WORKER_JOBS: "receipts-anchor" })).toThrow(/anchoring job and signing-key/);
  });
});
