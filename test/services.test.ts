import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ADMIN, MODELS, fakeTx, providerIdHash, startRouter, type Harness } from "./helpers.ts";
import { runAnchor, runKeyRotation } from "../src/services/anchor.ts";
import { runSettlement, settleHours } from "../src/services/settlement.ts";
import { runCanaries } from "../src/services/canaries.ts";
import { runSlasher } from "../src/services/slasher.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runRegistry } from "../src/services/registry.ts";
import { recordEvents, processEvents } from "../src/chain/indexer.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { generations, keys, models, offers, providers, royalties, settlements, slashes } from "../src/db/schema.ts";
import { mulBps, picoToUsdg, usdToPico } from "../src/lib/money.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";

describe("receipts: hourly anchors + on-chain keys", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("anchor builds a root over all new receipts; /generation proof verifies against the on-chain root", async () => {
    const k = await h.fundedKey(2n);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await (await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: `r${i}` }] } })).json()).id);
    await runKeyRotation(h.ctx); // publishes the signing key on-chain
    const a = await runAnchor(h.ctx);
    expect(a.anchored).toBe(5);
    expect(h.chain.anchors.at(-1)!.root).toBe(a.root as `0x${string}`);
    for (const id of ids) {
      const g = (await (await h.request(`/api/v1/generation?id=${id}`, { headers: k.auth })).json()).data;
      expect(MerkleTree.verify(g.receipt_leaf, g.anchor.proof, g.anchor.root)).toBe(true);
      const v = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: g.receipt, sig: g.receipt_sig, key_id: g.receipt_key_id, anchor: { root: g.anchor.root, proof: g.anchor.proof, index: g.anchor.index } } })).json();
      expect(v.data).toMatchObject({ signature_valid: true, inclusion_valid: true, key_source: "chain", valid: true });
    }
    // Nothing new -> nothing anchored; next receipts go into the next anchor.
    expect((await runAnchor(h.ctx)).anchored).toBe(0);
    await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "later" }] } });
    expect((await runAnchor(h.ctx)).index).toBe(1);
  });

  test("key rotation keeps old receipts verifiable", async () => {
    const k = await h.fundedKey(1n);
    const before = await (await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "old key" }] } })).json();
    const r = await h.ctx.signer.rotateIfDue(true);
    expect(r.rotated).toBe(true);
    expect(r.key.id).not.toBe(before.receipt.key_id);
    const v = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: before.receipt.payload, sig: before.receipt.sig, key_id: before.receipt.key_id } })).json();
    expect(v.data.signature_valid).toBe(true);
    const jwks = await (await h.request("/api/v1/receipts/keys")).json();
    expect(jwks.keys.length).toBeGreaterThanOrEqual(2);
  });
});

describe("settlement, royalties, rankings", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("royalty line == upstream x bps and is visible in /models; settlement invoices at 2% fee; claimable matches the sum", async () => {
    const creator = "0x000000000000000000000000000000000000c0de";
    await h.ctx.db.update(models).set({ creator, royaltyBps: 500 }).where(eq(models.id, LLAMA));
    await h.ctx.catalog.refresh();
    const m = (await (await h.request("/api/v1/models")).json()).data.find((x: any) => x.id === LLAMA);
    expect(m.creator).toBe(creator);
    expect(m.royalty_bps).toBe(500);
    const k = await h.fundedKey(5n);
    let royaltySum = 0n;
    for (let i = 0; i < 4; i++) {
      const j = await (await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-title": "Demo App", "http-referer": "https://demo.app" }, json: { model: LLAMA, provider: { only: ["alpha"] }, messages: [{ role: "user", content: `royalty ${i}` }] } })).json();
      const up = usdToPico(String(j.receipt.payload.cost_details.upstream));
      const roy = usdToPico(String(j.receipt.payload.cost_details.royalty));
      expect(roy).toBe(mulBps(up, 500));
      royaltySum += roy;
    }
    // Close the hour: move generations into the past, then settle.
    await h.ctx.db.execute(sql`UPDATE generations SET ts = ts - interval '2 hours'`);
    const res = await settleHours(h.ctx);
    expect(res.periods).toBeGreaterThan(0);
    const inv = await h.ctx.db.select().from(settlements).where(eq(settlements.providerId, "alpha"));
    const upstream = inv.reduce((a, r) => a + r.upstream, 0n);
    const fee = inv.reduce((a, r) => a + r.fee, 0n);
    expect(fee).toBe(mulBps(upstream, 200, "floor"));
    expect(inv.reduce((a, r) => a + r.usdgOwed, 0n)).toBe(picoToUsdg(upstream - fee, "floor"));
    const roy = await h.ctx.db.select().from(royalties).where(eq(royalties.modelId, LLAMA));
    expect(roy.reduce((a, r) => a + r.amount, 0n)).toBe(royaltySum);
    const claim = await (await h.request(`/trpc/royalties.claimable?input=${encodeURIComponent(JSON.stringify({ creator }))}`)).json();
    expect(BigInt(claim.result.data.pending_usdg)).toBe(roy.reduce((a, r) => a + r.usdg, 0n));
    // Idempotent: settling again adds nothing.
    await settleHours(h.ctx);
    const inv2 = await h.ctx.db.select().from(settlements).where(eq(settlements.providerId, "alpha"));
    expect(inv2.reduce((a, r) => a + r.upstream, 0n)).toBe(upstream);
    // Rankings: tokens per model, paid to creator, apps.
    await h.ctx.db.execute(sql`UPDATE generations SET ts = now()`);
    const rk = await (await h.request("/api/v1/rankings?period=day")).json();
    const row = rk.data.models.find((x: any) => x.model === LLAMA);
    expect(row.paid_to_creator_usd).toBeGreaterThan(0);
    expect(rk.data.apps[0].app).toBe("Demo App");
  });
});
