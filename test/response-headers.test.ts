import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { kv, measurements, providers } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { policyHashFromReport } from "../src/router/lane.ts";
import { EXPOSED_RESPONSE_HEADERS, generationHeaders, sharedPolicyHash } from "../src/api/common.ts";
import { datacenterRegion } from "../src/api/models.ts";
import type { Candidate } from "../src/catalog/catalog.ts";
import { bindingsFor, sidecarDocument } from "./measurement-fixtures.ts";

// Every chat, completion and embeddings response names its receipt (X-Receipt-Id, and Inference-Id for Hugging Face
// clients), the lane it was served under, and, only when the serving endpoint's fresh attestation bound one, the
// classifier policy hash. GET /api/v1/models carries an attestation object and a datacenter region per model.

const POLICY = "sha256:" + "55".repeat(32);
const CLASSIFIER = { classifier_enabled: true, classifier_digest: "sha256:" + "44".repeat(32), classifier_policy: POLICY };
const ATTESTATION_KEYS = ["best", "exec_profile_id", "manifest_ref", "policy_hash"];

/** The receipt, lane and policy headers of a response. */
const ids = (r: Response) => ({
  generation: r.headers.get("x-generation-id"),
  receipt: r.headers.get("x-receipt-id"),
  inference: r.headers.get("inference-id"),
  lane: r.headers.get("x-anyroute-lane"),
  policy: r.headers.get("x-anyroute-policy-hash"),
});

describe("pure pieces", () => {
  test("generationHeaders names the receipt three ways and sends the policy hash only when there is one", () => {
    expect(generationHeaders("gen-1", "public")).toEqual({ "x-generation-id": "gen-1", "x-receipt-id": "gen-1", "inference-id": "gen-1", "x-anyroute-lane": "public" });
    expect(generationHeaders("gen-1", "attested", null)).not.toHaveProperty("x-anyroute-policy-hash");
    expect(generationHeaders("gen-1", "attested", POLICY)["x-anyroute-policy-hash"]).toBe(POLICY);
    for (const h of ["x-receipt-id", "inference-id", "x-anyroute-lane", "x-anyroute-policy-hash", "x-generation-id"]) expect(EXPOSED_RESPONSE_HEADERS).toContain(h);
  });

  test("a policy hash for several calls is one they all share, never a guess", () => {
    expect(sharedPolicyHash([POLICY, POLICY])).toBe(POLICY);
    expect(sharedPolicyHash([POLICY, null])).toBeNull();
    expect(sharedPolicyHash([POLICY, "sha256:" + "66".repeat(32)])).toBeNull();
    expect(sharedPolicyHash([])).toBeNull();
  });

  test("the policy hash follows the classifier trust rule: committed bindings of a verified quote, or a dev report outside production", () => {
    const hw = { hardwareVerified: true, bindingsCommitted: true, simulated: false, allowDev: false };
    expect(policyHashFromReport({ sidecar_bindings: CLASSIFIER }, hw)).toBe(POLICY);
    expect(policyHashFromReport({ sidecar_bindings: { ...CLASSIFIER, classifier_policy: POLICY.toUpperCase().replace("SHA256", "sha256") } }, hw)).toBe(POLICY);
    // Not committed, not verified, or the classifier not on: nothing.
    expect(policyHashFromReport({ sidecar_bindings: CLASSIFIER }, { ...hw, bindingsCommitted: false })).toBeNull();
    expect(policyHashFromReport({ sidecar_bindings: CLASSIFIER }, { ...hw, hardwareVerified: false })).toBeNull();
    expect(policyHashFromReport({ sidecar_bindings: { ...CLASSIFIER, classifier_enabled: "true" } }, hw)).toBeNull();
    // An unbound claim next to the quote is ignored.
    expect(policyHashFromReport({ sidecar_bindings: {}, classifier: { enabled: true, policy_hash: POLICY } }, hw)).toBeNull();
    // Malformed values are dropped rather than passed on.
    for (const bad of ["55".repeat(32), "sha256:abc", "md5:" + "55".repeat(16), 42, null]) expect(policyHashFromReport({ sidecar_bindings: { ...CLASSIFIER, classifier_policy: bad } }, hw)).toBeNull();
    // A development report: its own classifier section, and only where development attestations are allowed.
    const dev = { hardwareVerified: false, bindingsCommitted: false, simulated: true, allowDev: true };
    expect(policyHashFromReport({ classifier: { enabled: true, policy_hash: POLICY } }, dev)).toBe(POLICY);
    expect(policyHashFromReport({ classifier: { enabled: true, policy_hash: POLICY } }, { ...dev, allowDev: false })).toBeNull();
  });

  test("datacenter_region is the one region every endpoint reports, else null", () => {
    const at = (...dc: string[]) => ({ provider: { datacenter: dc } }) as unknown as Candidate;
    expect(datacenterRegion([at("us-east"), at("us-east")])).toBe("us-east");
    expect(datacenterRegion([at("us-east"), at("eu-west")])).toBeNull();
    expect(datacenterRegion([at("us-east"), at()])).toBeNull(); // one endpoint does not say
    expect(datacenterRegion([at("us-east", "eu-west")])).toBeNull();
    expect(datacenterRegion([])).toBeNull();
  });
});

