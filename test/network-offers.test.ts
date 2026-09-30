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
import { profileOf } from "../src/router/disclosure.ts";
import { selectProviders, type SelectInput } from "../src/router/select.ts";
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
    expect((await hosts.json()).data).toContainEqual(expect.objectContaining({ id: p.id, status: "probation", models: [terms.slug] }));
    const record = await h.request(`/api/v1/hosts/${p.id}`); expect(record.status).toBe(200);
    expect((await record.json()).data.models).toEqual([terms.slug]);
    const disclosure = { providerId: p.id, retention: "attested", jurisdiction: "CH", legalHold: false, trainingUse: "none" };
    await h.ctx.db.insert(providerDisclosure).values(disclosure);
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
});
