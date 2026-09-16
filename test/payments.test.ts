import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { NVDA, fakeTx, sse, startRouter, type Harness } from "./helpers.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { accounts, keys, paywithDebts, paywithSessions, quotes, spentRoots } from "../src/db/schema.ts";
import { runPaywithAggregator, clearFairCache } from "../src/pay/paywith.ts";
import { postSpentRoot, computeSpentLeaves } from "../src/services/settlement.ts";
import { MerkleTree, spentLeaf } from "../src/receipts/merkle.ts";
import { recordEvents, processEvents } from "../src/chain/indexer.ts";
import { requestHash } from "../src/api/chat.ts";
import { picoToUsdg, usdgToPico } from "../src/lib/money.ts";
import { sha256 } from "../src/lib/util.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";

describe("HTTP 402 per-call payments", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());
  const body = { model: LLAMA, max_tokens: 50, messages: [{ role: "user", content: "pay per call" }] };

  test("unauthenticated -> 402 quote bound to the request; pay -> retry with X-Payment -> served; margin <= 1%", async () => {
    const r = await h.request("/api/v1/chat/completions", { method: "POST", json: body });
    expect(r.status).toBe(402);
    const e = (await r.json()).error;
    expect(e.type).toBe("payment_required");
    expect(e.metadata).toMatchObject({ price_usdg: expect.any(String), pay_to: expect.any(String), nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/), expiry: expect.any(Number), chain: 4663, calldata: expect.stringMatching(/^0x/) });
    const nonce = (await h.ctx.db.select().from(quotes))[0].nonce;
    const [q] = await h.ctx.db.select().from(quotes).where(eq(quotes.nonce, nonce));
    expect(q.requestSha256).toBe(requestHash(body));
    // Pay on-chain (fake chain), then retry the identical request.
    const payer = "0x000000000000000000000000000000000000beef";
    const tx = fakeTx();
    h.chain.payments.set(tx, { nonce: q.nonce as `0x${string}`, payer, amount: q.priceUsdg });
    const paid = await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: body });
    expect(paid.status).toBe(200);
    const j = await paid.json();
    expect(j.receipt.payload.mode).toBe("per_call");
    expect(j.receipt.payload.payment_tx).toBe(tx);
    expect(j.receipt.payload.payer).toBe(payer);
    const upstream = j.usage.cost_details.upstream_inference_cost + j.usage.cost_details.royalty;
    expect(j.usage.cost_details.margin).toBeLessThanOrEqual(upstream * 0.01 + 1e-12);
    expect(j.usage.cost_details.margin).toBeGreaterThan(0);
    // The same payment cannot be reused.
    const again = await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: body });
    expect(again.status).toBe(409);
    // Change stays with the payer, spendable via X-Wallet-Auth.
    const bal = await balanceOf(h.ctx.db, `w_${payer.slice(2)}`);
    expect(bal.balance).toBe(usdgToPico(q.priceUsdg) - usdgToPico(0n) - BigInt(Math.round(j.usage.cost * 1e12)));
  });

  test("a payment quoted for a different body is rejected but kept as change", async () => {
    await h.request("/api/v1/chat/completions", { method: "POST", json: body });
    const [q] = await h.ctx.db.select().from(quotes).where(eq(quotes.status, "open")).limit(1);
    const tx = fakeTx();
    h.chain.payments.set(tx, { nonce: q.nonce as `0x${string}`, payer: "0x000000000000000000000000000000000000cafe", amount: q.priceUsdg });
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: { ...body, messages: [{ role: "user", content: "different" }] } });
    expect(r.status).toBe(409);
    expect((await balanceOf(h.ctx.db, "w_000000000000000000000000000000000000cafe")).balance).toBe(usdgToPico(q.priceUsdg));
  });

  test("underpayment and pending payments", async () => {
    await h.request("/api/v1/chat/completions", { method: "POST", json: body });
    const [q] = await h.ctx.db.select().from(quotes).where(eq(quotes.status, "open")).limit(1);
    const tx = fakeTx();
    h.chain.payments.set(tx, { nonce: q.nonce as `0x${string}`, payer: "0x0000000000000000000000000000000000000d0d", amount: q.priceUsdg - 1n });
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: body })).status).toBe(402);
    const pend = fakeTx();
    h.chain.payments.set(pend, { nonce: q.nonce as `0x${string}`, payer: "0x0000000000000000000000000000000000000d0d", amount: q.priceUsdg, pending: true });
    const orig = h.chain.readCallPayment.bind(h.chain);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": pend }, json: body });
    expect(r.status).toBe(402);
    expect((await r.json()).error.type).toBe("payment_pending");
    void orig;
  }, 20_000);

  test("wallet change is spendable with X-Wallet-Auth signatures (replay-protected)", async () => {
    const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    // Give the wallet change through a redeemed payment.
    await h.request("/api/v1/chat/completions", { method: "POST", json: body });
    const [q] = await h.ctx.db.select().from(quotes).where(eq(quotes.status, "open")).limit(1);
    const tx = fakeTx();
    h.chain.payments.set(tx, { nonce: q.nonce as `0x${string}`, payer: wallet.address.toLowerCase() as `0x${string}`, amount: 1_000_000n });
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: body })).status).toBe(200);
    const ts = Math.floor(Date.now() / 1000);
    const sig = await wallet.signMessage({ message: `anyroute:${ts}:${requestHash(body)}` });
    const auth = { "x-wallet-auth": `${wallet.address}:${ts}:${sig}` };
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: body });
    expect(r.status).toBe(200);
    expect((await r.json()).receipt.payload.payer).toBe(wallet.address.toLowerCase());
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: body })).status).toBe(401); // replay
    // Wallet sign-in turns the change into a normal key.
    const t2 = Math.floor(Date.now() / 1000);
    const k = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, timestamp: t2, signature: await wallet.signMessage({ message: `anyroute:wallet-key:${t2}` }) } })).json();
    const credits = await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${k.key}` } })).json();
    expect(credits.data.available).toBeGreaterThan(0);
  });
});

describe("Pay with Stock Tokens (X-Pay-With)", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  async function sessionKey(capRaw = 10n ** 18n) {
    const k = await h.newKey(); // empty prepaid balance: every call must be paid with NVDA
    const wallet = "0x0000000000000000000000000000000000001111";
    await h.request("/api/v1/paywith/open", { method: "POST", headers: k.auth, json: { token: "NVDA", cap_raw_per_day: capRaw.toString(), wallet } });
    h.chain.sessions.set(k.chainKeyHash, { wallet, token: NVDA, capRawPerDay: capRaw, spentRawToday: 0n, dayStart: BigInt(Math.floor(Date.now() / 86_400_000) * 86_400), active: true });
    await recordEvents(h.ctx, [{ contract: "payWithStock", event: "SessionOpened", args: { keyHash: k.chainKeyHash, wallet, token: NVDA, capRawPerDay: capRaw }, txHash: fakeTx(), logIndex: 0, blockNumber: 60n }]);
    await processEvents(h.ctx);
    return k;
  }

  test("calls accrue a debt priced at fair value; receipt shows the share fraction; aggregator swaps at >= $1; allocations sum to the swap", async () => {
    clearFairCache();
    const k = await sessionKey();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "hello nvda " + i }] } });
      expect(r.status).toBe(200);
      const j = await r.json();
      ids.push(j.id);
      expect(j.receipt.payload.mode).toBe("paywith");
      expect(j.receipt.paid_with).toMatchObject({ token: "NVDA", raw_units: expect.any(String), fair_price: (225n * 10n ** 18n).toString(), status: "accrued" });
    }
    const debts = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.length).toBe(3);
    // Below the $1 threshold nothing settles yet...
    expect((await runPaywithAggregator(h.ctx)).settled).toEqual([]);
    // ...unless the oldest debt is older than 24h.
    await h.ctx.db.execute(sql`UPDATE paywith_debts SET created_at = now() - interval '25 hours'`);
    const res = await runPaywithAggregator(h.ctx);
    expect((res.settled as any[]).length).toBe(1);
    const call = h.chain.payCalls.at(-1)!;
    const owedPico = debts.reduce((a, d) => a + d.amount, 0n);
    expect(call.usdg).toBe(picoToUsdg(owedPico, "ceil"));
    const after = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    const allocated = after.reduce((a, d) => a + (d.rawAllocated ?? 0n), 0n);
    const expectedRaw = (call.usdg * 10n ** 36n) / (225n * 10n ** 18n * 10n ** 6n) + 1000n;
    expect(allocated).toBe(expectedRaw);
    // The swap credited the key: balance back to >= 0 (it pays whole USDG units, rounding up).
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    expect((await balanceOf(h.ctx.db, key.accountId)).balance >= 0n).toBe(true);
    // /generation now shows the settled swap.
    const g = await (await h.request(`/api/v1/generation?id=${ids[0]}`, { headers: k.auth })).json();
    expect(g.data.paid_with.status).toBe("settled");
    expect(g.data.paid_with.swap_tx).toMatch(/^0x/);
    // Monthly statement.
    const st = await (await h.request(`/api/v1/paywith/statement?month=${new Date().toISOString().slice(0, 7)}`, { headers: k.auth })).json();
    expect(st.data.totals[0].line).toContain("NVDA spent on inference");
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("oracle stale -> falls back to prepaid USDG, else 402", async () => {
    clearFairCache();
    const k = await sessionKey();
    h.chain.fair18 = null;
    const body = { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "stale" }] };
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: body });
    expect(r.status).toBe(402);
    expect((await r.json()).error.metadata.pay_with).toContain("stale");
    await h.chain.deposit(h.ctx, k.chainKeyHash, 1_000_000n);
    const ok = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: body });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.receipt.payload.mode).toBe("prepaid");
    expect(j.pay_with_fallback).toContain("stale");
    h.chain.fair18 = 225n * 10n ** 18n;
    clearFairCache();
  });

  test("daily cap bounds the credit line", async () => {
    clearFairCache();
    const tiny = 10n ** 9n; // 1e-9 NVDA ≈ $2.25e-7 per day
    const k = await sessionKey(tiny);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 2000, messages: [{ role: "user", content: "big" }] } });
    expect(r.status).toBe(402);
  });

  test("failed swaps leave the debt open (and the key blocked beyond its line)", async () => {
    clearFairCache();
    const k = await sessionKey();
    await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "x" }] } });
    await h.ctx.db.execute(sql`UPDATE paywith_debts SET created_at = now() - interval '25 hours' WHERE swap_id IS NULL`);
    h.chain.failPayCall = true;
    const res = await runPaywithAggregator(h.ctx);
    expect((res.settled as any[]).some((s) => s.error)).toBe(true);
    const open = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(open.every((d) => d.swapId === null)).toBe(true);
    h.chain.failPayCall = false;
  });
});

describe("self-custodial withdrawals: spent roots", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("every funded key has a leaf; usage is attributed FIFO; proofs verify; totals never decrease", async () => {
    const a = await h.fundedKey(2n);
    const unclaimed = "0x" + "77".repeat(32);
    await h.chain.deposit(h.ctx, unclaimed, 5_000_000n); // deposit to a key nobody registered yet
    await h.request("/api/v1/chat/completions", { method: "POST", headers: a.auth, json: { model: LLAMA, messages: [{ role: "user", content: "spend" }] } });
    const { leaves } = await computeSpentLeaves(h.ctx);
    expect(leaves.map(([k]) => k)).toContain(a.chainKeyHash);
    expect(leaves.find(([k]) => k === unclaimed)![1]).toBe(0n);
    const spentA = leaves.find(([k]) => k === a.chainKeyHash)![1];
    expect(spentA).toBeGreaterThan(0n);
    const r1 = await postSpentRoot(h.ctx);
    expect(r1.posted).toBe(true);
    expect(h.chain.spentRoots.at(-1)!.root).toBe(r1.root as `0x${string}`);
    // The proof endpoint yields the inputs to Credits.finalizeWithdrawal.
    const p = await (await h.request("/api/v1/credits/withdrawal-proof", { headers: a.auth })).json();
    expect(BigInt(p.data.cumulative_spent_usdg)).toBe(spentA);
    expect(MerkleTree.verify(spentLeaf(a.chainKeyHash as `0x${string}`, spentA), p.data.proof, p.data.root)).toBe(true);
    // An off-chain refund must not make on-chain funds withdrawable twice (ratchet keeps U_on).
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, a.hash));
    const { post } = await import("../src/ledger/ledger.ts");
    await post(h.ctx.db, { accountId: key.accountId, amount: usdgToPico(1_000_000n), kind: "refund", ref: "test-refund" });
    await h.request("/api/v1/chat/completions", { method: "POST", headers: a.auth, json: { model: LLAMA, messages: [{ role: "user", content: "more" }] } });
    const r2 = await postSpentRoot(h.ctx);
    const [latest] = await h.ctx.db.select().from(spentRoots).where(eq(spentRoots.epoch, (r2 as any).epoch ?? r1.epoch));
    expect(latest.totalSpentUsdg >= BigInt(r1.total_spent_usdg!)).toBe(true);
    const spentA2 = (latest.leaves as [string, string][]).find(([k]) => k === a.chainKeyHash)![1];
    expect(BigInt(spentA2)).toBeGreaterThanOrEqual(spentA);
  });

  test("roots are dated by the chain's clock; a failed post is retried, and proofs only use landed roots", async () => {
    const a = await h.fundedKey(2n);
    await h.request("/api/v1/chat/completions", { method: "POST", headers: a.auth, json: { model: LLAMA, messages: [{ role: "user", content: "lagging chain" }] } });
    await Bun.sleep(1100); // past the previous root's second
    h.chain.clockOffsetSec = 0;
    h.chain.failNextSpentRoot = true;
    const failed = await postSpentRoot(h.ctx);
    expect(failed.tx).toBeNull();
    const [pending] = await h.ctx.db.select().from(spentRoots).where(eq(spentRoots.epoch, failed.epoch!));
    expect(pending.status).toBe("pending");
    const proofBefore = await (await h.request("/api/v1/credits/withdrawal-proof", { headers: a.auth })).json();
    expect(proofBefore.data?.root ?? null).not.toBe(failed.root); // never a proof against a root that did not land
    // Next run: the chain's clock now trails wall time (like a restored local node), sitting just one
    // second after the last landed root. The failed epoch is rebuilt and dated by the chain, not the server.
    await Bun.sleep(2100);
    const landedBefore = h.chain.spentRoots.at(-1)!.asOf;
    h.chain.clockOffsetSec = landedBefore + 1 - Math.floor(Date.now() / 1000);
    expect(h.chain.clockOffsetSec).toBeLessThan(0);
    const retried = await postSpentRoot(h.ctx);
    expect(retried.posted).toBe(true);
    expect(retried.epoch).toBe(failed.epoch);
    expect(retried.tx).not.toBeNull();
    expect(h.chain.spentRoots.at(-1)!.asOf).toBe(landedBefore + 1);
    const proof = await (await h.request("/api/v1/credits/withdrawal-proof", { headers: a.auth })).json();
    expect(proof.data.root).toBe(h.chain.spentRoots.at(-1)!.root);
    h.chain.clockOffsetSec = 0;
  });
});
