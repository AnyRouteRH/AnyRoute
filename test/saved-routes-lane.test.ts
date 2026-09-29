import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { keys as keysTable, providers, savedRoutes } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import {
  applyRouteConfig,
  modelsOffLane,
  normalizeConfig,
  patchConfig,
  routeCeiling,
  routeConfigSchema,
  strictest,
  type RouteConfig,
} from "../src/routing/saved-routes.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
const LANE_RANK = { public: 0, attested: 1, unlinkable: 2 };
const DISCLOSURE_RANK = { any: 0, policy: 1, none: 2 };

// ---- pure pieces ---------------------------------------------------------------------------------

const config = (provider?: Record<string, unknown>, models = [LLAMA]) => routeConfigSchema.parse({ models, ...(provider ? { provider } : {}) });
const route = (provider: Record<string, unknown>) => applyRouteConfig({ model: "@route/x", messages: [] }, config(provider));
const routeWith = (provider: Record<string, unknown>, sent: unknown) => {
  const body: Record<string, unknown> = { model: "@route/x", provider: sent };
  applyRouteConfig(body, config(provider));
  return body.provider as Record<string, unknown>;
};

describe("a route's privacy settings: schema and storage", () => {
  test("lane is public or attested and disclosure is none, policy or any; nothing else, and no unlinkable", () => {
    for (const provider of [{ lane: "public" }, { lane: "attested" }, { disclosure: "none" }, { disclosure: "policy" }, { disclosure: "any" }, { lane: "public", disclosure: "policy" }, { lane: "attested", disclosure: "none" }])
      expect(routeConfigSchema.safeParse({ models: [LLAMA], provider }).success).toBe(true);
    for (const provider of [{ lane: "unlinkable" }, { lane: "fast" }, { lane: "ATTESTED" }, { lane: true }, { disclosure: "sometimes" }, { disclosure: 1 }])
      expect(routeConfigSchema.safeParse({ models: [LLAMA], provider }).success).toBe(false);
  });

  test('lane "attested" next to a looser disclosure is refused, with the reason', () => {
    for (const disclosure of ["policy", "any"]) {
      const r = routeConfigSchema.safeParse({ models: [LLAMA], provider: { lane: "attested", disclosure } });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('already requires disclosure \\"none\\"');
    }
  });

  test("defaults and implied settings are not stored", () => {
    expect(normalizeConfig(config({ lane: "public", disclosure: "any" }))).toEqual({ models: [LLAMA] });
    expect(normalizeConfig(config({ lane: "public", zdr: true }))).toEqual({ models: [LLAMA], provider: { zdr: true } });
    expect(normalizeConfig(config({ lane: "attested", disclosure: "none" }))).toEqual({ models: [LLAMA], provider: { lane: "attested" } });
    expect(normalizeConfig(config({ disclosure: "policy" }))).toEqual({ models: [LLAMA], provider: { disclosure: "policy" } });
  });

  test("PATCH replaces the provider section, so the lane is set, kept or cleared with it", () => {
    const cur = normalizeConfig(config({ lane: "attested", sort: "price" }));
    expect(patchConfig(cur, { models: [QWEN] })).toEqual({ models: [QWEN], provider: { lane: "attested", sort: "price" } });
    expect(patchConfig(cur, { provider: { sort: "price" } })).toEqual({ models: [LLAMA], provider: { sort: "price" } }); // a section sent replaces the section
    expect(patchConfig(cur, { provider: null })).toEqual({ models: [LLAMA] });
    expect(patchConfig({ models: [LLAMA] }, { provider: { disclosure: "policy" } })).toEqual({ models: [LLAMA], provider: { disclosure: "policy" } });
  });

  test("what a route asks of the lane", () => {
    expect(routeCeiling(undefined)).toEqual({ lane: "public", max: "any" });
    expect(routeCeiling({ lane: "public" })).toEqual({ lane: "public", max: "any" });
    expect(routeCeiling({ disclosure: "policy" })).toEqual({ lane: "public", max: "policy" });
    expect(routeCeiling({ disclosure: "none" })).toEqual({ lane: "public", max: "none" });
    expect(routeCeiling({ lane: "attested" })).toEqual({ lane: "attested", max: "none" });
    expect(routeCeiling({ lane: "attested", disclosure: "none" })).toEqual({ lane: "attested", max: "none" });
  });
});

