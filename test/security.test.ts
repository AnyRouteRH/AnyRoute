// Regression tests for the findings of the adversarial review (each reproduced the bug before its fix).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { parseSignature, serializeSignature } from "viem";
import { MODELS, NVDA, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { balanceOf, release, reserve, verifyInvariants } from "../src/ledger/ledger.ts";
import { keys, paywithDebts, providers, quotes } from "../src/db/schema.ts";
import { recordEvents, processEvents } from "../src/chain/indexer.ts";
import { computeSpentLeaves } from "../src/services/settlement.ts";
import { generateApiKey, deriveKey } from "../src/chain/keys.ts";
import { usdgToPico } from "../src/lib/money.ts";
import { worstCase } from "../src/router/pricing.ts";
import { runPaywithAggregator, clearFairCache } from "../src/pay/paywith.ts";
import { requestHash } from "../src/api/chat.ts";
import { sanitizeUpstream } from "../src/providers/upstream.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const TO = "0x0000000000000000000000000000000000000abc";
const accountOf = async (h: Harness, hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0].accountId;

describe("withdrawal accounting", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("H1: withdrawal events for an unregistered key are replayed in order when the key appears", async () => {
    const secret = generateApiKey();
    const d = deriveKey(secret);
    await recordEvents(h.ctx, [{ contract: "credits", event: "Deposited", args: { keyHash: d.chainKeyHash, from: TO, amount: 10_000_000n }, txHash: fakeTx(), logIndex: 0, blockNumber: 50n }]);
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: d.chainKeyHash, to: TO, amount: 10_000_000n, requestedAt: 1n }, txHash: fakeTx(), logIndex: 0, blockNumber: 51n }]);
    await recordEvents(h.ctx, [{ contract: "credits", event: "Withdrawn", args: { keyHash: d.chainKeyHash, to: TO, amount: 10_000_000n }, txHash: fakeTx(), logIndex: 0, blockNumber: 52n }]);
    await processEvents(h.ctx);
    const credits = await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${secret}` } })).json();
    expect(credits.data.available).toBe(0);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${secret}` }, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "free money?" }] } });
    expect(r.status).toBe(402);
  });

  test("H2: an in-flight hold counts as spent in the root, so it can never be withdrawn on-chain", async () => {
    const k = await h.fundedKey(10n);
    const acct = await accountOf(h, k.hash);
    await reserve(h.ctx.db, { id: "inflight-big", accountId: acct, keyHash: k.hash, amount: usdgToPico(10_000_000n) });
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: k.chainKeyHash, to: TO, amount: 10_000_000n, requestedAt: 1n }, txHash: fakeTx(), logIndex: 0, blockNumber: 60n }]);
    await processEvents(h.ctx);
    const { leaves } = await computeSpentLeaves(h.ctx);
    const spent = leaves.find(([x]) => x === k.chainKeyHash)![1];
    expect(spent).toBe(10_000_000n); // deposited 10 - spent 10 - withdrawn 0 = 0 withdrawable on-chain
    // The contract therefore pays 0; releasing the hold leaves a legitimate off-chain balance.
    await recordEvents(h.ctx, [{ contract: "credits", event: "Withdrawn", args: { keyHash: k.chainKeyHash, to: TO, amount: 0n }, txHash: fakeTx(), logIndex: 0, blockNumber: 61n }]);
    await processEvents(h.ctx);
    await release(h.ctx.db, "inflight-big");
    expect((await balanceOf(h.ctx.db, acct)).balance).toBe(usdgToPico(10_000_000n));
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("H3: a sub-key's withdrawal request cannot freeze the shared balance", async () => {
    const root = await h.fundedKey(10n);
    const sub = await (await h.request("/api/v1/keys", { method: "POST", headers: root.auth, json: { name: "contractor" } })).json();
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: sub.data.chain_key_hash, to: TO, amount: 10n ** 15n, requestedAt: 1n }, txHash: fakeTx(), logIndex: 0, blockNumber: 70n }]);
    await processEvents(h.ctx);
    const c = await (await h.request("/api/v1/credits", { headers: root.auth })).json();
    expect(c.data.available).toBe(10);
  });
});