describe("receipt and lane headers on every response", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const chat = (body: Record<string, unknown> = {}, path = "/api/v1/chat/completions") =>
    h.request(path, { method: "POST", headers: auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 20, ...body } });

  beforeAll(async () => {
    h = await startRouter();
    auth = (await h.fundedKey(5n)).auth;
  });
  afterAll(() => h.close());

  test("JSON: X-Receipt-Id and Inference-Id are the generation id, which is the signed receipt's id", async () => {
    const r = await chat();
    expect(r.status).toBe(200);
    const j = await r.json();
    const got = ids(r);
    expect(got.receipt).toBe(j.id);
    expect(got.receipt).toBe(j.receipt.id);
    expect(got.receipt).toBe(j.receipt.payload.id);
    expect(got.inference).toBe(j.id);
    expect(got.generation).toBe(j.id);
    expect(got.lane).toBe("public");
    expect(got.policy).toBeNull(); // no endpoint here attested a policy
    // The id resolves to the stored receipt.
    const stored = await h.request(`/api/v1/receipts/${got.receipt}`);
    expect(stored.status).toBe(200);
  });

  test("SSE: the headers arrive before the first chunk and match the receipt in the final event", async () => {
    const r = await chat({ stream: true });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    const got = ids(r);
    const { events, done } = await sse(r);
    expect(done).toBe(true);
    const last = events.findLast((e) => e.receipt);
    expect(got.receipt).toBe(last.receipt.id);
    expect(got.inference).toBe(last.receipt.id);
    expect(got.lane).toBe("public");
    expect(got.policy).toBeNull();
  });

  test("the /v1 alias, completions and embeddings carry the same headers", async () => {
    const alias = await chat({}, "/v1/chat/completions");
    expect(alias.status).toBe(200);
    expect(ids(alias).receipt).toBe((await alias.json()).id);
    const comp = await h.request("/api/v1/completions", { method: "POST", headers: auth, json: { model: MODELS.llama.slug, prompt: "hi", max_tokens: 10 } });
    expect(comp.status).toBe(200);
    expect(ids(comp)).toMatchObject({ receipt: (await comp.json()).id, lane: "public" });
    const emb = await h.request("/api/v1/embeddings", { method: "POST", headers: auth, json: { model: MODELS.embed.slug, input: "hello" } });
    expect(emb.status).toBe(200);
    const ej = await emb.json();
    expect(ids(emb)).toMatchObject({ generation: ej.id, receipt: ej.id, inference: ej.id, lane: "public", policy: null });
    expect(ej.receipt.id).toBe(ej.id);
  });

  test("CORS lets a browser read them on /api/* and /v1/*", async () => {
    for (const path of ["/api/v1/chat/completions", "/v1/chat/completions"]) {
      const r = await h.request(path, { method: "POST", headers: { ...auth, origin: "https://harness.example" }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 5 } });
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      const exposed = (r.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(/\s*,\s*/);
      for (const name of ["x-receipt-id", "inference-id", "x-anyroute-lane", "x-anyroute-policy-hash", "x-generation-id"]) expect(exposed).toContain(name);
    }
  });

  test("models: an attestation object per model with only known values, and datacenter_region", async () => {
    const list = (await (await h.request("/api/v1/models")).json()).data as any[];
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      // The existing fields are still there.
      expect(m).toHaveProperty("disclosure.best");
      expect(m).toHaveProperty("attested_available");
      expect(Object.keys(m.attestation).sort()).toEqual(ATTESTATION_KEYS);
      expect(m.attestation.best).toBe(m.disclosure.best);
      expect(m.attestation).toMatchObject({ manifest_ref: null, exec_profile_id: null, policy_hash: null });
      expect(m.datacenter_region).toBeNull(); // no provider declared a datacenter
    }
    // The /v1 alias serves the same shape.
    const alias = (await (await h.request("/v1/models")).json()).data as any[];
    expect(alias[0].attestation).toEqual(list[0].attestation);
    // A region is reported only when every endpoint of the model agrees on one.
    await h.ctx.db.update(providers).set({ datacenter: ["us-east"] }).where(eq(providers.id, "alpha"));
    await h.ctx.db.update(providers).set({ datacenter: ["eu-west"] }).where(eq(providers.id, "beta"));
    await h.ctx.catalog.refresh();
    const byId = new Map(((await (await h.request("/api/v1/models")).json()).data as any[]).map((m) => [m.id, m]));
    expect(byId.get(MODELS.qwen.slug).datacenter_region).toBe("us-east"); // alpha alone
    expect(byId.get(MODELS.llama.slug).datacenter_region).toBeNull(); // alpha and beta differ
  });
});