describe("strictest wins between a route and its request", () => {
  test("lane: a request can raise a route's lane, never lower it", () => {
    expect(strictest(LANE_RANK, "attested", undefined)).toBe("attested");
    expect(strictest(LANE_RANK, "attested", null)).toBe("attested");
    expect(strictest(LANE_RANK, "attested", "")).toBe("attested");
    expect(strictest(LANE_RANK, "attested", "public")).toBe("attested");
    expect(strictest(LANE_RANK, "attested", "  PUBLIC ")).toBe("attested");
    expect(strictest(LANE_RANK, "attested", "attested")).toBe("attested");
    expect(strictest(LANE_RANK, "attested", "unlinkable")).toBe("unlinkable"); // stricter: kept
    expect(strictest(LANE_RANK, "public", "attested")).toBe("attested");
    expect(strictest(LANE_RANK, undefined, "attested")).toBe("attested");
    expect(strictest(LANE_RANK, undefined, undefined)).toBeUndefined();
  });

  test("values the router does not recognise are left for the chat path to answer with a 400", () => {
    expect(strictest(LANE_RANK, "attested", "fast")).toBe("fast");
    expect(strictest(LANE_RANK, "attested", 7)).toBe(7);
    expect(strictest(LANE_RANK, "attested", { lane: "public" })).toEqual({ lane: "public" });
    expect(strictest(DISCLOSURE_RANK, "policy", "sometimes")).toBe("sometimes");
  });

  test("disclosure: none beats policy beats any, whichever side sets it", () => {
    expect(strictest(DISCLOSURE_RANK, "policy", "any")).toBe("policy");
    expect(strictest(DISCLOSURE_RANK, "policy", "policy")).toBe("policy");
    expect(strictest(DISCLOSURE_RANK, "policy", "none")).toBe("none");
    expect(strictest(DISCLOSURE_RANK, "none", "policy")).toBe("none");
    expect(strictest(DISCLOSURE_RANK, "none", " Any ")).toBe("none");
    expect(strictest(DISCLOSURE_RANK, "any", "policy")).toBe("policy");
  });

  test("applied to a request body: the route tightens, the request cannot loosen, other fields keep their precedence", () => {
    expect(route({ lane: "attested", sort: "price" }).provider).toEqual({ lane: "attested", sort: "price" });
    expect(routeWith({ lane: "attested" }, { lane: "public", disclosure: "any" })).toEqual({ lane: "attested", disclosure: "any" }); // disclosure "any" adds nothing: the lane implies none
    expect(routeWith({ lane: "attested", sort: "price" }, { lane: "public", sort: "latency", only: ["alpha"] })).toEqual({ lane: "attested", sort: "latency", only: ["alpha"] });
    expect(routeWith({ disclosure: "policy" }, { disclosure: "any" })).toEqual({ disclosure: "policy" });
    expect(routeWith({ disclosure: "policy" }, { disclosure: "none" })).toEqual({ disclosure: "none" });
    expect(routeWith({ zdr: true }, { lane: "attested" })).toEqual({ zdr: true, lane: "attested" }); // a route without a lane leaves the request's alone
    expect(routeWith({ zdr: true }, { lane: "public" })).toEqual({ zdr: true, lane: "public" });
    expect(routeWith({ lane: "attested" }, undefined)).toEqual({ lane: "attested" });
    expect(routeWith({ lane: "attested" }, "nonsense")).toEqual({ lane: "attested" });
    expect(routeWith({ lane: "attested" }, ["public"])).toEqual({ lane: "attested" });
    expect(routeWith({ lane: "attested" }, { lane: "fast" })).toEqual({ lane: "fast" }); // the chat path refuses it with a 400
  });

  test("the route's own config is never shared with, or changed by, a request", () => {
    const cfg = config({ lane: "attested", only: ["alpha"] });
    const body: Record<string, unknown> = { model: "@route/x", provider: { lane: "public" } };
    applyRouteConfig(body, cfg);
    (body.provider as { only: string[] }).only.push("beta");
    expect(cfg.provider).toEqual({ lane: "attested", only: ["alpha"] });
  });
});