describe("payments", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("L1: every CallPay payment in a bundled transaction is credited to its own payer", async () => {
    const tx = fakeTx();
    const A = "0x00000000000000000000000000000000000000a1";
    const B = "0x00000000000000000000000000000000000000b2";
    await recordEvents(h.ctx, [
      { contract: "callPay", event: "Paid", args: { nonce: "0x" + "11".repeat(32), payer: A, amount: 1_000_000n }, txHash: tx, logIndex: 3, blockNumber: 80n },
      { contract: "callPay", event: "Paid", args: { nonce: "0x" + "22".repeat(32), payer: B, amount: 2_000_000n }, txHash: tx, logIndex: 7, blockNumber: 80n },
    ]);
    await processEvents(h.ctx);
    expect((await balanceOf(h.ctx.db, `w_${A.slice(2)}`)).balance).toBe(usdgToPico(1_000_000n));
    expect((await balanceOf(h.ctx.db, `w_${B.slice(2)}`)).balance).toBe(usdgToPico(2_000_000n));
  });

  test("H4: n / best_of multiply the hold and the 402 quote; n > 16 is refused", async () => {
    const offer = h.ctx.catalog.offers(LLAMA)[0];
    const model = h.ctx.catalog.models.get(LLAMA)!;
    const fees = { royaltyBps: 0, perCallMarginBps: 100, byokFeeBps: 0 };
    const one = worstCase(offer, model, { max_tokens: 100 }, 10, "per_call", fees, false);
    const four = worstCase(offer, model, { max_tokens: 100, n: 4 }, 10, "per_call", fees, false);
    expect(four).toBeGreaterThan(one * 3n);
    expect((await h.request("/api/v1/chat/completions", { method: "POST", json: { model: LLAMA, n: 50, messages: [{ role: "user", content: "x" }] } })).status).toBe(400);
  });

  test("pay-with: a call finishing while a swap is mined stays open for the next swap", async () => {
    clearFairCache();
    const k = await h.newKey();
    const wallet = "0x0000000000000000000000000000000000002222";
    await h.request("/api/v1/paywith/open", { method: "POST", headers: k.auth, json: { token: "NVDA", cap_raw_per_day: (10n ** 18n).toString(), wallet } });
    h.chain.sessions.set(k.chainKeyHash, { wallet, token: NVDA, capRawPerDay: 10n ** 18n, spentRawToday: 0n, dayStart: BigInt(Math.floor(Date.now() / 86_400_000) * 86_400), active: true });
    await recordEvents(h.ctx, [{ contract: "payWithStock", event: "SessionOpened", args: { keyHash: k.chainKeyHash, wallet, token: NVDA, capRawPerDay: 10n ** 18n }, txHash: fakeTx(), logIndex: 0, blockNumber: 60n }]);
    await processEvents(h.ctx);
    const call = () => h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "x" }] } });
    await call();
    await call();
    await h.ctx.db.execute(sql`UPDATE paywith_debts SET created_at = now() - interval '25 hours'`);
    const orig = h.chain.payCall.bind(h.chain);
    h.chain.payCall = (async (...a: Parameters<typeof orig>) => {
      expect((await call()).status).toBe(200); // finishes while the swap is in flight
      return orig(...a);
    }) as typeof orig;
    await runPaywithAggregator(h.ctx);
    h.chain.payCall = orig;
    const debts = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.filter((d) => d.swapId).length).toBe(2);
    expect(debts.filter((d) => !d.swapId).length).toBe(1);
  });
});

describe("abuse and access control", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("C1: anonymous callers cannot run guardrail patterns; key patterns are literal and fast", async () => {
    const t = performance.now();
    const r = await h.request("/api/v1/chat/completions", { method: "POST", json: { model: LLAMA, messages: [{ role: "user", content: "a".repeat(5000) }], guardrails: { deny_patterns: Array(50).fill("(.*a){12}x") } } });
    expect(r.status).toBe(402);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
