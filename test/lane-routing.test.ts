import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { providers } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { DEFAULT_ATTESTED_BONUS, selectProviders, selectionWeight, weightedShuffle, type HealthView } from "../src/router/select.ts";
import type { Candidate } from "../src/catalog/catalog.ts";
import { NO_ATTESTED_ENDPOINT, OUTAGE_REASON, UNDECLARED, disclosureRefusal, parseLaneDowngrade, profileOf, resolveDisclosureRequest } from "../src/router/disclosure.ts";
import { MAINSTREAM } from "../src/router/lane.ts";
import { loadConfig } from "../src/config.ts";

// Privacy-lane routing: public, attested and unlinkable as first-class lanes of the router.

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const OLD = "2025-01-15";
const claim = { source: "https://provider.example/terms", as_of: OLD };

// ---- pure pieces ---------------------------------------------------------------------------------

const provider = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, status: "live", dataPolicy: {}, attested: false, attestationHash: null, attestedAt: null, teeKind: null, anyrStake: 0n, datacenter: [], ...extra }) as unknown as Candidate["provider"];
const offer = (pid: string, prompt: bigint, pextra: Record<string, unknown> = {}) =>
  ({ modelId: "m/x", providerId: pid, providerModelId: "x", pricePrompt: prompt, priceCompletion: prompt * 3n, priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, priceCacheRead: null, priceCacheWrite: null, quant: "bf16", ctx: 100_000, maxOut: 4096, supportedParameters: [], features: {}, isModerated: false, status: "live", updatedAt: new Date(), provider: provider(pid, pextra) }) as unknown as Candidate;
const tee = { attested: true, attestationHash: "0xabc", attestedAt: new Date(), teeKind: "tdx" };
const attestedProfile = profileOf({ retention: "attested", jurisdiction: "CH", legalHold: false, legalHoldNote: null, trainingUse: "none", claims: {}, updatedAt: new Date() });
const healthy: HealthView = { outage: () => false, uptime30d: () => 1, quality: () => 1, stats: () => null };
const fixed = () => 0.5; // the same draw for every candidate: the order is the weight order, ties broken deterministically

function run(offers: Candidate[], prefs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const attested = new Set(offers.filter((o) => o.provider.attested).map((o) => o.providerId));
  return selectProviders({
    modelId: "m/x",
    offers,
    prefs,
    modifiers: new Set(),
    requestParams: [],
    estimatedTokens: 100,
    health: healthy,
    production: true,
    attestationMaxAgeMs: 3_600_000,
    disclosure: (id) => (attested.has(id) ? attestedProfile : UNDECLARED),
    modelLane: MAINSTREAM,
    rand: fixed,
    ...extra,
  } as never);
}
const order = (s: ReturnType<typeof run>) => s.ordered.map((o) => o.providerId);

describe("selection weight within a lane", () => {
  test("weight = uptime x quality x attested_bonus / price^2, with the bonus only for attested endpoints and never below 1", () => {
    const base = { price: 100, minPrice: 100, uptime: 1, quality: 1, attested: false, bonus: 1.25 };
    expect(selectionWeight(base)).toBe(1);
    expect(selectionWeight({ ...base, attested: true })).toBe(1.25);
    expect(selectionWeight({ ...base, price: 200 })).toBe(0.25); // twice the price, a quarter of the weight
    expect(selectionWeight({ ...base, uptime: 0.9, quality: 0.5, attested: true })).toBeCloseTo(0.9 * 0.5 * 1.25, 12);
    expect(selectionWeight({ ...base, attested: true, bonus: 0.5 })).toBe(1); // attestation never lowers a weight
    expect(selectionWeight({ ...base, price: 1, minPrice: 100 })).toBeCloseTo(100, 9); // floored at a tenth of the cheapest price
    expect(DEFAULT_ATTESTED_BONUS).toEqual({ public: 1.25, attested: 1, unlinkable: 1 });
    // The router's configured defaults match.
    expect(loadConfig({}).routing.attestedBonus).toEqual({ public: 1.25, attested: 1, unlinkable: 1 });
    expect(loadConfig({ ATTESTED_BONUS_PUBLIC: "2" }).routing.attestedBonus.public).toBe(2);
    expect(() => loadConfig({ ATTESTED_BONUS_PUBLIC: "0.5" })).toThrow();
  });

  test("on the public lane an attested endpoint outranks an equal one; with the bonus at 1 the tie breaks by id, whatever the input order", () => {
    const a = offer("aaa-vendor", 100n);
    const z = offer("zzz-enclave", 100n, tee);
    expect(order(run([a, z]))).toEqual(["zzz-enclave", "aaa-vendor"]);
    expect(order(run([z, a]))).toEqual(["zzz-enclave", "aaa-vendor"]);
    expect(order(run([a, z], {}, { attestedBonus: { public: 1 } }))).toEqual(["aaa-vendor", "zzz-enclave"]);
    expect(order(run([z, a], {}, { attestedBonus: { public: 1 } }))).toEqual(["aaa-vendor", "zzz-enclave"]);
    // Price still dominates: twice the price is a quarter of the weight, more than the bonus makes up.
    expect(order(run([offer("cheap", 100n), offer("dear", 200n, tee)]))).toEqual(["cheap", "dear"]);
    // Uptime and quality count as before.
    const shaky: HealthView = { ...healthy, uptime30d: (_m, p) => (p === "zzz-enclave" ? 0.5 : 1) };
    expect(order(run([a, z], {}, { health: shaky }))).toEqual(["aaa-vendor", "zzz-enclave"]);
  });

  test("weightedShuffle breaks equal draws by weight, then by the tie-break, never by input order", () => {
    const w = (x: string) => (x === "heavy" ? 2 : 1);
    const byName = (p: string, q: string) => p.localeCompare(q);
    expect(weightedShuffle(["b", "heavy", "a"], w, fixed, byName)).toEqual(["heavy", "a", "b"]);
    expect(weightedShuffle(["a", "b", "heavy"], w, fixed, byName)).toEqual(["heavy", "a", "b"]);
  });
});