describe("which models a route's ceiling leaves out", () => {
  const classes: Record<string, ("attested" | "policy" | "vendor-forwarded")[] | null> = {
    a: ["attested", "vendor-forwarded"],
    p: ["policy"],
    v: ["vendor-forwarded"],
    none: [],
    gone: null,
  };
  const off = (provider: RouteConfig["provider"], models: string[]) => modelsOffLane({ models, provider }, (id) => classes[id] ?? null);

  test("a route with no ceiling leaves nothing out", () => {
    expect(off(undefined, ["a", "p", "v", "none"])).toEqual([]);
    expect(off({ lane: "public", disclosure: "any" }, ["a", "p", "v", "none"])).toEqual([]);
  });

  test("attested lane and disclosure none need an attested endpoint; policy accepts a documented policy", () => {
    expect(off({ lane: "attested" }, ["a", "p", "v", "none"])).toEqual(["p", "v", "none"]);
    expect(off({ disclosure: "none" }, ["a", "p", "v"])).toEqual(["p", "v"]);
    expect(off({ disclosure: "policy" }, ["a", "p", "v", "none"])).toEqual(["v", "none"]);
  });

  test("a model the catalog does not know is not this check's to report", () => {
    expect(off({ lane: "attested" }, ["gone", "a"])).toEqual([]);
  });
});

// ---- end to end ----------------------------------------------------------------------------------

const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
type Auth = Record<string, string>;

let h: Harness;
let owner: Awaited<ReturnType<Harness["fundedKey"]>>;
const admin = { "x-admin-token": ADMIN };
const routes = (method: string, json?: unknown, slug?: string, auth: Auth = owner.auth) => h.request("/api/v1/routes" + (slug !== undefined ? "/" + slug : ""), { method, headers: auth, json });
const create = (json: unknown) => routes("POST", json);
const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) => h.request("/api/v1/chat/completions", { method: "POST", headers: { ...owner.auth, ...headers }, json: { messages: [{ role: "user", content: "hello" }], ...body } });
const balance = async () => {
  const [k] = await h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, owner.hash));
  return (await balanceOf(h.ctx.db, k!.accountId)).balance;
};
const requests = async (id: string) => (await (await fetch(h.mocks[id].url + "/_stats")).json()).requests as number;
const setStale = async (stale: boolean) => {
  await h.ctx.db.update(providers).set({ attestedAt: stale ? new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 5) : new Date() }).where(eq(providers.id, "enclave"));
  await h.ctx.catalog.refresh();
};
const restoreAttestation = async () => {
  await runAttestor(h.ctx);
  await h.ctx.catalog.refresh();
};
const stored = async (slug: string) => (await h.ctx.db.select().from(savedRoutes).where(eq(savedRoutes.slug, slug)))[0];

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "vendor", name: "Vendor", models: [MODELS.llama, MODELS.qwen] },
      { id: "policy", name: "Policy", models: [MODELS.llamaPricey] },
      { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
    ],
  });
  owner = await h.fundedKey(20n);
  const put = (id: string, json: unknown) => h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: admin, json });
  expect((await put("policy", { retention: { value: "policy", ...claim }, legal_hold: { active: false, ...claim } })).status).toBe(200);
  expect((await put("enclave", { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } })).status).toBe(200);
  const att = await runAttestor(h.ctx);
  expect((att.results[0] as { ok: boolean }).ok).toBe(true);
});
afterAll(async () => h.close());

