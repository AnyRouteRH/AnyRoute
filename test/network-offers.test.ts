import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { attestations, offers, providerDisclosure, providers } from "../src/db/schema.ts";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { admittedModels, hostOfferSchema } from "../src/network/offers.ts";
import { hostPolicySchema, policyHash, policyJson, type HostPolicy } from "../src/network/policy.ts";
import { publishHostPolicy } from "../src/network/publication.ts";
import { networkSelectionInput, refreshNetworkRouting } from "../src/network/routing.ts";
import { MAINSTREAM } from "../src/router/lane.ts";
import { profileOf, UNDECLARED } from "../src/router/disclosure.ts";
import { selectProviders, type SelectInput } from "../src/router/select.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { fetchProviderModels, runRegistry } from "../src/services/registry.ts";
import { createTlsIdentity, generateTlsKey } from "../sidecar/src/tls.ts";
import { bindingsObject, reportDataHex, type Bindings } from "../sidecar/src/reportdata.ts";
import { bindingsFor, DIGESTS, REGS, tdxQuote } from "./measurement-fixtures.ts";
import { startRouter, type Harness } from "./helpers.ts";

const digest = `sha256:${"44".repeat(32)}`;
const terms = { slug: "qwen/qwen2.5-0.5b-instruct", name: "Qwen 2.5 0.5B Instruct", hugging_face_id: "Qwen/Qwen2.5-0.5B-Instruct", context_length: 32768, max_completion_tokens: 4096, quantization: "fp16", pricing: { prompt: "0.0000001", completion: "0.0000002" } };
const v1: HostPolicy = { version: 1, issued_at: "2026-01-01T00:00:00.000Z", tee_kinds: ["tdx"], sidecar: { image_digests: [DIGESTS.image], source_hashes: [digest] }, engines: [{ name: "engine", image_digest: digest }], models: [{ id: "cpu", model_digest: DIGESTS.model, min_gpu_cc: false }], rules: { require_gpu_cc_for: [], allow_dev: false } };
const expected = [{ id: "cpu", anyroute: { slug: terms.slug }, ...Object.fromEntries(Object.entries(terms).filter(([k]) => k !== "slug")), input_modalities: ["text"], output_modalities: ["text"] }];

test("v1 policy without offers retains its exact canonical bytes and hash", () => {
  const original = canonicalJson(v1);
  expect(policyJson(hostPolicySchema.parse(v1))).toBe(original);
  expect(policyHash(hostPolicySchema.parse(v1))).toBe(sha256(original));
  expect(hostPolicySchema.parse(v1).models[0]).not.toHaveProperty("offer");
});

test("offer schema is strict, bounded and requires positive decimal-string prices", () => {
  expect(hostOfferSchema.parse(terms)).toEqual(terms);
  for (const change of [{ slug: "invalid" }, { name: "x".repeat(161) }, { context_length: 2147483648 }, { max_completion_tokens: 0 }, { quantization: "x".repeat(33) }, { hugging_face_id: "x".repeat(161) }, { extra: true }]) expect(hostOfferSchema.safeParse({ ...terms, ...change }).success).toBe(false);
  for (const prompt of ["0", "0.000", "-1", "1e-7", "NaN", "1".repeat(33), "1000001", 0.1]) expect(hostOfferSchema.safeParse({ ...terms, pricing: { ...terms.pricing, prompt } }).success).toBe(false);
  expect(hostOfferSchema.safeParse({ ...terms, pricing: { ...terms.pricing, extra: "1" } }).success).toBe(false);
  expect(policyHash({ ...v1, models: [{ ...v1.models[0], offer: terms }] })).not.toBe(policyHash(v1));
});

