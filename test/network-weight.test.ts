import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import type { Db } from "../src/db/client.ts";
import { attestations, generations, health as healthTable, providers } from "../src/db/schema.ts";
import type { Candidate } from "../src/catalog/catalog.ts";
import { configureNetworkRouting, networkProbeEligible, networkProbeOfferEligible, networkSelectionInput, readNetworkEvidence, refreshNetworkRouting } from "../src/network/routing.ts";
import { networkWeight, type NetworkWeightInput } from "../src/network/weight.ts";
import { NETWORK_WEIGHT_POLICY } from "../src/network/weight-config.ts";
import { MAINSTREAM } from "../src/router/lane.ts";
import { OUTAGE_REASON, UNDECLARED, profileOf } from "../src/router/disclosure.ts";
import { selectProviders, selectionWeight, type HealthView, type SelectInput } from "../src/router/select.ts";
import { HealthTracker } from "../src/services/health.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

const settings = loadConfig({ NETWORK_HOSTS_ENABLED: true }).networkWeights;
const base: NetworkWeightInput = { networkHost: true, attested: true, unhealthy: false, probationUntil: 1_000, now: 1_000, attestedSuccesses: 200, recentSuccesses: 200, recentFailures: 0, probeSuccesses: 99, probeFailures: 1 };
const weight = (change: Partial<NetworkWeightInput> = {}) => networkWeight({ ...base, ...change }, settings);

describe("network-only deterministic policy", () => {
  test("full probation time, request threshold and observed probe uptime are all required", () => {
    expect(weight()).toBe(1);
    for (const change of [{ now: 999 }, { attestedSuccesses: 199 }, { probeSuccesses: 98, probeFailures: 2 }, { probeSuccesses: 0, probeFailures: 0 }, { probationUntil: null }]) expect(weight(change)).toBe(0.1);
    expect(networkWeight({ ...base, attestedSuccesses: 299 }, { ...settings, graduateRequests: 300 })).toBe(0.1);
    expect(networkWeight(base, { ...settings, graduateUptime: 1 })).toBe(0.1);
  });
  test("failed or stale attestation and unhealthy providers get zero; re-attestation restores eligibility", () => {
    for (const change of [{ attested: false }, { failedAttestation: true }, { unhealthy: true }, { probeSuccesses: 89, probeFailures: 11 }, { latencyMs: 30_000 }]) expect(weight(change)).toBe(0);
    expect(weight({ failedAttestation: false })).toBe(1);
    expect(weight({ attestedSuccesses: NaN })).toBe(0);
    expect(weight({ recentFailures: -1 })).toBe(0);
    expect(weight({ latencyMs: Infinity })).toBe(0);
  });
  test("error and latency penalties are bounded and bond is neutral", () => {
    expect(weight({ recentSuccesses: 95, recentFailures: 5 })).toBe(1);
    expect(weight({ recentSuccesses: 94, recentFailures: 6 })).toBe(0.25);
    expect(weight({ latencyMs: 2_000 })).toBe(0.5);
    expect(weight({ now: 999, recentSuccesses: 94, recentFailures: 6, latencyMs: 2_000 })).toBe(0.0125);
    expect(weight({ bond: 0n })).toBe(weight({ bond: 1_000_000n }));
  });
  test("off and non-network inputs return neutral even when unhealthy", () => {
    expect(networkWeight({ ...base, unhealthy: true }, { ...settings, enabled: false })).toBe(1);
    for (const flag of [undefined, false, "true", 1]) expect(weight({ networkHost: flag, attested: false, unhealthy: true })).toBe(1);
  });
  test("existing numerical weights have their unchanged baseline snapshot", () => {
    const baseline = { price: 100, minPrice: 100, uptime: 1, quality: 1, attested: false, bonus: 1.25 };
    const cases = [baseline, { ...baseline, attested: true }, { ...baseline, price: 200 }, { ...baseline, uptime: 0.9, quality: 0.5, attested: true }, { ...baseline, price: 1 }];
    expect(cases.map(selectionWeight)).toMatchInlineSnapshot(`
[
  1,
  1.25,
  0.25,
  0.5625,
  99.99999999999999,
]
`);
    for (const c of cases) {
      const previous = selectionWeight(c);
      const actual = selectionWeight({ ...c, quality: c.quality * weight({ networkHost: false }) });
      expect(Buffer.from(new Float64Array([actual]).buffer)).toEqual(Buffer.from(new Float64Array([previous]).buffer));
    }
  });
});

const profile = profileOf({ retention: "attested", jurisdiction: "CH", legalHold: false, legalHoldNote: null, trainingUse: "none", claims: {}, updatedAt: new Date() });
function input(offers: Candidate[], tracker: HealthView, prefs: SelectInput["prefs"] = {}): SelectInput {
  return { modelId: offers[0].modelId, offers, prefs, modifiers: new Set(), requestParams: [], estimatedTokens: 10, health: tracker, production: true, attestationMaxAgeMs: 3_600_000, disclosure: (id) => id === "public" ? UNDECLARED : profile, modelLane: MAINSTREAM, rand: () => 0.5 };
}
const ids = (s: ReturnType<typeof selectProviders>) => s.ordered.map((c) => c.providerId);