describe("saving a route that pins the attested lane", () => {
  test("a route whose models all have an attested endpoint is saved with its lane", async () => {
    const r = await create({ slug: "private-chat", config: { models: [LLAMA], provider: { lane: "attested", sort: "price" } } });
    expect(r.status).toBe(201);
    expect((await r.json()).data.config).toEqual({ models: [LLAMA], provider: { lane: "attested", sort: "price" } });
    expect((await stored("private-chat"))?.config).toEqual({ models: [LLAMA], provider: { lane: "attested", sort: "price" } });
    const one = await (await routes("GET", undefined, "private-chat")).json();
    expect(one.data.config.provider.lane).toBe("attested");
  });

  test("a model with no attested endpoint refuses the whole route, names the model, and saves nothing", async () => {
    const r = await create({ slug: "half-private", config: { models: [LLAMA, QWEN], provider: { lane: "attested" } } });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.type).toBe("route_lane_unavailable");
    expect(j.error.message).toContain(QWEN);
    expect(j.error.message).not.toContain(LLAMA);
    expect(j.error.message).toMatch(/Nothing|Not saved/);
    expect(j.error.metadata).toEqual({ lane: "attested", disclosure: "none", unavailable_models: [QWEN] });
    expect(await stored("half-private")).toBeUndefined();
    expect((await routes("GET", undefined, "half-private")).status).toBe(404);
  });

  test("disclosure none is checked the same way, and disclosure policy accepts a documented policy", async () => {
    const none = await create({ slug: "none-route", config: { models: [QWEN], provider: { disclosure: "none" } } });
    expect(none.status).toBe(409);
    expect((await none.json()).error.metadata).toMatchObject({ lane: "public", disclosure: "none", unavailable_models: [QWEN] });
    const policy = await create({ slug: "policy-route", config: { models: [LLAMA], provider: { disclosure: "policy" } } });
    expect(policy.status).toBe(201);
    expect((await policy.json()).data.config.provider).toEqual({ disclosure: "policy" });
    const vendorOnly = await create({ slug: "policy-qwen", config: { models: [QWEN], provider: { disclosure: "policy" } } });
    expect(vendorOnly.status).toBe(409);
    expect((await vendorOnly.json()).error.message).toContain("documented no-retention policy");
  });

  test("the route's own provider.only / provider.ignore count: pinning the lane to a provider that is not attested is refused", async () => {
    const only = await create({ slug: "vendor-attested", config: { models: [LLAMA], provider: { lane: "attested", only: ["vendor"] } } });
    expect(only.status).toBe(409);
    expect((await only.json()).error.metadata.unavailable_models).toEqual([LLAMA]);
    const ignore = await create({ slug: "ignore-enclave", config: { models: [LLAMA], provider: { lane: "attested", ignore: ["enclave"] } } });
    expect(ignore.status).toBe(409);
    expect((await create({ slug: "only-enclave", config: { models: [LLAMA], provider: { lane: "attested", only: ["Enclave"] } } })).status).toBe(201);
  });

  test("malformed settings are a 400 that says what is wrong", async () => {
    const both = await create({ slug: "contradiction", config: { models: [LLAMA], provider: { lane: "attested", disclosure: "policy" } } });
    expect(both.status).toBe(400);
    expect(JSON.stringify(await both.json())).toContain("already requires disclosure");
    for (const provider of [{ lane: "unlinkable" }, { lane: "fast" }, { disclosure: "sometimes" }]) expect((await create({ slug: "junk", config: { models: [LLAMA], provider } })).status).toBe(400);
    expect(await stored("junk")).toBeUndefined();
  });

  test("the default settings are accepted and not stored; an unknown model is still the catalog's 400", async () => {
    const r = await create({ slug: "plain-public", config: { models: [QWEN], provider: { lane: "public", disclosure: "any" } } });
    expect(r.status).toBe(201);
    expect((await r.json()).data.config).toEqual({ models: [QWEN] });
    const unknown = await create({ slug: "nope", config: { models: ["x/unknown"], provider: { lane: "attested" } } });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.type).toBe("model_not_found");
  });

  test("PATCH checks the resulting route: adding a model without an attested endpoint, or the lane onto one, is refused and changes nothing", async () => {
    const before = (await stored("private-chat"))?.config;
    const add = await routes("PATCH", { config: { models: [LLAMA, QWEN] } }, "private-chat");
    expect(add.status).toBe(409);
    expect((await add.json()).error.metadata.unavailable_models).toEqual([QWEN]);
    const pin = await routes("PATCH", { config: { provider: { lane: "attested" } } }, "plain-public");
    expect(pin.status).toBe(409);
    expect((await stored("private-chat"))?.config).toEqual(before);
    expect((await stored("plain-public"))?.config).toEqual({ models: [QWEN] });
    // Loosening it, or changing only what does not depend on the lane, is fine.
    const rename = await routes("PATCH", { name: "Private chat", config: { params: { temperature: 0.2 } } }, "private-chat");
    expect(rename.status).toBe(200);
    expect((await rename.json()).data.config).toEqual({ models: [LLAMA], provider: { lane: "attested", sort: "price" }, params: { temperature: 0.2 } });
    const set = await routes("PATCH", { config: { provider: { lane: "attested" } } }, "policy-route");
    expect(set.status).toBe(200);
    expect((await set.json()).data.config.provider).toEqual({ lane: "attested" });
    const clear = await routes("PATCH", { config: { provider: null } }, "policy-route");
    expect(clear.status).toBe(200);
    expect((await clear.json()).data.config).toEqual({ models: [LLAMA] });
  });

  test("when the attested provider's attestation has lapsed, saving a route for the lane is refused; renaming an existing one still works", async () => {
    await setStale(true);
    try {
      const r = await create({ slug: "lapsed", config: { models: [LLAMA], provider: { lane: "attested" } } });
      expect(r.status).toBe(409);
      expect((await r.json()).error.type).toBe("route_lane_unavailable");
      const rename = await routes("PATCH", { name: "Still here" }, "private-chat");
      expect(rename.status).toBe(200);
    } finally {
      await restoreAttestation();
    }
    expect((await create({ slug: "lapsed", config: { models: [LLAMA], provider: { lane: "attested" } } })).status).toBe(201);
    await routes("DELETE", undefined, "lapsed");
  });
});