describe("verified admission to registry and probation selection", () => {
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let verifier: ReturnType<typeof Bun.serve>;
  let refused = false;
  let modelsFetches = 0;
  const wallet = privateKeyToAccount(generatePrivateKey());
  async function apply(name: string, models = ["cpu"]) {
    const body = { name, models, endpoint: `https://127.0.0.1:${sidecar.port}`, payout_address: wallet.address };
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await wallet.signMessage({ message: `anyroute:${ts}:${sha256(canonicalJson(body))}` });
    const response = await h.request("/api/v1/network/hosts", { method: "POST", headers: { "X-Wallet-Auth": `${wallet.address}:${ts}:${signature}` }, json: body });
    expect(response.status).toBe(name === "First" ? 201 : 200);
    return response.json();
  }
  beforeAll(async () => {
    const key = generateTlsKey();
    const bindings: Bindings = { tlsPubkey: key.spkiDer.toString("hex"), receiptPubkey: bindingsFor().receipt_pubkey, imageDigest: DIGESTS.image, composeHash: DIGESTS.compose, modelDigest: DIGESTS.model, v2: { v: 2, source_hash: digest, engine: { name: "engine", image_digest: digest }, model: { id: "cpu", digest: DIGESTS.model } } };
    const document = (nonce: string) => {
      const reportData = reportDataHex(bindings, Buffer.from(nonce, "hex"));
      return { v: 1, type: "anyroute.sidecar.attestation", dev: false, bindings: bindingsObject(bindings), evidence: { kind: "dstack", dev: false, format: "tdx-quote-v4", quote: tdxQuote(reportData), report_data: reportData, event_log: null, measurements: { mrtd: REGS.mrtd }, nonce } };
    };
    const boot = document("00".repeat(32));
    const ref = sha256(Buffer.from(boot.evidence.quote, "hex"));
    const tls = createTlsIdentity(key.privateKey, { attestationRef: ref, hostnames: ["localhost"] });
    sidecar = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: tls.keyPem, cert: tls.certPem }, fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) { modelsFetches++; return Response.json({ data: expected }); }
      const nonce = new URL(req.url).searchParams.get("nonce");
      return Response.json({ ...(nonce ? document(nonce) : boot), attestation_ref: ref });
    } });
    verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ verified: !refused }) });
    h = await startRouter({ providers: [], env: { HOST_DASHBOARD_ENABLED: "true", NETWORK_HOSTS_ENABLED: "true", NETWORK_POLICY_ENABLED: "true", TLOG_ENABLED: "true", TDX_VERIFIER_URL: `http://127.0.0.1:${verifier.port}` } });
    await publishHostPolicy(h.ctx, { ...v1, models: [{ ...v1.models[0], offer: terms }] });
  });
  afterAll(async () => { await h?.close(); sidecar?.stop(true); verifier?.stop(true); });

  test("policy offers become shadow offers; fresh attested selection has weight 0.1 and stale/failed evidence blocks it", async () => {
    const result = await apply("First"); expect(result.status).toBe("probation");
    const [p] = await h.ctx.db.select().from(providers).where(eq(providers.id, result.provider_id));
    expect(p.staticModels).toEqual(expected);
    expect(await runRegistry(h.ctx)).toHaveProperty(p.id, { models: 1, errors: [] });
    const [offer] = await h.ctx.db.select().from(offers).where(eq(offers.providerId, p.id));
    expect(offer).toMatchObject({ status: "shadow", modelId: terms.slug, providerModelId: "cpu", pricePrompt: 100000n, priceCompletion: 200000n, ctx: 32768, maxOut: 4096, quant: "fp16" });
    expect(modelsFetches).toBe(0);
    const hosts = await h.request("/api/v1/hosts");
    expect((await hosts.json()).data).toContainEqual(expect.objectContaining({ id: p.id, status: "probation", models: [terms.slug], admission: expect.objectContaining({ status: "approved", policy_version: 1 }) }));
    const record = await h.request(`/api/v1/hosts/${p.id}`); expect(record.status).toBe(200);
    const publicRecord = (await record.json()).data;
    expect(publicRecord.models).toEqual([terms.slug]);
    expect(publicRecord.admission).toMatchObject({ status: "approved", policy_version: 1, reasons: [], checked_at: expect.any(String) });
    expect((await (await h.request(`/api/v1/network/hosts/${p.id}/status`)).json()).weight).toBe(0.1);
    const [disclosure] = await h.ctx.db.select().from(providerDisclosure).where(eq(providerDisclosure.providerId, p.id));
    expect(profileOf(disclosure)).toMatchObject({ declared: true, retention: "attested", jurisdiction: UNDECLARED.jurisdiction, legal_hold: UNDECLARED.legal_hold, training_use: UNDECLARED.training_use,
      claims: { retention: { source: "sidecar attestation checked against host policy v1", as_of: expect.any(String) }, jurisdiction: null, legal_hold: null, training_use: null } });
    expect(Date.now() - Date.parse(profileOf(disclosure).claims.retention!.as_of)).toBeLessThan(5000);
    expect((await (await h.request(`/api/v1/disclosure/${p.id}`)).json()).data.current.class).toBe("attested");
    await h.ctx.catalog.refresh();
    await refreshNetworkRouting(h.ctx.health, h.ctx.db);
    const candidates = h.ctx.catalog.offersByModel.get(terms.slug)!;
    const input: SelectInput = { modelId: terms.slug, offers: candidates, prefs: { lane: "attested" }, modifiers: new Set(), requestParams: [], estimatedTokens: 10, health: h.ctx.health, production: true, attestationMaxAgeMs: h.ctx.cfg.attestation.intervalMs * 3, disclosure: id => profileOf(h.ctx.catalog.disclosure.get(id)), modelLane: MAINSTREAM, rand: () => 0.5 };
    expect(networkSelectionInput(input).health.quality(terms.slug, p.id)).toBe(h.ctx.health.quality(terms.slug, p.id) * 0.1);
    expect(selectProviders(input).ordered.map(c => c.providerId)).toEqual([p.id]);
    const stale = { ...input, offers: candidates.map(c => ({ ...c, provider: { ...c.provider, attestedAt: new Date(Date.now() - input.attestationMaxAgeMs - 1000) } })) };
    expect(selectProviders(stale).ordered).toHaveLength(0);
    expect(selectProviders({ ...stale, prefs: { lane: "public" } }).ordered).toHaveLength(0);
    await h.ctx.db.insert(attestations).values({ providerId: p.id, ok: false, ts: new Date(Date.now() + 1) });
    await new Promise(r => setTimeout(r, 5));
    await refreshNetworkRouting(h.ctx.health, h.ctx.db);
    expect(selectProviders(input).ordered).toHaveLength(0);
    expect(selectProviders({ ...input, prefs: { lane: "public" } }).ordered).toHaveLength(0);
    await h.ctx.db.update(offers).set({ status: "live" }).where(eq(offers.providerId, p.id));
    await runRegistry(h.ctx);
    expect((await h.ctx.db.select().from(offers).where(eq(offers.providerId, p.id)))[0].status).toBe("shadow");
  });

  test("scheduled renewal refreshes probation without promotion; failed renewal excludes both lanes and is public", async () => {
    const [p] = await h.ctx.db.select().from(providers).where(eq(providers.operator, wallet.address.toLowerCase()));
    const staleAt = new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 4);
    await h.ctx.db.update(providers).set({ attestedAt: staleAt }).where(eq(providers.id, p.id));
    expect((await runAttestor(h.ctx)).results).toContainEqual(expect.objectContaining({ provider: p.id, ok: true }));
    const fresh = h.ctx.catalog.providers.get(p.id)!;
    expect(fresh.status).toBe("probation"); expect(fresh.attestedAt!.getTime()).toBeGreaterThan(staleAt.getTime());
    await refreshNetworkRouting(h.ctx.health, h.ctx.db);
    const input: SelectInput = { modelId: terms.slug, offers: h.ctx.catalog.offersByModel.get(terms.slug)!, prefs: { lane: "attested", disclosure: "none" }, modifiers: new Set(), requestParams: [], estimatedTokens: 10, health: h.ctx.health, production: true, attestationMaxAgeMs: h.ctx.cfg.attestation.intervalMs * 3, disclosure: id => profileOf(h.ctx.catalog.disclosure.get(id)), rand: () => 0.5 };
    expect(selectProviders(input).ordered.map(c => c.providerId)).toEqual([p.id]);
    refused = true;
    try { expect((await runAttestor(h.ctx)).results).toContainEqual(expect.objectContaining({ provider: p.id, ok: false })); }
    finally { refused = false; }
    const failed = h.ctx.catalog.providers.get(p.id)!;
    expect(failed).toMatchObject({ status: "probation", attested: false });
    expect(failed.networkReasons!.join(" ")).toContain("Attestation failed");
    await refreshNetworkRouting(h.ctx.health, h.ctx.db);
    const failedInput = { ...input, offers: h.ctx.catalog.offersByModel.get(terms.slug)! };
    expect(selectProviders(failedInput).ordered).toHaveLength(0);
    expect(selectProviders({ ...failedInput, prefs: { lane: "public" } }).ordered).toHaveLength(0);
    const hosts = (await (await h.request("/api/v1/hosts")).json()).data;
    expect(hosts).toContainEqual(expect.objectContaining({ id: p.id, attested: false, status: "probation", attestation: expect.objectContaining({ status: "unverified", reason: "last_attempt_failed" }) }));
    await runAttestor(h.ctx);
    expect(h.ctx.catalog.providers.get(p.id)!.networkReasons).toEqual([]);
  });

  test("scheduled flag off excludes network probation; curated probation stays excluded and shadow/live are unchanged", async () => {
    const [p] = await h.ctx.db.select().from(providers).where(eq(providers.operator, wallet.address.toLowerCase()));
    for (const status of ["probation", "shadow", "live"]) await h.ctx.db.insert(providers).values({ ...p, id: `curated-${status}`, operator: null, networkHost: false, networkModels: [], status });
    const row = { providerId: "curated-live", retention: "policy", jurisdiction: "CH", legalHold: false, trainingUse: "none", claims: {} };
    await h.ctx.db.insert(providerDisclosure).values(row);
    const [before] = await h.ctx.db.select().from(providerDisclosure).where(eq(providerDisclosure.providerId, row.providerId));
    try {
      for (const enabled of [false, true]) {
        h.ctx.cfg.networkHosts.enabled = enabled;
        const result = await runAttestor(h.ctx);
        expect(result.results.map(r => r.provider).sort()).toEqual(["curated-live", "curated-shadow", ...(enabled ? [p.id] : [])].sort());
        expect(result.results.every(r => r.ok)).toBe(true);
      }
      expect((await h.ctx.db.select().from(providerDisclosure).where(eq(providerDisclosure.providerId, row.providerId)))[0]).toEqual(before);
      expect(h.ctx.catalog.providers.get("curated-probation")!.attestedAt).toEqual(p.attestedAt);
      expect(h.ctx.catalog.providers.get("curated-shadow")!.status).toBe("shadow");
      expect(h.ctx.catalog.providers.get("curated-live")!.status).toBe("live");
    } finally {
      h.ctx.cfg.networkHosts.enabled = true;
      for (const status of ["probation", "shadow", "live"]) await h.ctx.db.delete(providers).where(eq(providers.id, `curated-${status}`));
    }
  });

  test("flag off and non-network probation cannot discover or sync; normal live discovery is unchanged", async () => {
    const [p] = await h.ctx.db.select().from(providers).where(eq(providers.operator, wallet.address.toLowerCase()));
    h.ctx.cfg.networkHosts.enabled = false;
    try {
      expect(await runRegistry(h.ctx)).toEqual({});
      await expect(fetchProviderModels(h.ctx, p)).rejects.toThrow("operator approval");
      expect(await fetchProviderModels(h.ctx, { ...p, status: "live" })).toMatchObject({ errors: [] });
    } finally { h.ctx.cfg.networkHosts.enabled = true; }
    await expect(fetchProviderModels(h.ctx, { ...p, networkHost: false })).rejects.toThrow("operator approval");
  });

  test("rejection clears static models and disables retained offers", async () => {
    refused = true;
    const result = await apply("Rejected");
    expect(result.status).toBe("rejected");
    expect(await h.ctx.db.select().from(providerDisclosure).where(eq(providerDisclosure.providerId, result.provider_id))).toHaveLength(0);
    expect((await h.ctx.db.select().from(providers).where(eq(providers.id, result.provider_id)))[0].staticModels).toBeNull();
    expect((await h.ctx.db.select().from(offers).where(eq(offers.providerId, result.provider_id)))[0].status).toBe("disabled");
    refused = false;
  });

  test("requested but unbound models create no offers, even if the policy contains terms", async () => {
    await publishHostPolicy(h.ctx, { ...v1, version: 2, models: [...v1.models, { id: "unbound", model_digest: digest, min_gpu_cc: false, offer: terms }] });
    const result = await apply("Unbound", ["unbound"]);
    expect(result.status).toBe("rejected");
    expect((await h.ctx.db.select().from(providers).where(eq(providers.id, result.provider_id)))[0].staticModels).toBeNull();
    expect(await runRegistry(h.ctx)).toEqual({});
  });

  test("bound model without policy terms admits but never fetches or creates an offer", async () => {
    await publishHostPolicy(h.ctx, { ...v1, version: 3 });
    // Signup rate limit is independent of the wallet-auth replay guard.
    await h.ctx.limiter.close();
    const { MemoryRateLimiter } = await import("../src/lib/ratelimit.ts"); h.ctx.limiter = new MemoryRateLimiter();
    const result = await apply("No terms"); expect(result.status).toBe("probation");
    const [p] = await h.ctx.db.select().from(providers).where(eq(providers.id, result.provider_id));
    expect(p.staticModels).toBeNull();
    expect(await runRegistry(h.ctx)).toHaveProperty(p.id, { models: 0, errors: [] });
    expect(modelsFetches).toBe(0);
    expect((await h.ctx.db.select().from(offers).where(eq(offers.providerId, p.id)))[0].status).toBe("disabled");
    expect(admittedModels({ tee_kind: "tdx", hardware_verified: true, bindings_committed: true, bindings: { model_id: "cpu", model_digest: DIGESTS.model } }, { ...v1, models: [{ ...v1.models[0], offer: terms }] }, [])).toEqual([]);
  });
  test("scheduled policy revocation rejects the host, clears disclosure and disables offers", async () => {
    await publishHostPolicy(h.ctx, { ...v1, version: 4, models: [{ ...v1.models[0], offer: terms }] });
    const result = await apply("Before revocation"); expect(result.status).toBe("probation");
    await runRegistry(h.ctx);
    await publishHostPolicy(h.ctx, { ...v1, version: 5, sidecar: { ...v1.sidecar, image_digests: [digest] } });
    const renewal = await runAttestor(h.ctx);
    expect(renewal.results).toContainEqual(expect.objectContaining({ provider: result.provider_id, ok: false, reason: "The sidecar image digest is missing or off-policy." }));
    const [rejected] = await h.ctx.db.select().from(providers).where(eq(providers.id, result.provider_id));
    expect(rejected).toMatchObject({ status: "rejected", attested: false, staticModels: null, networkReasons: ["The sidecar image digest is missing or off-policy."] });
    expect((await h.ctx.db.select().from(offers).where(eq(offers.providerId, result.provider_id)))[0].status).toBe("disabled");
    expect(await h.ctx.db.select().from(providerDisclosure).where(eq(providerDisclosure.providerId, result.provider_id))).toHaveLength(0);
    expect(h.ctx.catalog.offersByModel.get(terms.slug)).toEqual([expect.objectContaining({ status: "disabled", provider: expect.objectContaining({ status: "rejected", attested: false }) })]);
    expect((await runAttestor(h.ctx)).results).toEqual([]);
  });

});
