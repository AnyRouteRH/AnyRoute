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
});