describe("lane enforcement at selection", () => {
  const offers = [offer("vendor", 100n), offer("enclave", 150n, tee), offer("enclave2", 150n, tee), offer("lapsed", 90n, { ...tee, attestedAt: new Date(Date.now() - 10 * 3_600_000) })];

  test("attested and unlinkable keep only endpoints with a fresh, verified attestation, and never fall back", () => {
    for (const lane of ["attested", "unlinkable"]) {
      const s = run(offers, { lane });
      expect(order(s).sort()).toEqual(["enclave", "enclave2"]);
      const why = Object.fromEntries(s.excluded.map((e) => [e.provider, e.reason]));
      expect(why.vendor).toContain(`lane "${lane}"`);
      expect(why.lapsed).toContain(`lane "${lane}"`); // an attestation that is no longer fresh does not count
    }
    // Nothing attested at all: the list is empty. There is no second pass without the lane.
    const none = run([offer("vendor", 100n), offer("lapsed", 90n, { ...tee, attestedAt: new Date(0) })], { lane: "attested" });
    expect(none.ordered).toEqual([]);
    // A dev attestation never counts in production.
    expect(run([offer("dev", 100n, { ...tee, teeKind: "dev" })], { lane: "attested" }).ordered).toEqual([]);
  });

  test("provider order, only and ignore keep working inside a lane", () => {
    expect(order(run(offers, { lane: "attested", order: ["enclave2"] }))[0]).toBe("enclave2");
    expect(order(run(offers, { lane: "attested", order: ["enclave2"], allow_fallbacks: false }))).toEqual(["enclave2"]);
    expect(order(run(offers, { lane: "attested", only: ["enclave", "vendor"] }))).toEqual(["enclave"]);
    expect(order(run(offers, { lane: "attested", ignore: ["enclave"] }))).toEqual(["enclave2"]);
    // Pinning a provider that is not attested does not bring it back.
    expect(order(run(offers, { lane: "attested", order: ["vendor"], allow_fallbacks: false }))).toEqual([]);
    expect(order(run(offers, { lane: "attested", only: ["vendor"] }))).toEqual([]);
  });

  test("the refusal: 503 no_attested_endpoint, with the reason, and Retry-After only while attested endpoints are down", () => {
    const req = { max: "none", lane: "attested" } as const;
    const none = disclosureRefusal(req, [LLAMA], [{ provider: "vendor", reason: 'lane "attested" requires attested retention' }], () => true)!;
    expect(none.status).toBe(503);
    expect(none.type).toBe(NO_ATTESTED_ENDPOINT);
    expect(none.metadata).toMatchObject({ lane: "attested", reason: "none_attested", requested: { disclosure: "none", lane: "attested" } });
    expect(none.headers).toBeUndefined();
    expect(none.message).toMatch(/Nothing was sent to any provider and nothing was charged/);
    const down = disclosureRefusal({ max: "none", lane: "unlinkable" }, [LLAMA], [{ provider: "enclave", reason: OUTAGE_REASON }], () => true)!;
    expect(down.status).toBe(503);
    expect(down.type).toBe(NO_ATTESTED_ENDPOINT);
    expect(down.metadata).toMatchObject({ lane: "unlinkable", reason: "attested_endpoints_down" });
    expect(down.headers).toEqual({ "retry-after": "30" });
    // A request nothing would serve even on the public lane is not the lane's doing (404 no_providers upstream of this).
    expect(disclosureRefusal(req, [LLAMA], [], () => false)).toBeNull();
    // A disclosure ceiling without a lane keeps its own codes.
    expect(disclosureRefusal({ max: "none", lane: "public" }, [LLAMA], [], () => true)!.type).toBe("disclosure_unavailable");
  });
});

