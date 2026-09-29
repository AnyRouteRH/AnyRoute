import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { NVDA, fakeTx, paywithKey, sse, startRouter, type Harness } from "./helpers.ts";
import { decodeFunctionData } from "viem";
import { balanceOf, post, verifyInvariants } from "../src/ledger/ledger.ts";
import { accounts, generations, keys, kv, paywithDebts, paywithSessions, quotes, spentRoots } from "../src/db/schema.ts";
import { runPaywithAggregator, clearFairCache } from "../src/pay/paywith.ts";
import { postSpentRoot, computeSpentLeaves, withdrawableFor } from "../src/services/settlement.ts";
import { MerkleTree, SpentTree } from "../src/receipts/merkle.ts";
import { CreditsAbi } from "../src/chain/abis.ts";
import { reconcileSpentRoots } from "../src/services/root-completeness.ts";
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
    const challenge = (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: wallet.address } })).json()).data;
    const k = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) } })).json();
    const credits = await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${k.key}` } })).json();
    expect(credits.data.available).toBeGreaterThan(0);
  });
});

describe("Pay with Stock Tokens (X-Pay-With)", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  // The session wallet signs a bounded allowance, so the aggregator can settle without asking again.
  const sessionKey = (capRaw = 10n ** 18n) => paywithKey(h, { capRaw, allowance: true });

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
    // Charged under the wallet's allowance, bound to the Merkle root of exactly these three receipts.
    expect(call.mode).toBe("allowance");
    const leaves = (await h.ctx.db.select({ leaf: generations.receiptLeaf }).from(generations).where(inArray(generations.id, ids))).map((g) => g.leaf!);
    const [paidDebt] = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.generationId, ids[0]));
    const [charge] = await h.ctx.db.select().from(kv).where(eq(kv.key, `paywith-charge:${paidDebt.swapId}`));
    const record = charge.value as { leaves: `0x${string}`[]; usageCommitment: string };
    expect(record.leaves.slice().sort()).toEqual(leaves.sort());
    expect(call.usageCommitment).toBe(new MerkleTree(record.leaves).root);
    expect(record.usageCommitment).toBe(call.usageCommitment);
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
    clearFairCache(); // signing the allowance priced the token a moment ago
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
    expect(p.data.kind).toBe("inclusion");
    expect(BigInt(p.data.cumulative_spent_usdg)).toBe(spentA);
    const inclusion = { kind: "inclusion", keyHash: a.chainKeyHash as `0x${string}`, cumulativeSpent: spentA, index: p.data.index, leafCount: p.data.leaf_count, proof: p.data.proof } as const;
    expect(SpentTree.verify(p.data.root, inclusion)).toBe(true);
    const call = decodeFunctionData({ abi: CreditsAbi, data: p.data.transactions[0].data });
    expect(call.functionName).toBe("finalizeWithdrawal");
    expect(call.args).toEqual([a.chainKeyHash, spentA, BigInt(p.data.index), BigInt(p.data.leaf_count), p.data.proof]);
    // The stored leaves are the sorted tree the posted root commits to.
    const [stored] = await h.ctx.db.select().from(spentRoots).where(eq(spentRoots.epoch, r1.epoch!));
    const storedLeaves = stored.leaves as [string, string][];
    for (let i = 1; i < storedLeaves.length; i++) expect(BigInt(storedLeaves[i - 1][0]) < BigInt(storedLeaves[i][0])).toBe(true);
    expect(new SpentTree(storedLeaves.map(([k, s]) => [k, BigInt(s)] as const)).root).toBe(stored.root as `0x${string}`);
    // An off-chain refund must not make on-chain funds withdrawable twice (ratchet keeps U_on).
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, a.hash));
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
    // second after the last landed root. The reviewed candidate must be retained, even if it is now ahead of chain time.
    await Bun.sleep(2100);
    const landedBefore = h.chain.spentRoots.at(-1)!.asOf;
    h.chain.clockOffsetSec = landedBefore + 1 - Math.floor(Date.now() / 1000);
    expect(h.chain.clockOffsetSec).toBeLessThan(0);
    const waiting = await postSpentRoot(h.ctx);
    const candidateTime = Math.floor(pending.asOf.getTime() / 1000);
    if (candidateTime > landedBefore + 1) expect(waiting.posted).toBe(false);
    h.chain.clockOffsetSec = 0;
    const retried = waiting.posted ? waiting : await postSpentRoot(h.ctx);
    expect(retried.root).toBe(failed.root);
    expect(retried.posted).toBe(true);
    expect(retried.epoch).toBe(failed.epoch);
    expect(retried.tx).not.toBeNull();
    expect(h.chain.spentRoots.at(-1)!.asOf).toBe(candidateTime);
    const proof = await (await h.request("/api/v1/credits/withdrawal-proof", { headers: a.auth })).json();
    expect(proof.data.root).toBe(h.chain.spentRoots.at(-1)!.root);
    h.chain.clockOffsetSec = 0;
  });

  test("independent approval retains the exact snapshot while more usage arrives", async () => {
    const a = await h.fundedKey(2n);
    await Bun.sleep(1100);
    h.chain.approveSpentRoots = false;
    try {
      const candidate = await postSpentRoot(h.ctx);
      expect(candidate.posted).toBe(false);
      expect(candidate.reason).toBe("awaiting independent approval");
      expect(candidate.approval?.to).toBe(h.chain.address("credits")!);
      const [before] = await h.ctx.db.select().from(spentRoots).where(eq(spentRoots.epoch, candidate.epoch!));
      await h.request("/api/v1/chat/completions", { method: "POST", headers: a.auth, json: { model: LLAMA, messages: [{ role: "user", content: "during review" }] } });
      const waiting = await postSpentRoot(h.ctx);
      const [after] = await h.ctx.db.select().from(spentRoots).where(eq(spentRoots.epoch, candidate.epoch!));
      expect(waiting).toEqual(candidate);
      expect(after.leaves).toEqual(before.leaves);
      expect(after.asOf).toEqual(before.asOf);
      const proof = await (await h.request("/api/v1/credits/withdrawal-proof", { headers: a.auth })).json();
      expect(proof.data?.root).not.toBe(candidate.root);
      h.chain.approveSpentRoots = true;
      const posted = await postSpentRoot(h.ctx);
      expect(posted.posted).toBe(true);
      expect(posted.root).toBe(candidate.root);
      expect(posted.epoch).toBe(candidate.epoch);
    } finally { h.chain.approveSpentRoots = true; }
  });

  test("a key without a leaf gets an absence proof: its adjacent leaves and finalizeWithdrawalAbsent calldata", async () => {
    await h.fundedKey(1n);
    await Bun.sleep(1100);
    const posted = await postSpentRoot(h.ctx);
    expect(posted.posted).toBe(true);
    const fresh = await h.newKey(); // registered, never funded: the root has no leaf for it
    const p = (await (await h.request("/api/v1/credits/withdrawal-proof", { headers: fresh.auth })).json()).data;
    expect(p).toMatchObject({ kind: "absence", root: posted.root, cumulative_spent_usdg: "0", proof: null, index: null });
    const [row] = await h.ctx.db.select().from(spentRoots).where(eq(spentRoots.epoch, posted.epoch!));
    expect(p.leaf_count).toBe((row.leaves as unknown[]).length);
    type Nb = { key_hash: `0x${string}`; cumulative_spent_usdg: string; proof: `0x${string}`[] } | null;
    const nb = (n: Nb) => (n ? { keyHash: n.key_hash, cumulativeSpent: BigInt(n.cumulative_spent_usdg), proof: n.proof } : null);
    expect(SpentTree.verify(p.root, { kind: "absence", keyHash: fresh.chainKeyHash as `0x${string}`, cumulativeSpent: 0n, leafCount: p.leaf_count, gap: p.gap, below: nb(p.below), above: nb(p.above) })).toBe(true);
    expect(p.below || p.above).toBeTruthy();
    if (p.below) expect(BigInt(p.below.key_hash) < BigInt(fresh.chainKeyHash)).toBe(true);
    if (p.above) expect(BigInt(fresh.chainKeyHash) < BigInt(p.above.key_hash)).toBe(true);
    const call = decodeFunctionData({ abi: CreditsAbi, data: p.transactions[0].data });
    expect(call.functionName).toBe("finalizeWithdrawalAbsent");
    expect(call.args.slice(0, 3)).toEqual([fresh.chainKeyHash, BigInt(p.leaf_count), BigInt(p.gap)]);
  });

  test("a leaf never exceeds its key's deposits minus withdrawals; usage beyond them is uncovered, never settled", async () => {
    const k = await h.fundedKey(2n);
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    const before = await computeSpentLeaves(h.ctx);
    // usage the on-chain deposit does not cover (an off-chain credit line)
    await post(h.ctx.db, { accountId: key.accountId, amount: -usdgToPico(5_000_000n), kind: "usage", ref: "test-overuse" });
    const after = await computeSpentLeaves(h.ctx);
    expect(after.leaves.find(([x]) => x === k.chainKeyHash)![1]).toBe(2_000_000n); // not 5 USDG pinned on this key
    expect(after.uncovered.get(key.accountId)).toBe(3_000_000n);
    expect(after.settledTotal - before.settledTotal).toBe(2_000_000n);
    expect(await withdrawableFor(h.ctx, key.accountId, k.chainKeyHash)).toBe(0n);
    await Bun.sleep(1100);
    const r = await postSpentRoot(h.ctx);
    expect(r.posted).toBe(true);
    const [row] = await h.ctx.db.select().from(spentRoots).where(eq(spentRoots.epoch, r.epoch!));
    expect((row.leaves as [string, string][]).find(([x]) => x === k.chainKeyHash)![1]).toBe("2000000");
    const [uncovered] = await h.ctx.db.select().from(kv).where(eq(kv.key, `spent_uncovered:${r.epoch}`));
    expect(BigInt(uncovered.value as string)).toBeGreaterThanOrEqual(3_000_000n);
    const [settled] = await h.ctx.db.select().from(kv).where(eq(kv.key, `spent_settled:${r.epoch}`));
    expect(BigInt(settled.value as string)).toBeLessThanOrEqual(row.totalSpentUsdg);
  });

  test("after an exit with an absence proof, the next root counts that withdrawal: no leaf claims the usage twice", async () => {
    const k = await h.fundedKey(5n);
    await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "spend before the exit" }] } });
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    const used = (await computeSpentLeaves(h.ctx)).leaves.find(([x]) => x === k.chainKeyHash)![1];
    expect(used).toBeGreaterThan(0n);
    // A root left the key out, so Credits paid it all 5 USDG as if it had spent nothing.
    const tx = fakeTx();
    await recordEvents(h.ctx, [
      { contract: "credits", event: "AbsenceProven", args: { keyHash: k.chainKeyHash, epoch: 1n }, txHash: tx, logIndex: 0, blockNumber: 90n },
      { contract: "credits", event: "Withdrawn", args: { keyHash: k.chainKeyHash, to: "0x0000000000000000000000000000000000000abc", amount: 5_000_000n }, txHash: tx, logIndex: 1, blockNumber: 90n },
    ]);
    await processEvents(h.ctx);
    const after = await computeSpentLeaves(h.ctx);
    expect(after.leaves.find(([x]) => x === k.chainKeyHash)![1]).toBe(0n);
    expect(after.uncovered.get(key.accountId)).toBe(used); // the operator's loss
    expect(await withdrawableFor(h.ctx, key.accountId, k.chainKeyHash)).toBe(0n);
    expect((await reconcileSpentRoots(h.ctx.db, { graceMs: 3_600_000 })).totals.absence_exits).toBeGreaterThanOrEqual(1);
    // Funding the key again covers the old usage first; only the rest is withdrawable.
    await h.chain.deposit(h.ctx, k.chainKeyHash, 3_000_000n);
    const refunded = await computeSpentLeaves(h.ctx);
    expect(refunded.leaves.find(([x]) => x === k.chainKeyHash)![1]).toBe(used);
    expect(refunded.uncovered.has(key.accountId)).toBe(false);
    expect(await withdrawableFor(h.ctx, key.accountId, k.chainKeyHash)).toBe(3_000_000n - used);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("withdrawal requests lock the balance off-chain; completion reconciles; cancellation releases", async () => {
    const k = await h.fundedKey(3n);
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    const before = await balanceOf(h.ctx.db, key.accountId);
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: k.chainKeyHash, to: "0x0000000000000000000000000000000000000abc", amount: 2_000_000n, requestedAt: 1n }, txHash: fakeTx(), logIndex: 0, blockNumber: 70n }]);
    await processEvents(h.ctx);
    const locked = await balanceOf(h.ctx.db, key.accountId);
    expect(locked.balance).toBe(before.balance - usdgToPico(2_000_000n));
    await recordEvents(h.ctx, [{ contract: "credits", event: "Withdrawn", args: { keyHash: k.chainKeyHash, to: "0x0000000000000000000000000000000000000abc", amount: 1_500_000n }, txHash: fakeTx(), logIndex: 0, blockNumber: 71n }]);
    await processEvents(h.ctx);
    expect((await balanceOf(h.ctx.db, key.accountId)).balance).toBe(before.balance - usdgToPico(1_500_000n));
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: k.chainKeyHash, to: "0x0000000000000000000000000000000000000abc", amount: 500_000n, requestedAt: 2n }, txHash: fakeTx(), logIndex: 0, blockNumber: 72n }]);
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalCancelled", args: { keyHash: k.chainKeyHash }, txHash: fakeTx(), logIndex: 0, blockNumber: 73n }]);
    await processEvents(h.ctx);
    expect((await balanceOf(h.ctx.db, key.accountId)).balance).toBe(before.balance - usdgToPico(1_500_000n));
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("deposit before registration: the key works on first use (no account step)", async () => {
    const { generateApiKey, deriveKey } = await import("../src/chain/keys.ts");
    const secret = generateApiKey();
    await h.chain.deposit(h.ctx, deriveKey(secret).chainKeyHash, 1_000_000n);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${secret}` }, json: { model: LLAMA, messages: [{ role: "user", content: "first call" }] } });
    expect(r.status).toBe(200);
    const acct = await h.ctx.db.select().from(accounts).where(sql`${accounts.id} LIKE 'k_%'`);
    expect(acct.length).toBeGreaterThan(0);
  });
});