describe("calling an attested route", () => {
  test("it is served by the attested provider, and the lane, disclosure and receipt say so", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await chat({ model: "@route/private-chat" });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j).toMatchObject({ provider: "Enclave", route: "private-chat", model: LLAMA });
      expect(r.headers.get("x-anyroute-lane")).toBe("attested");
      expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
      expect(r.headers.get("x-receipt-id")).toBe(j.id);
      expect(j.receipt.payload).toMatchObject({ lane: "attested", disclosure: "attested" });
    }
  });

  test("a request can make the route stricter but never looser: body, headers and key defaults all lose to the route", async () => {
    const attempts: [Record<string, unknown>, Record<string, string>][] = [
      [{ provider: { lane: "public" } }, {}],
      [{ provider: { lane: "public", disclosure: "any" } }, {}],
      [{ provider: { disclosure: "any" } }, {}],
      [{}, { "x-anyroute-lane": "public" }],
      [{}, { "x-anyroute-disclosure-max": "any" }],
      [{ provider: { lane: " PUBLIC ", disclosure: "any" } }, { "x-anyroute-lane": "public", "x-anyroute-disclosure-max": "any" }],
    ];
    for (const [body, headers] of attempts) {
      const r = await chat({ model: "@route/private-chat", ...body }, headers);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.provider).toBe("Enclave");
      expect(r.headers.get("x-anyroute-lane")).toBe("attested");
      expect(j.receipt.payload.lane).toBe("attested");
    }
    // A key whose default provider preferences are the public lane does not loosen it either.
    const k = await h.fundedKey(2n);
    await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { routing: { provider: { lane: "public", disclosure: "any" } } } });
    await h.request("/api/v1/routes", { method: "POST", headers: k.auth, json: { slug: "private-chat", config: { models: [LLAMA], provider: { lane: "attested" } } } });
    const viaKey = await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: "@route/private-chat", messages: [{ role: "user", content: "hi" }] } });
    expect(viaKey.status).toBe(200);
    expect(viaKey.headers.get("x-anyroute-lane")).toBe("attested");
    expect((await viaKey.json()).provider).toBe("Enclave");
  });

  test("a stricter request works: a route with a disclosure ceiling can be raised to none", async () => {
    await create({ slug: "policy-or-better", config: { models: [LLAMA], provider: { disclosure: "policy" } } });
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = await chat({ model: "@route/policy-or-better" });
      expect(r.status).toBe(200);
      seen.add((await r.json()).provider);
    }
    expect([...seen].every((p) => p === "Policy" || p === "Enclave")).toBe(true); // never the vendor
    for (let i = 0; i < 4; i++) {
      const r = await chat({ model: "@route/policy-or-better", provider: { disclosure: "none" } });
      expect(r.status).toBe(200);
      expect((await r.json()).provider).toBe("Enclave");
    }
    const lane = await chat({ model: "@route/policy-or-better", provider: { lane: "attested" } });
    expect(lane.headers.get("x-anyroute-lane")).toBe("attested");
    // Asking for a looser disclosure than the route's does nothing.
    for (let i = 0; i < 8; i++) expect((await (await chat({ model: "@route/policy-or-better", provider: { disclosure: "any" } })).json()).provider).not.toBe("Vendor");
  });

  test("a request the route cannot satisfy is refused, not downgraded: nothing is sent to another provider or charged", async () => {
    const before = { money: await balance(), vendor: await requests("vendor"), policy: await requests("policy") };
    const refused: [Record<string, unknown>, string][] = [
      [{ model: "@route/private-chat", provider: { only: ["vendor"] } }, "only vendor"],
      [{ model: "@route/private-chat", provider: { only: ["policy"] } }, "only policy"],
      [{ model: "@route/private-chat", stream: true, provider: { only: ["vendor"] } }, "stream"],
    ];
    for (const [body, why] of refused) {
      const r = await chat(body);
      expect(r.status, why).toBe(409);
      const j = await r.json();
      expect(j.error.type, why).toBe("lane_unavailable");
      expect(j.error.message, why).toMatch(/Nothing was sent to any provider and nothing was charged/);
      expect(j.error.metadata.requested, why).toEqual({ disclosure: "none", lane: "attested" });
    }
    expect(await balance()).toBe(before.money);
    expect(await requests("vendor")).toBe(before.vendor);
    expect(await requests("policy")).toBe(before.policy);
  });

  test("when the attested provider stops being attested, the route fails closed instead of using the others", async () => {
    await setStale(true);
    try {
      const before = { money: await balance(), vendor: await requests("vendor"), policy: await requests("policy"), enclave: await requests("enclave") };
      for (const body of [{ model: "@route/private-chat" }, { model: "@route/private-chat", stream: true }, { model: "@route/private-chat", provider: { lane: "public" } }]) {
        const r = await chat(body);
        expect(r.status).toBe(409);
        expect((await r.json()).error.type).toBe("lane_unavailable");
      }
      // An unrelated call without a lane is unaffected, so the refusal is the route's, not an outage.
      expect((await chat({ model: LLAMA })).status).toBe(200);
      expect(await requests("enclave")).toBe(before.enclave); // never asked
      expect(await requests("policy")).toBe(before.policy);
    } finally {
      await restoreAttestation();
    }
    expect((await chat({ model: "@route/private-chat" })).status).toBe(200);
  });

  test("a fallback list sent with the request cannot bring in a model the lane does not serve", async () => {
    const before = await requests("vendor");
    const r = await chat({ model: "@route/private-chat", models: [QWEN, LLAMA] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ provider: "Enclave", model: LLAMA }); // the vendor's qwen is skipped, not used
    expect(await requests("vendor")).toBe(before);
  });

  test("an outage of the attested provider is a 503 to retry, and still no downgrade", async () => {
    const health = h.ctx.health as unknown as { outage: (m: string, p: string) => boolean };
    const original = health.outage.bind(h.ctx.health);
    health.outage = (m, p) => p === "enclave" || original(m, p);
    try {
      const before = { money: await balance(), vendor: await requests("vendor") };
      const r = await chat({ model: "@route/private-chat" });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("30");
      expect((await r.json()).error.type).toBe("disclosure_provider_unavailable");
      expect(await balance()).toBe(before.money);
      expect(await requests("vendor")).toBe(before.vendor);
    } finally {
      health.outage = original;
    }
  });

  test("a route with no privacy settings behaves as before, and a request may still ask the lane of it", async () => {
    const plain = await chat({ model: "@route/plain-public" });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-anyroute-lane")).toBe("public");
    expect((await plain.json()).provider).toBe("Vendor");
    const asked = await chat({ model: "@route/plain-public", provider: { lane: "attested" } });
    expect(asked.status).toBe(409); // qwen has no attested provider: refused, not served by the vendor
    expect((await asked.json()).error.type).toBe("lane_unavailable");
  });

  test("a junk lane in a request is still the chat path's 400", async () => {
    const r = await chat({ model: "@route/private-chat", provider: { lane: "fast" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/public, attested, unlinkable/);
  });

  test("a response cached for the public lane is never replayed to the attested route", async () => {
    const cache = { mode: "exact" };
    const content = "cache boundary check";
    const open = await chat({ model: LLAMA, cache, messages: [{ role: "user", content }] });
    expect(open.status).toBe(200);
    const routed = await chat({ model: "@route/private-chat", cache, messages: [{ role: "user", content }] });
    expect(routed.status).toBe(200);
    expect(routed.headers.get("x-anyroute-cache")).toBeNull();
    expect((await routed.json()).provider).toBe("Enclave");
  });
});