describe("choosing a lane", () => {
  test("the stricter of body and header wins; the default applies only when neither names a lane", () => {
    expect(resolveDisclosureRequest({}, {}, { unlinkable: true, defaultLane: "unlinkable" })).toEqual({ max: "none", lane: "unlinkable" });
    expect(resolveDisclosureRequest({ lane: "public" }, {}, { unlinkable: true, defaultLane: "unlinkable" })).toEqual({ max: "any", lane: "public" });
    expect(resolveDisclosureRequest({}, { lane: "attested" }, { unlinkable: true, defaultLane: "unlinkable" })).toEqual({ max: "none", lane: "attested" });
    expect(resolveDisclosureRequest({ lane: "public" }, { lane: "attested" })).toEqual({ max: "none", lane: "attested" });
    expect(resolveDisclosureRequest({ lane: "attested" }, { lane: "public" })).toEqual({ max: "none", lane: "attested" });
    expect(resolveDisclosureRequest({}, {})).toEqual({ max: "any", lane: "public" });
  });

  test("a downgrade from unlinkable is off unless asked for, and either setting can refuse it", () => {
    expect(parseLaneDowngrade(undefined, null)).toBe("none");
    expect(parseLaneDowngrade("attested", null)).toBe("attested");
    expect(parseLaneDowngrade(undefined, "ATTESTED")).toBe("attested");
    expect(parseLaneDowngrade("attested", "none")).toBe("none");
    expect(() => parseLaneDowngrade("public", null)).toThrow(/must be one of: none, attested/);
  });
});

// ---- over HTTP -----------------------------------------------------------------------------------

