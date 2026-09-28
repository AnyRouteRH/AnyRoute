import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NVDA, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { ChainService } from "../src/chain/service.ts";
import { chainCursor, escrowDeposits, kv, ledger } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { clearEscrowPriceCache, escrowAccountId, pollEscrow } from "../src/pay/escrow.ts";
import { ESCROW_CRITICAL_JOBS } from "../src/services/readiness.ts";

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
    expect(info).toMatchObject({ enabled: true, address: ESCROW, chain_id: 4663, haircut_bps: 300 });
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
      expect(ok.checks).toMatchObject({ chain: true, "escrow-indexer": true });
      expect(ok.checks).not.toHaveProperty("custody_controls");
      expect(ok.checks).not.toHaveProperty("receipt_anchor_configured");
      expect(ok.checks).not.toHaveProperty("settlement");
      const head = h.chain.escrowHead;
      h.chain.escrowHead = head + 1_000n; // ~100 s of Robinhood Chain blocks: normal polling lag
      expect((await (await h.request("/ready")).json()).checks.chain).toBe(true);
      h.chain.escrowHead = head + 10_000n; // watcher far behind the chain
      expect((await (await h.request("/ready")).json()).checks.chain).toBe(false);
      h.chain.escrowHead = head;
      const value = { name: "escrow-indexer", every_ms: 5000, last_error: "rpc down", last_success: new Date().toISOString() };
      await h.ctx.db.update(kv).set({ value }).where(eq(kv.key, "job-health:escrow-indexer"));
      expect((await (await h.request("/ready")).json()).checks["escrow-indexer"]).toBe(false);
    } finally {
      h.ctx.chain.client.getChainId = oldChainId;
    }
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
});

describe("escrow configuration", () => {
  const prod = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379" };
  test("escrow mode runs in production without contracts or a router key, but needs an address, feeds and a start block", () => {
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "123" })).not.toThrow();
    expect(() => loadConfig({ ...prod, ...escrowEnv })).toThrow(/ESCROW_START_BLOCK/);
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_ADDRESS: "" })).toThrow(/requires ESCROW_ADDRESS/);
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_TOKENS: JSON.stringify([{ symbol: "NVDA", address: NVDA, decimals: 18 }]) })).toThrow(/feed/);
    expect(() => loadConfig({ ...prod, ...escrowEnv, ESCROW_START_BLOCK: "1", ESCROW_HAIRCUT_BPS: "10000" })).toThrow(/HAIRCUT/);
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