export { sha256, sse, paywithSessions };

describe("indexer robustness", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("thousands of unclaimed deposits never starve newer events", async () => {
    const junk = Array.from({ length: 6000 }, (_, i) => ({ contract: "credits" as const, event: "Deposited", args: { keyHash: "0x" + (i + 1).toString(16).padStart(64, "0"), from: "0x0000000000000000000000000000000000000abc", amount: 1n }, txHash: ("0x" + "e".repeat(56) + i.toString(16).padStart(8, "0")) as `0x${string}`, logIndex: 0, blockNumber: 10n }));
    for (let i = 0; i < junk.length; i += 1000) await recordEvents(h.ctx, junk.slice(i, i + 1000));
    await processEvents(h.ctx); // marks them unclaimed
    const k = await h.fundedKey(3n); // a later deposit to a registered key
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    expect((await balanceOf(h.ctx.db, key.accountId)).balance).toBe(usdgToPico(3_000_000n));
  }, 60_000);
});

describe("402 concurrency", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());
  test("two concurrent redemptions of one payment serve exactly one request", async () => {
    const body = { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "race" }] };
    await h.request("/api/v1/chat/completions", { method: "POST", json: body });
    const [q] = await h.ctx.db.select().from(quotes).where(eq(quotes.status, "open")).limit(1);
    const tx = fakeTx();
    h.chain.payments.set(tx, { nonce: q.nonce as `0x${string}`, payer: "0x000000000000000000000000000000000000f00d", amount: q.priceUsdg });
    const rs = await Promise.all(Array.from({ length: 5 }, () => h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: body })));
    const codes = rs.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200).length).toBe(1);
    expect(codes.filter((c) => c === 409).length).toBe(4);
  });
});