describe("lanes over HTTP", () => {
  let h: Harness;
  let k: Awaited<ReturnType<Harness["fundedKey"]>>;
  const chat = (json: Record<string, unknown>, headers: Record<string, string> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, ...headers }, json: { model: LLAMA, messages: [{ role: "user", content: "hi" }], ...json } });
  const calls = () => ({ vendor: h.mocks.vendor.stats.requests, enclave: h.mocks.enclave.stats.requests });
  const modelsRow = async (query = "") => ((await (await h.request(`/api/v1/models${query}`)).json()).data as { id: string; lanes: string[] }[]).find((m) => m.id === LLAMA);
  const status = async () => (await (await h.request("/api/v1/status")).json()).data.lanes;

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "vendor", name: "Vendor", models: [MODELS.llama] },
        { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
      ],
    });
    k = await h.fundedKey(10n);
  });
  afterAll(async () => {
    await h.close();
  });

  test("before any attestation: models and status list the public lane only, and the attested lane refuses with 503 no_attested_endpoint", async () => {
    expect((await modelsRow())!.lanes).toEqual(["public"]);
    const s = await status();
    expect(s.public.models).toBeGreaterThan(0);
    expect(s.attested).toMatchObject({ available: true, models: 0, endpoints: 0, attested_bonus: 1 });
    expect(s.unlinkable).toMatchObject({ available: false, models: 0 });
    expect(s.public.attested_bonus).toBe(1.25);
    const before = calls();
    for (const [body, headers] of [[{ provider: { lane: "attested" } }, {}], [{}, { "x-anyroute-lane": "attested" }]] as const) {
      const r = await chat({ ...body }, { ...headers });
      expect(r.status).toBe(503);
      const e = (await r.json()).error;
      expect(e.type).toBe("no_attested_endpoint");
      expect(e.metadata).toMatchObject({ lane: "attested", reason: "none_attested" });
    }
    expect(calls()).toEqual(before); // nothing reached any provider
  });

  test("after a real attestation: the model lists the attested lane, status counts it, and attested requests reach only the enclave", async () => {
    const declare = await h.request("/api/v1/disclosure/enclave", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
    expect(declare.status).toBe(200);
    expect(((await runAttestor(h.ctx)).results.find((r) => (r as { provider?: string }).provider === "enclave") as { ok: boolean } | undefined)?.ok ?? true).toBe(true);
    expect((await modelsRow())!.lanes).toEqual(["public", "attested"]);
    expect((await modelsRow("?lane=attested"))!.lanes).toContain("attested");
    const ep = (await (await h.request(`/api/v1/models/${LLAMA}/endpoints`)).json()).data.endpoints as { provider_slug: string; lanes: string[] }[];
    expect(Object.fromEntries(ep.map((e) => [e.provider_slug, e.lanes]))).toEqual({ vendor: ["public"], enclave: ["public", "attested"] });
    const s = await status();
    expect(s.attested).toMatchObject({ models: 1, endpoints: 1 });
    expect(s.public.endpoints).toBeGreaterThanOrEqual(2);
    const before = calls();
    for (let i = 0; i < 3; i++) {
      const r = await chat({ provider: { lane: "attested" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("x-anyroute-lane")).toBe("attested");
      expect((await r.json()).receipt.payload).toMatchObject({ lane: "attested", disclosure: "attested", provider: "enclave" });
    }
    expect(calls()).toEqual({ vendor: before.vendor, enclave: before.enclave + 3 });
    // "unlinkable" is not served by a router without the Oblivious HTTP gateway.
    expect((await chat({ provider: { lane: "unlinkable" } })).status).toBe(501);
  });

  test("a lapsed attestation drops the lane at once: no fallback to the vendor", async () => {
    const [{ attestedAt }] = await h.ctx.db.select().from(providers).where(eq(providers.id, "enclave"));
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - 10 * h.ctx.cfg.attestation.intervalMs) }).where(eq(providers.id, "enclave"));
    await h.ctx.catalog.refresh();
    try {
      const before = calls();
      const r = await chat({ provider: { lane: "attested", order: ["vendor"] } });
      expect(r.status).toBe(503);
      expect((await r.json()).error.type).toBe("no_attested_endpoint");
      expect((await modelsRow())!.lanes).toEqual(["public"]);
      expect(calls()).toEqual(before);
    } finally {
      await h.ctx.db.update(providers).set({ attestedAt }).where(eq(providers.id, "enclave"));
      await h.ctx.catalog.refresh();
    }
  });

  test("a key's default lane and a saved route's lane apply when the request names none; a request can still name its own", async () => {
    // Key default (keys.routing.provider.lane).
    const patch = await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { routing: { provider: { lane: "attested" } } } });
    expect(patch.status).toBe(200);
    const viaKey = await chat({});
    expect(viaKey.status).toBe(200);
    expect(viaKey.headers.get("x-anyroute-lane")).toBe("attested");
    const own = await chat({ provider: { lane: "public", only: ["vendor"] } });
    expect(own.status).toBe(200);
    expect(own.headers.get("x-anyroute-lane")).toBe("public");
    // A header asking for the public lane cannot relax the key's default: the stricter of body and header wins.
    expect((await chat({}, { "x-anyroute-lane": "public" })).headers.get("x-anyroute-lane")).toBe("attested");
    await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { routing: null } });

    // Saved route.
    const created = await h.request("/api/v1/routes", { method: "POST", headers: k.auth, json: { slug: "private-llama", config: { models: [LLAMA], provider: { lane: "attested" } } } });
    expect(created.status).toBe(201);
    const viaRoute = await chat({ model: "@route/private-llama" });
    expect(viaRoute.status).toBe(200);
    expect((await viaRoute.json()).receipt.payload).toMatchObject({ lane: "attested", provider: "enclave" });
    // "unlinkable" is not a route setting: a saved route is called with a key.
    const bad = await h.request("/api/v1/routes", { method: "POST", headers: k.auth, json: { slug: "nope", config: { models: [LLAMA], provider: { lane: "unlinkable" } } } });
    expect(bad.status).toBe(400);
  });

  test("identity-bearing auth on the unlinkable lane is refused where the router serves it (see ohttp.test.ts); here it is 501", async () => {
    const r = await chat({ provider: { lane: "unlinkable", lane_downgrade: "attested" } });
    expect(r.status).toBe(501);
    expect((await r.json()).error.type).toBe("lane_not_available");
  });
});