describe("persisted evidence and selector integration", () => {
  let h: Harness;
  let candidate: Candidate;
  let curated: Candidate;
  let flaggedDb: Db;
  let tracker: HealthTracker;
  const now = Date.now();
  const deadline = new Date(now - 60_000);
  beforeAll(async () => {
    h = await startRouter({ providers: [{ id: "network", name: "Network", models: [MODELS.llama] }] });
    await h.ctx.db.update(providers).set({ kind: "sidecar", status: "shadow", attested: true, teeKind: "tdx", attestationHash: "verified-fixture", attestedAt: new Date(now), shadowUntil: deadline }).where(eq(providers.id, "network"));
    await h.ctx.catalog.refresh();
    const offer = h.ctx.catalog.offersByModel.get(MODELS.llama.slug)![0];
    candidate = { ...offer, provider: { ...offer.provider, networkHost: true } } as Candidate;
    curated = { ...candidate, providerId: "curated", provider: { ...candidate.provider, id: "curated", networkHost: false, status: "live" } } as Candidate;
    const start = new Date(deadline.getTime() - settings.probationDays * 86_400_000);
    const receipt = { disclosure: "attested", attestation: "verified-fixture" };
    await h.ctx.db.insert(generations).values([
      ...Array.from({ length: 199 }, (_, i) => ({ id: `good-${i}`, providerId: "network", modelId: MODELS.llama.slug, mode: "prepaid", receiptSig: "fixture-signature", receipt, ts: new Date(now - 120_000) })),
      ...[
        { id: "too-old", ts: new Date(start.getTime() - 1) },
        { id: "cancelled", cancelled: true }, { id: "cached", mode: "cache" },
        { id: "unsigned", receiptSig: null }, { id: "unattested", receipt: { disclosure: "policy" } },
        { id: "development", receipt: { ...receipt, attestation_simulated: true } },
        { id: "embedding", receipt: { disclosure: "attested" } },
      ].map((change) => ({ providerId: "network", modelId: MODELS.llama.slug, mode: "prepaid", receiptSig: "fixture-signature", receipt, ts: new Date(now - 120_000), ...change })),
    ]);
    await h.ctx.db.insert(healthTable).values([
      ...Array.from({ length: 100 }, (_, i) => ({ providerId: "network", modelId: MODELS.llama.slug, source: "probe", ok: i !== 99, latencyMs: 500, ts: new Date(now - 120_000) })),
      { providerId: "network", modelId: MODELS.llama.slug, source: "traffic", ok: false, errorKind: "rejected", ts: new Date(now - 120_000) },
      { providerId: "network", modelId: MODELS.llama.slug, source: "probe", ok: false, errorKind: "rate_limited", ts: new Date(now - 120_000) },
      { providerId: "network", modelId: MODELS.llama.slug, source: "probe", ok: false, ts: new Date(start.getTime() - 1) },
    ]);
    await h.ctx.db.insert(attestations).values({ providerId: "network", ok: true, teeKind: "tdx", ts: new Date(now - 120_000) });
    // Reflect the incoming column without adding schema or migrating this branch.
    flaggedDb = { execute: (q: Parameters<Db["execute"]>[0]) => h.ctx.db.execute(q), select: () => ({ from: async () => [candidate.provider] }) } as unknown as Db;
    tracker = new HealthTracker();
    configureNetworkRouting(tracker, settings);
    await tracker.refreshAggregates(flaggedDb);
  });
  afterAll(async () => { await h?.close(); });

  test("counts genuine persisted attested outcomes and observed probe availability without a prior", async () => {
    const evidence = await readNetworkEvidence(h.ctx.db, candidate.provider, settings, now);
    expect(evidence).toMatchObject({ attestedSuccesses: 200, probeSuccesses: 99, probeFailures: 1, recentSuccesses: 99, recentFailures: 1, probeLatencyMs: 500, failedAttestation: false });
    expect(networkWeight({ ...base, ...evidence, now, networkHost: true }, settings)).toBe(1);
    expect(ids(selectProviders(input([candidate, curated], tracker)))).toEqual(["network", "curated"]);
    const adjusted = networkSelectionInput(input([candidate, curated], tracker));
    expect(adjusted.health.quality(curated.modelId, "curated")).toBe(tracker.quality(curated.modelId, "curated"));
    expect(adjusted.health.uptime30d(curated.modelId, "curated")).toBe(tracker.uptime30d(curated.modelId, "curated"));
  });
  test("new probation and expired insufficient evidence retain low weight; they can receive real traffic", async () => {
    const fresh = { ...candidate, provider: { ...candidate.provider, status: "probation", shadowUntil: new Date(Date.now() + 7 * 86_400_000) } };
    const db = { ...flaggedDb, select: () => ({ from: async () => [fresh.provider] }) } as unknown as Db;
    const health = new HealthTracker();
    configureNetworkRouting(health, settings);
    await refreshNetworkRouting(health, db);
    const original = input([fresh, curated], health);
    const adjusted = networkSelectionInput(original);
    expect(adjusted.health.quality(fresh.modelId, "network")).toBe(0.1);
    expect(ids(selectProviders(original))).toEqual(["curated", "network"]);
    expect(fresh.provider.status).toBe("probation");
    expect(networkProbeEligible(fresh.provider, settings)).toBe(true);
    expect(networkProbeEligible(fresh.provider, { ...settings, enabled: false })).toBe(false);
    expect(networkProbeOfferEligible(fresh.provider, "shadow", settings)).toBe(true);
    expect(networkProbeOfferEligible(fresh.provider, "shadow", { ...settings, enabled: false })).toBe(false);
    expect(networkProbeOfferEligible(curated.provider, "shadow", settings)).toBe(false);
  });
  test("network down falls back only within the requested lane, including sorted and pinned requests", () => {
    tracker.record({ modelId: candidate.modelId, providerId: "network", ok: false, source: "probe" });
    const publicOffer = { ...curated, providerId: "public", provider: { ...curated.provider, id: "public", attested: false } };
    for (const lane of ["attested", "unlinkable"] as const) {
      for (const prefs of [{ lane }, { lane, sort: "price" as const }, { lane, order: ["network"] }]) {
        const selected = selectProviders(input([candidate, curated, publicOffer], tracker, prefs));
        expect(ids(selected)).toEqual(["curated"]);
        expect(selected.excluded).toContainEqual({ provider: "network", reason: OUTAGE_REASON });
      }
      expect(ids(selectProviders(input([candidate, publicOffer], tracker, { lane })))).toEqual([]);
      expect(ids(selectProviders(input([candidate, curated], tracker, { lane, order: ["network"], allow_fallbacks: false })))).toEqual([]);
    }
    expect(ids(selectProviders(input([candidate, curated, publicOffer], tracker)))).toContain("public");
  });
  test("failed attestation blocks public routing until a later successful attestation; idle refresh sees changes", async () => {
    const health = new HealthTracker();
    configureNetworkRouting(health, settings);
    await h.ctx.db.insert(attestations).values({ providerId: "network", ok: false, ts: new Date(now - 10_000) });
    await health.flush(flaggedDb);
    for (const prefs of [{}, { sort: "price" as const }, { sort: "latency" as const }, { sort: "throughput" as const }, { order: ["network"] }]) expect(ids(selectProviders(input([candidate, curated], health, prefs)))).toEqual(["curated"]);
    await h.ctx.db.insert(attestations).values({ providerId: "network", ok: true, ts: new Date(now - 5_000) });
    await health.flush(flaggedDb);
    expect(ids(selectProviders(input([candidate, curated], health)))).toContain("network");
    await h.ctx.db.insert(attestations).values({ providerId: "network", ok: true, teeKind: "dev", ts: new Date(now - 3_000) });
    await health.flush(flaggedDb);
    expect(ids(selectProviders(input([candidate, curated], health)))).toEqual(["curated"]);
    await h.ctx.db.insert(attestations).values({ providerId: "network", ok: true, teeKind: "tdx", ts: new Date(now - 1_000) });
    await health.flush(flaggedDb);
    expect(ids(selectProviders(input([candidate, curated], health)))).toContain("network");
  });
  test("refresh failure clears evidence; absent N2 flag and feature off leave inputs unchanged", async () => {
    const health = new HealthTracker();
    configureNetworkRouting(health, settings);
    await refreshNetworkRouting(health, flaggedDb);
    const broken = { select: () => ({ from: async () => { throw new Error("database unavailable"); } }) } as unknown as Db;
    await expect(refreshNetworkRouting(health, broken)).rejects.toThrow("database unavailable");
    expect(ids(selectProviders(input([candidate, curated], health)))).toEqual(["curated"]);
    const ordinary = input([curated], health);
    expect(networkSelectionInput(ordinary)).toBe(ordinary);
    configureNetworkRouting(health, { ...settings, enabled: false });
    const disabled = input([candidate, curated], health);
    expect(networkSelectionInput(disabled)).toBe(disabled);
    expect(candidate.provider.status).toBe("shadow");
  });
});

test("real production config loader starts with network routing enabled and preserves the production guards", () => {
  const address = "0x" + "1".repeat(40);
  const config = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", NETWORK_HOSTS_ENABLED: "true", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) });
  expect(config.production).toBe(true);
  expect(config.networkWeights).toEqual({ enabled: true, probationDays: 7, graduateRequests: 200, graduateUptime: 0.99 });
  expect(loadConfig({}).networkWeights.enabled).toBe(false);
  expect(NETWORK_WEIGHT_POLICY.probationWeight).toBe(0.1);
  for (const bad of [{ NETWORK_GRADUATE_UPTIME: "0.5" }, { NETWORK_GRADUATE_REQUESTS: "0" }, { NETWORK_PROBATION_DAYS: "0" }]) expect(() => loadConfig(bad)).toThrow();
});
