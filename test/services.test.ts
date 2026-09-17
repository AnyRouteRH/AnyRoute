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

  test("full settlement run posts a spent root", async () => {
    const r = await runSettlement(h.ctx);
    expect((r.roots as any).posted).toBe(true);
    expect(h.chain.spentRoots.length).toBeGreaterThan(0);
  });
});

describe("canaries -> slash -> refunds", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "ref", name: "Reference TEE", models: [MODELS.llama], tee: "dev" },
        { id: "honest", name: "Honest", models: [MODELS.llama] },
        { id: "cheater", name: "Cheater", models: [{ ...MODELS.llama, quant: "bf16" }], quantNoise: 0.9, wrongAnswers: true },
      ],
    });
    await runAttestor(h.ctx); // the reference provider attests (dev TEE, allowed in tests)
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => h.close());

  test("reference fingerprint from the attested provider; honest matches; cheater mismatches with lower quality", async () => {
    const r = await runCanaries(h.ctx);
    const by = Object.fromEntries(r.results.map((x) => [x.provider, x]));
    expect(by.ref.quantMatch).toBe(true);
    expect(by.honest.quantMatch).toBe(true);
    expect(by.cheater.quantMatch).toBe(false);
    expect(by.cheater.quality!).toBeLessThan(by.honest.quality!);
    expect(h.ctx.health.quality(LLAMA, "cheater")).toBe(0.5);
  });

  test("3/3 mismatches -> proposal (72h window, traffic pulled) -> execute -> callers refunded -> delisted", async () => {
    // Callers served by the cheater before detection.
    const k = await h.fundedKey(2n);
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    for (let i = 0; i < 3; i++) await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, provider: { only: ["cheater"] }, messages: [{ role: "user", content: `victim ${i}` }] } });
    await runCanaries(h.ctx);
    await runCanaries(h.ctx);
    const balBefore = await balanceOf(h.ctx.db, key.accountId);
    const now = Date.now();
    const p = await runSlasher(h.ctx, now);
    const fraud = (p.proposed as any[]).find((x) => x.provider === "cheater" && x.kind === "quant_fraud");
    expect(fraud).toBeDefined();
    expect(BigInt(fraud.amount_usdg)).toBe((20_000n * 10n ** 6n * 2500n) / 10_000n); // 25% of bond
    expect(h.chain.slashProposals.length).toBe(1);
    // Traffic to that model on that provider stops immediately (offer back to shadow).
    const [o] = await h.ctx.db.select().from(offers).where(and(eq(offers.providerId, "cheater"), eq(offers.modelId, LLAMA)));
    expect(o.status).toBe("shadow");
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, provider: { only: ["cheater"] }, messages: [{ role: "user", content: "x" }] } })).status).toBe(404);
    // Not executable before 72h; no duplicate proposal the same day.
    const early = await runSlasher(h.ctx, now + 3_600_000);
    expect(early.executed).toEqual([]);
    expect((early.proposed as any[]).filter((x) => x.provider === "cheater").length).toBe(0);
    // After the dispute window: executed, refunds credited, provider delisted.
    const late = await runSlasher(h.ctx, now + 73 * 3_600_000);
    expect((late.executed as any[]).length).toBe(1);
    const balAfter = await balanceOf(h.ctx.db, key.accountId);
    expect(balAfter.balance).toBeGreaterThan(balBefore.balance);
    const [prov] = await h.ctx.db.select().from(providers).where(eq(providers.id, "cheater"));
    expect(prov.status).toBe("delisted");
    const [s] = await h.ctx.db.select().from(slashes).where(eq(slashes.providerId, "cheater"));
    expect(s.status).toBe("executed");
    expect(s.refunded).toBeGreaterThan(0n);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a disputed slash left unresolved >72h past its window auto-refunds from margin", async () => {
    const [s] = await h.ctx.db.select().from(slashes).limit(1);
    const id = "slash_dispute_test";
    await h.ctx.db.insert(slashes).values({ ...s, id, status: "disputed", refunded: 0n, executableAt: new Date(Date.now() - 80 * 3_600_000), onchainId: null });
    const r = await runSlasher(h.ctx, Date.now());
    expect((r.autoRefunded as any[]).map((x) => x.id)).toContain(id);
  });

  test("empty-200 rate > 2% over 24h -> 1% slash proposal, but only with independent callers", async () => {
    // One caller provoking empties is not evidence.
    for (let i = 0; i < 60; i++) h.ctx.health.record({ modelId: LLAMA, providerId: "honest", ok: i >= 6, empty200: i < 6, errorKind: i < 6 ? "empty200" : null, source: "traffic", caller: "attacker" });
    await h.ctx.health.flush(h.ctx.db);
    expect(((await runSlasher(h.ctx, Date.now())).proposed as any[]).find((x) => x.provider === "honest")).toBeUndefined();
    // Five independent callers seeing empties is.
    for (let i = 0; i < 5; i++) h.ctx.health.record({ modelId: LLAMA, providerId: "honest", ok: false, empty200: true, errorKind: "empty200", source: "traffic", caller: `caller-${i}` });
    await h.ctx.health.flush(h.ctx.db);
    const r = await runSlasher(h.ctx, Date.now());
    const e = (r.proposed as any[]).find((x) => x.provider === "honest" && x.kind === "empty200");
    expect(e).toBeDefined();
    expect(BigInt(e.amount_usdg)).toBe((20_000n * 10n ** 6n * 100n) / 10_000n);
  });
});

