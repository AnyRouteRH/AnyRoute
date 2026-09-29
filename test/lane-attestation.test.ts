import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { attestations, providers } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { bindingsFor, sidecarDocument } from "./measurement-fixtures.ts";

// The hardware path: a sidecar attestation whose quote commits to its bindings, verified by a (fake) verifier
// service. The router believes the classifier flag only when the committed bindings carry it.

const PLAIN = { id: "plain-up", slug: "lanetest/plain-attested", prompt: "0.0000001", completion: "0.0000004" };
const CLASSIFIER = { classifier_enabled: true, classifier_digest: "sha256:" + "44".repeat(32), classifier_policy: "sha256:" + "55".repeat(32) };

describe("the classifier flag from a verified sidecar attestation", () => {
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let dcap: ReturnType<typeof Bun.serve>;
  const state = { doc: {} as Parameters<typeof sidecarDocument>[1], extra: {} as Record<string, unknown>, verified: true };

  beforeAll(async () => {
    sidecar = Bun.serve({ port: 0, fetch: (req) => Response.json({ ...sidecarDocument(new URL(req.url).searchParams.get("nonce") ?? "", state.doc), ...state.extra }) });
    dcap = Bun.serve({ port: 0, fetch: () => Response.json(state.verified ? { verified: true } : { verified: false, tcb_status: "Revoked" }) });
    h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [PLAIN] }], env: { TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify` } });
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `http://127.0.0.1:${sidecar.port}/attest` }).where(eq(providers.id, "alpha"));
  });
  afterAll(async () => {
    sidecar.stop(true);
    dcap.stop(true);
    await h.close();
  });
  beforeEach(() => {
    state.doc = {};
    state.extra = {};
    state.verified = true;
  });

  const attest = async () => (await runAttestor(h.ctx)).results[0] as { ok: boolean; reason?: string };
  const row = async () => (await h.ctx.db.select().from(providers).where(eq(providers.id, "alpha")))[0];
  const lastAttestation = async () => (await h.ctx.db.select().from(attestations).where(eq(attestations.providerId, "alpha"))).at(-1)!;

  test("bindings that carry classifier_enabled, committed in the quote, set it", async () => {
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER } };
    expect(await attest()).toMatchObject({ ok: true });
    expect((await row()).classifierEnabled).toBe(true);
    expect((await lastAttestation()).detail).toMatchObject({ verifiers: ["dcap"], simulated: false, classifier_enabled: true });
  });

  test("bindings without it leave it off, and a later attestation without it turns it off again", async () => {
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER } };
    await attest();
    expect((await row()).classifierEnabled).toBe(true);
    state.doc = {};
    expect(await attest()).toMatchObject({ ok: true });
    expect((await row()).classifierEnabled).toBe(false);
    expect((await lastAttestation()).detail).toMatchObject({ classifier_enabled: false });
  });

  test("a classifier claim outside the committed bindings is ignored", async () => {
    state.extra = { classifier: { enabled: true, digest: CLASSIFIER.classifier_digest } };
    expect(await attest()).toMatchObject({ ok: true });
    expect((await row()).classifierEnabled).toBe(false);
  });

  test("classifier_enabled must be exactly true", async () => {
    for (const value of ["true", 1, "yes", { enabled: true }]) {
      state.doc = { bindings: { ...bindingsFor(), classifier_enabled: value } };
      expect(await attest()).toMatchObject({ ok: true });
      expect((await row()).classifierEnabled).toBe(false);
    }
  });

  test("bindings that the quote does not commit to fail the attestation and clear the flag", async () => {
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER } };
    await attest();
    expect((await row()).classifierEnabled).toBe(true);
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER }, tamperReportData: true };
    expect(await attest()).toMatchObject({ ok: false, reason: expect.stringMatching(/not committed/) });
    expect(await row()).toMatchObject({ attested: false, classifierEnabled: false });
  });

  test("a quote the verifier rejects fails the attestation and clears the flag", async () => {
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER } };
    await attest();
    state.verified = false;
    expect((await attest()).ok).toBe(false);
    expect(await row()).toMatchObject({ attested: false, classifierEnabled: false });
  });

  test("with a fresh, verified attestation and a declared profile, the provider serves a restricted model", async () => {
    // (the routing rule itself is covered in lane.test.ts; this closes the loop from a real report)
    state.doc = { bindings: { ...bindingsFor(), ...CLASSIFIER } };
    const put = await h.request("/api/v1/disclosure/alpha", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", source: "https://lane.example/terms", as_of: "2025-01-15" }, legal_hold: { active: false, source: "https://lane.example/terms", as_of: "2025-01-15" } } });
    expect(put.status).toBe(200);
    expect(await attest()).toMatchObject({ ok: true });
    await h.ctx.catalog.refresh();
    const lane = await h.request(`/api/v1/models/${PLAIN.slug}/lane`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { variant: "native_low_refusal", license: "apache-2.0", base_model: "lab/base" } });
    expect(lane.status).toBe(200);
    const keyAuth = (await h.fundedKey(5n)).auth;
    const ok = await h.request("/api/v1/chat/completions", { method: "POST", headers: keyAuth, json: { model: PLAIN.slug, messages: [{ role: "user", content: "hi" }] } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-anyroute-disclosure")).toBe("attested");
    // The same provider without the classifier binding no longer qualifies.
    state.doc = {};
    await attest();
    await h.ctx.catalog.refresh();
    const refused = await h.request("/api/v1/chat/completions", { method: "POST", headers: keyAuth, json: { model: PLAIN.slug, messages: [{ role: "user", content: "hi" }] } });
    expect(refused.status).toBe(404);
  });
});
