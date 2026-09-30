import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { attestations, offers, providerDisclosure, providers } from "../src/db/schema.ts";
import { saveHostDisclosure } from "../src/network/admission-state.ts";
import { hostRoutingWeight } from "../src/network/dashboard.ts";
import { networkSelectionInput, refreshNetworkRouting } from "../src/network/routing.ts";
import { MAINSTREAM } from "../src/router/lane.ts";
import type { SelectInput } from "../src/router/select.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

describe("network dashboard admission and selector multiplier", () => {
  let h: Harness;
  const id = "network-dashboard";
  const path = `/api/v1/network/hosts/${id}/status`;
  const getHost = async () => (await (await h.request(`/api/v1/hosts/${id}`)).json()).data;
  const getStatus = async () => (await (await h.request(path)).json());
  beforeAll(async () => {
    h = await startRouter({ env: { HOST_DASHBOARD_ENABLED: "true", NETWORK_HOSTS_ENABLED: "true", NETWORK_POLICY_ENABLED: "true", TLOG_ENABLED: "true" }, providers: [{ id, name: "Network dashboard host", models: [MODELS.qwen] }] });
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.ctx.db.delete(attestations).where(eq(attestations.providerId, id));
    await h.ctx.db.update(providers).set({ networkHost: true, status: "probation", networkReasons: [], teeKind: "tdx", attested: true, attestationHash: "ab".repeat(32), attestedAt: new Date(), shadowUntil: new Date(Date.now() + 86_400_000) }).where(eq(providers.id, id));
    await h.ctx.db.update(offers).set({ status: "shadow" }).where(eq(offers.providerId, id));
    await h.ctx.db.insert(attestations).values({ providerId: id, ok: true, teeKind: "tdx" });
    await saveHostDisclosure(h.ctx, id, 12);
  });
  test("fresh admitted host reports the recorded version and matches the selector's probation weight", async () => {
    expect((await getHost()).admission).toMatchObject({ status: "approved", policy_version: 12, reasons: [], checked_at: expect.any(String) });
    expect((await (await h.request("/api/v1/hosts")).json()).data[0].admission.status).toBe("approved");
    expect((await getStatus()).weight).toBe(0.1);
    await h.ctx.catalog.refresh();
    await refreshNetworkRouting(h.ctx.health, h.ctx.db);
    const input: SelectInput = { modelId: MODELS.qwen.slug, offers: h.ctx.catalog.offersByModel.get(MODELS.qwen.slug)!, prefs: {}, modifiers: new Set(), requestParams: [], estimatedTokens: 1, health: h.ctx.health, production: true, attestationMaxAgeMs: h.ctx.cfg.attestation.intervalMs * 3, modelLane: MAINSTREAM };
    expect(networkSelectionInput(input).health.quality(MODELS.qwen.slug, id) / h.ctx.health.quality(MODELS.qwen.slug, id)).toBe((await getStatus()).weight);
  });
  test("stale provider evidence is not approval and has zero weight", async () => {
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 4) }).where(eq(providers.id, id));
    expect((await getHost()).admission.status).toBe("not_approved");
    expect(await getStatus()).toMatchObject({ attested: false, weight: 0 });
  });
  test("a stale latest attempt cannot establish approval", async () => {
    await h.ctx.db.delete(attestations).where(eq(attestations.providerId, id));
    await h.ctx.db.insert(attestations).values({ providerId: id, ok: true, teeKind: "tdx", ts: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 4) });
    expect((await getHost()).admission.status).toBe("not_approved");
  });
  test("latest failed attestation removes approval and selector weight even if the provider row is still fresh", async () => {
    await h.ctx.db.delete(attestations).where(eq(attestations.providerId, id));
    await h.ctx.db.insert(attestations).values({ providerId: id, ok: false, teeKind: "tdx" });
    expect((await getHost()).admission.status).toBe("not_approved");
    expect(await getStatus()).toMatchObject({ attested: false, weight: 0 });
  });
  test("policy refusal cannot retain approval or weight", async () => {
    await h.ctx.db.update(providers).set({ networkReasons: ["Source hash is off-policy."] }).where(eq(providers.id, id));
    expect((await getHost()).admission).toMatchObject({ status: "not_approved", reasons: ["Source hash is off-policy."] });
    expect((await getStatus()).weight).toBe(0);
    await h.ctx.db.update(providers).set({ status: "rejected" }).where(eq(providers.id, id));
    expect((await getStatus()).weight).toBe(0);
    expect((await h.request(`/api/v1/hosts/${id}`)).status).toBe(404);
  });
  test("curated hosts retain their hardware status with null admission", async () => {
    await h.ctx.db.update(providers).set({ networkHost: false, status: "live" }).where(eq(providers.id, id));
    expect(await getHost()).toMatchObject({ attested: true, admission: null });
  });
  test("missing disclosure cannot invent a policy version or approval", async () => {
    await h.ctx.db.delete(providerDisclosure).where(eq(providerDisclosure.providerId, id));
    expect((await getHost()).admission).toEqual({ status: "not_approved", policy_version: null, checked_at: null, reasons: [] });
  });
  test("hosting off yields zero from the shared reader; disabled routes remain absent", async () => {
    const [p] = await h.ctx.db.select().from(providers).where(eq(providers.id, id));
    h.ctx.cfg.networkHosts.enabled = false;
    try { expect(await hostRoutingWeight(h.ctx, p)).toBe(0); } finally { h.ctx.cfg.networkHosts.enabled = true; }
    const off = await startRouter({ env: { HOST_DASHBOARD_ENABLED: "true" } });
    try { expect((await off.request(path)).status).toBe(404); } finally { await off.close(); }
  });
  test("no eligible offers and model outages have zero weight", async () => {
    await h.ctx.db.update(offers).set({ status: "disabled" }).where(eq(offers.providerId, id));
    expect((await getStatus()).weight).toBe(0);
    await h.ctx.db.update(offers).set({ status: "shadow" }).where(eq(offers.providerId, id));
    const outage = h.ctx.health.outage;
    h.ctx.health.outage = () => true;
    try { expect((await getStatus()).weight).toBe(0); } finally { h.ctx.health.outage = outage; }
  });
});
