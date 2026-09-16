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
});