describe("the policy hash from a verified sidecar attestation", () => {
  const PLAIN = { id: "plain-up", slug: "headers/plain-attested", prompt: "0.0000001", completion: "0.0000004" };
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let dcap: ReturnType<typeof Bun.serve>;
  let auth: Record<string, string>;
  const state = { doc: {} as Parameters<typeof sidecarDocument>[1], verified: true };
  const attest = async () => (await runAttestor(h.ctx)).results[0] as { ok: boolean; reason?: string };
  const refreshed = async () => h.ctx.catalog.refresh();
  const chat = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth, ...headers }, json: { model: PLAIN.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 20, ...body } });
  const model = async () => ((await (await h.request("/api/v1/models")).json()).data as any[]).find((m) => m.id === PLAIN.slug);

  beforeAll(async () => {
    sidecar = Bun.serve({ port: 0, fetch: (req) => Response.json(sidecarDocument(new URL(req.url).searchParams.get("nonce") ?? "", state.doc)) });
    dcap = Bun.serve({ port: 0, fetch: () => Response.json(state.verified ? { verified: true } : { verified: false, tcb_status: "Revoked" }) });
    h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [PLAIN] }], env: { TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify`, MEASUREMENTS_ENABLED: "true" } });
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `http://127.0.0.1:${sidecar.port}/attest` }).where(eq(providers.id, "alpha"));
    const claim = { source: "https://headers.example/terms", as_of: "2025-01-15" };
    const put = await h.request("/api/v1/disclosure/alpha", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
    expect(put.status).toBe(200);
    auth = (await h.fundedKey(5n)).auth;
  });
  afterAll(async () => {
    sidecar.stop(true);
    dcap.stop(true);
    await h.close();
  });

  test("bound in a verified quote: sent on JSON and SSE responses, per endpoint, and in the model's attestation object", async () => {
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER } };
    expect(await attest()).toMatchObject({ ok: true });
    await refreshed();
    const r = await chat();
    expect(r.status).toBe(200);
    expect(ids(r)).toMatchObject({ lane: "public", policy: POLICY, receipt: (await r.json()).id });
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    const s = await chat({ stream: true });
    expect(ids(s).policy).toBe(POLICY); // the only reachable endpoint attested it, so it is known before the first chunk
    expect((await sse(s)).done).toBe(true);
    const m = await model();
    expect(m.attestation).toEqual({ best: "attested", manifest_ref: null, exec_profile_id: null, policy_hash: POLICY });
    const ep = (await (await h.request(`/api/v1/models/${PLAIN.slug}/endpoints`)).json()).data.endpoints[0];
    expect(ep.policy_hash).toBe(POLICY);
  });

  test("lane attested is reported as attested, with the policy hash", async () => {
    const viaBody = await chat({ provider: { lane: "attested" } });
    expect(viaBody.status).toBe(200);
    expect(ids(viaBody)).toMatchObject({ lane: "attested", policy: POLICY });
    expect((await viaBody.json()).receipt.payload.lane).toBe("attested");
    const viaHeader = await chat({ stream: true }, { "x-anyroute-lane": "attested" });
    expect(ids(viaHeader)).toMatchObject({ lane: "attested", policy: POLICY });
    await sse(viaHeader);
  });

  test("manifest_ref appears only once the measurement's log entry and registry transaction were checked", async () => {
    const [row] = await h.ctx.db.select().from(measurements).where(eq(measurements.providerId, "alpha"));
    expect(row).toBeDefined(); // recorded by the attestor from the verified quote
    expect((await model()).attestation.manifest_ref).toBeNull();
    const uuid = "24296fb24b8ad77a" + "ab".repeat(32);
    const tx = "0x" + "12".repeat(32);
    await h.ctx.db.update(measurements).set({ rekorUuid: uuid, rekorInclusionVerified: true }).where(eq(measurements.id, row.id));
    await refreshed();
    expect((await model()).attestation.manifest_ref).toEqual({ rekor_entry: uuid, registry_tx: null });
    await h.ctx.db.update(measurements).set({ txHash: tx, status: "registered" }).where(eq(measurements.id, row.id));
    await refreshed();
    expect((await model()).attestation.manifest_ref).toEqual({ rekor_entry: uuid, registry_tx: tx });
  });

  test("a stale attestation no longer vouches for the hash", async () => {
    const at = (await h.ctx.db.select().from(providers).where(eq(providers.id, "alpha")))[0].attestedAt;
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 5) }).where(eq(providers.id, "alpha"));
    await refreshed();
    const r = await chat();
    expect(r.status).toBe(200);
    expect(ids(r).policy).toBeNull();
    expect((await model()).attestation).toMatchObject({ best: "policy", policy_hash: null, manifest_ref: null });
    await h.ctx.db.update(providers).set({ attestedAt: at }).where(eq(providers.id, "alpha"));
    await refreshed();
    expect(ids(await chat()).policy).toBe(POLICY);
  });

  test("an attestation without the classifier, or a failed one, clears it", async () => {
    state.doc = {};
    expect(await attest()).toMatchObject({ ok: true });
    await refreshed();
    expect(ids(await chat()).policy).toBeNull();
    expect((await model()).attestation.policy_hash).toBeNull();
    // Back on, then a quote the verifier rejects: the stored hash goes with it.
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER } };
    await attest();
    expect((await h.ctx.db.select().from(kv).where(eq(kv.key, "attest-policy:alpha"))).length).toBe(1);
    state.verified = false;
    expect((await attest()).ok).toBe(false);
    expect((await h.ctx.db.select().from(kv).where(eq(kv.key, "attest-policy:alpha"))).length).toBe(0);
    state.verified = true;
  });
});