describe("attested private route", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "open", name: "Open", models: [MODELS.llama] },
        { id: "tee", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
      ],
    });
  });
  afterAll(async () => h.close());

  test("before attestation the private route has no providers; after, only the attested one; hash in receipt", async () => {
    const k = await h.fundedKey(1n);
    const body = { model: LLAMA, provider: { private: true }, messages: [{ role: "user", content: "secret" }] };
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: body })).status).toBe(404);
    await runAttestor(h.ctx);
    for (let i = 0; i < 5; i++) {
      const j = await (await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: body })).json();
      expect(j.provider).toBe("Enclave");
      expect(j.receipt.payload.attestation).toMatch(/^0x[0-9a-f]{64}$/);
      expect(j.receipt.payload.private).toBe(true);
    }
    const suffix = await (await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { ...body, model: LLAMA + ":private", provider: undefined } })).json();
    expect(suffix.provider).toBe("Enclave");
    // A failed re-attestation removes it from the private route (fail closed).
    await fetch(h.mocks.tee.url + "/_control", { method: "POST", body: JSON.stringify({ tee: null }) });
    await runAttestor(h.ctx);
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: body })).status).toBe(404);
  });

  test("dev attestation is refused when not explicitly allowed", async () => {
    const h2 = await startRouter({ env: { ALLOW_DEV_ATTESTATION: "false" }, providers: [{ id: "tee", name: "Enclave", models: [MODELS.llama], tee: "dev" }] });
    try {
      const r = await runAttestor(h2.ctx);
      expect((r.results[0] as any).ok).toBe(false);
    } finally {
      await h2.close();
    }
  });
});

describe("provider onboarding + admin (tRPC) + LiteLLM import", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen] }, { id: "newbie", name: "Newbie", models: [MODELS.llama], live: false }] });
  });
  afterAll(async () => h.close());

  test("apply -> schema check -> bond -> shadow (canaries) -> live", async () => {
    const [p0] = await h.ctx.db.select().from(providers).where(eq(providers.id, "newbie"));
    expect(p0.status).toBe("applied");
    expect(h.ctx.catalog.offers(LLAMA).find((o) => o.providerId === "newbie")?.status).toBe("shadow");
    // Bond arrives on-chain.
    await recordEvents(h.ctx, [{ contract: "providerBond", event: "Bonded", args: { providerId: providerIdHash("newbie"), operator: "0x0000000000000000000000000000000000000e0e", amount: 10_000_000_000n, total: 10_000_000_000n }, txHash: fakeTx(), logIndex: 0, blockNumber: 80n }]);
    await processEvents(h.ctx);
    await runRegistry(h.ctx);
    const [p1] = await h.ctx.db.select().from(providers).where(eq(providers.id, "newbie"));
    expect(p1.status).toBe("shadow");
    expect(p1.bondUsdg).toBe(10_000_000_000n);
    // Shadow traffic is never routed real requests.
    const k = await h.fundedKey(1n);
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, provider: { only: ["newbie"] }, messages: [{ role: "user", content: "x" }] } })).status).toBe(404);
    // Canaries during shadow, window elapses -> live.
    await runCanaries(h.ctx);
    await h.ctx.db.update(providers).set({ shadowUntil: new Date(Date.now() - 1000) }).where(eq(providers.id, "newbie"));
    await runRegistry(h.ctx);
    const [p2] = await h.ctx.db.select().from(providers).where(eq(providers.id, "newbie"));
    expect(p2.status).toBe("live");
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, provider: { only: ["newbie"] }, messages: [{ role: "user", content: "x" }] } })).status).toBe(200);
  });

  test("REST apply validates the provider spec", async () => {
    const bad = await h.request("/api/v1/providers/apply", { method: "POST", json: { id: "x" } });
    expect(bad.status).toBe(400);
    const ok = await h.request("/api/v1/providers/apply", { method: "POST", json: { id: "fresh", name: "Fresh", base_url: h.mocks.alpha.url, data_policy: { training: false, retains_prompts: false } } });
    expect(ok.status).toBe(201);
    expect((await ok.json()).data.models_found).toBe(2);
  });

  test("tRPC: operator procedures need the admin token; account procedures accept a key", async () => {
    expect((await h.request("/trpc/jobs.status")).status).toBe(401);
    const s = await h.request("/trpc/jobs.status", { headers: { "x-admin-token": ADMIN } });
    expect(s.status).toBe(200);
    const inv = await (await h.request("/trpc/invariants", { headers: { "x-admin-token": ADMIN } })).json();
    expect(inv.result.data.ok).toBe(true);
    const m = await (await h.request(`/trpc/models.get?input=${encodeURIComponent(JSON.stringify({ id: LLAMA }))}`)).json();
    expect(m.result.data.offers.length).toBeGreaterThan(0);
    const k = await h.fundedKey(1n);
    const usage = await h.request(`/trpc/keys.usage?input=${encodeURIComponent(JSON.stringify({}))}`, { headers: k.auth });
    expect(usage.status).toBe(200);
  });
});
