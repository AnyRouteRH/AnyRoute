import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sse, startRouter, type Harness } from "./helpers.ts";
import { savedRoutes } from "../src/db/schema.ts";
import { accountIdFor } from "../src/api/auth.ts";
import { verifyInvariants } from "../src/ledger/ledger.ts";
import { MAX_ROUTES_PER_ACCOUNT, applyRouteConfig, normalizeConfig, patchConfig, routeConfigSchema, routeSlugOf, unknownModels } from "../src/routing/saved-routes.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
type Auth = Record<string, string>;

describe("saved route resolver (pure)", () => {
  test("only `@route/<slug>` names a route", () => {
    expect(routeSlugOf("@route/fast")).toBe("fast");
    for (const m of [LLAMA, "route/fast", "@Route/fast", undefined, 42]) expect(routeSlugOf(m)).toBeNull();
  });

  test("request values win over route defaults; unset ones are filled in", () => {
    const config = routeConfigSchema.parse({ models: [QWEN, LLAMA], provider: { sort: "price", zdr: true, only: ["alpha"] }, params: { temperature: 0.2, top_p: 0.9, max_tokens: 64, stop: ["END"] } });
    const body: Record<string, unknown> = { model: "@route/x", temperature: 1, max_completion_tokens: 10, provider: { only: ["beta"] }, messages: [] };
    applyRouteConfig(body, config);
    expect(body.model).toBe(QWEN);
    expect(body.models).toEqual([QWEN, LLAMA]);
    expect(body.provider).toEqual({ sort: "price", zdr: true, only: ["beta"] });
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(["END"]);
    expect(body.max_tokens).toBeUndefined(); // max_completion_tokens already bounds the output
    // An explicit fallback list replaces the route's; defaults are copies, not shared references.
    const explicit: Record<string, unknown> = { model: "@route/x", models: [LLAMA] };
    applyRouteConfig(explicit, config);
    expect(explicit.models).toEqual([LLAMA]);
    (explicit.stop as string[]).push("MUTATED");
    expect(config.params?.stop).toEqual(["END"]);
  });

  test("configs hold sampling controls only: unknown or content-bearing keys are rejected", () => {
    for (const params of [{ system: "You are…" }, { messages: [] }, { prompt: "x" }, { tools: [] }, { response_format: { type: "json_object" } }, { user: "u" }, { temperature: 3 }, { stop: "x".repeat(33) }])
      expect(routeConfigSchema.safeParse({ models: [LLAMA], params }).success).toBe(false);
    for (const provider of [{ private: true }, { sort: "fastest" }, { max_price: { prompt: -1 } }, { order: ["bad slug"] }])
      expect(routeConfigSchema.safeParse({ models: [LLAMA], provider }).success).toBe(false);
    for (const models of [[], Array.from({ length: 9 }, (_, i) => `m/${i}`), [LLAMA, LLAMA], ["@route/other"], ["@ROUTE/other"]]) expect(routeConfigSchema.safeParse({ models }).success).toBe(false);
    expect(routeConfigSchema.safeParse({ models: [LLAMA], prompt: "hello" }).success).toBe(false);
  });

  test("PATCH replaces sections, null clears them, and empty sections are dropped", () => {
    const cur = normalizeConfig({ models: [LLAMA], provider: { zdr: true }, params: { temperature: 0.1 } });
    expect(patchConfig(cur, { params: { top_p: 0.5 } })).toEqual({ models: [LLAMA], provider: { zdr: true }, params: { top_p: 0.5 } });
    expect(patchConfig(cur, { provider: null, models: [QWEN] })).toEqual({ models: [QWEN], params: { temperature: 0.1 } });
    expect(patchConfig(cur, { params: {} })).toEqual({ models: [LLAMA], provider: { zdr: true } });
    expect(patchConfig(cur, undefined)).toBe(cur);
    expect(unknownModels({ resolve: (id: string) => (id === LLAMA ? ({} as never) : null) }, [LLAMA, "x/y"])).toEqual(["x/y"]);
  });
});

describe("Saved Routes API and @route/ resolution", () => {
  let h: Harness;
  let owner: Awaited<ReturnType<Harness["fundedKey"]>>;
  const routes = (auth: Auth, method = "GET", json?: unknown, slug?: string) => h.request("/api/v1/routes" + (slug !== undefined ? "/" + slug : ""), { method, headers: auth, json });
  const create = (auth: Auth, json: unknown) => routes(auth, "POST", json);
  const chat = (auth: Auth, body: Record<string, unknown>) => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { messages: [{ role: "user", content: "hello" }], ...body } });
  const upstream = async (id: "alpha" | "beta") => (await (await fetch(h.mocks[id].url + "/_stats")).json()).lastBody;
  const subKey = async (parent: Auth, json: Record<string, unknown> = {}) => {
    const r = await (await h.request("/api/v1/keys", { method: "POST", headers: parent, json: { name: "sub", ...json } })).json();
    return { hash: r.data.hash as string, auth: { authorization: `Bearer ${r.key}` } };
  };

  beforeAll(async () => {
    h = await startRouter();
    owner = await h.fundedKey(5n);
  });
  afterAll(async () => h.close());

  test("create, read and list: the model alias, defaults and normalized config come back", async () => {
    const r = await create(owner.auth, { slug: "fast-chat", description: "  Cheap first, then Llama. ", config: { models: [QWEN, LLAMA], provider: { sort: "price", zdr: true, max_price: { prompt: 1, completion: 2 } }, params: { temperature: 0.2 } } });
    expect(r.status).toBe(201);
    const { data } = await r.json();
    expect(data).toMatchObject({ slug: "fast-chat", model: "@route/fast-chat", name: "fast-chat", description: "Cheap first, then Llama." });
    expect(data.id).toStartWith("rt_");
    expect(data.config).toEqual({ models: [QWEN, LLAMA], provider: { sort: "price", zdr: true, max_price: { prompt: 1, completion: 2 } }, params: { temperature: 0.2 } });
    const one = await (await routes(owner.auth, "GET", undefined, "fast-chat")).json();
    expect(one.data.id).toBe(data.id);
    const list = await (await routes(owner.auth)).json();
    expect(list.limit).toBe(MAX_ROUTES_PER_ACCOUNT);
    expect(list.data.map((x: { slug: string }) => x.slug)).toEqual(["fast-chat"]);
    for (const slug of ["missing", "Bad_Slug", "x"]) {
      const miss = await routes(owner.auth, "GET", undefined, slug);
      expect(miss.status).toBe(404);
      expect((await miss.json()).error.type).toBe("route_not_found");
    }
    const dup = await create(owner.auth, { slug: "fast-chat", config: { models: [LLAMA] } });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.type).toBe("route_exists");
  });

  test("validation: slug, name, description, models (catalog, count, nesting) and params", async () => {
    const bad: [unknown, string][] = [
      [{ slug: "Upper", config: { models: [LLAMA] } }, "slug"],
      [{ slug: "a", config: { models: [LLAMA] } }, "slug"],
      [{ slug: "-lead", config: { models: [LLAMA] } }, "slug"],
      [{ slug: "a".repeat(49), config: { models: [LLAMA] } }, "slug"],
      [{ slug: "ok-slug", name: "n".repeat(81), config: { models: [LLAMA] } }, "name"],
      [{ slug: "ok-slug", description: "d".repeat(281), config: { models: [LLAMA] } }, "description"],
      [{ slug: "ok-slug", config: { models: [] } }, "config.models"],
      [{ slug: "ok-slug", config: { models: ["@route/fast-chat"] } }, "config.models"],
      [{ slug: "ok-slug", config: { models: [LLAMA], params: { system: "Always answer in French." } } }, "config.params"],
      [{ slug: "ok-slug", config: { models: [LLAMA], params: { top_p: 2 } } }, "config.params.top_p"],
      [{ slug: "ok-slug" }, "config"],
    ];
    for (const [json, path] of bad) {
      const r = await create(owner.auth, json);
      expect(r.status).toBe(400);
      const e = (await r.json()).error;
      expect(e.type).toBe("invalid_request");
      expect(e.message).toContain(path);
    }
    const unknown = await create(owner.auth, { slug: "ok-slug", config: { models: [LLAMA, "acme/not-a-model"] } });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatchObject({ type: "model_not_found", metadata: { unknown_models: ["acme/not-a-model"] } });
    // Routing suffixes of catalog models are accepted.
    expect((await create(owner.auth, { slug: "floor-llama", config: { models: [LLAMA + ":floor"] } })).status).toBe(201);
    expect((await routes(owner.auth, "DELETE", undefined, "floor-llama")).status).toBe(200);
  });

  test("roles: members and viewers read, owners and team admins write", async () => {
    const member = await subKey(owner.auth);
    expect((await routes(member.auth)).status).toBe(200);
    expect((await routes(member.auth, "GET", undefined, "fast-chat")).status).toBe(200);
    for (const [method, json, slug] of [["POST", { slug: "member-route", config: { models: [LLAMA] } }, undefined], ["PATCH", { name: "x" }, "fast-chat"], ["DELETE", undefined, "fast-chat"]] as const) {
      const r = await routes(member.auth, method, json, slug);
      expect(r.status).toBe(403);
      expect((await r.json()).error.type).toBe("forbidden");
    }
    const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "routing" } })).json()).data.id;
    const admin = await subKey(owner.auth, { team });
    const viewer = await subKey(owner.auth, { team });
    await h.request(`/api/v1/teams/${team}/members/${admin.hash}`, { method: "PUT", headers: owner.auth, json: { role: "admin" } });
    await h.request(`/api/v1/teams/${team}/members/${viewer.hash}`, { method: "PUT", headers: owner.auth, json: { role: "viewer" } });
    expect((await routes(viewer.auth)).status).toBe(200);
    expect((await create(viewer.auth, { slug: "viewer-route", config: { models: [LLAMA] } })).status).toBe(403);
    expect((await create(admin.auth, { slug: "team-route", config: { models: [LLAMA] } })).status).toBe(201);
    expect((await routes(admin.auth, "DELETE", undefined, "team-route")).status).toBe(200);
    expect((await routes({})).status).toBe(401);
  });

  test("accounts are isolated: another account neither sees nor calls a route, and may reuse its slug", async () => {
    const other = await h.fundedKey(1n);
    expect((await (await routes(other.auth)).json()).data).toEqual([]);
    for (const method of ["GET", "PATCH", "DELETE"]) expect((await routes(other.auth, method, method === "PATCH" ? { name: "mine" } : undefined, "fast-chat")).status).toBe(404);
    const call = await chat(other.auth, { model: "@route/fast-chat" });
    expect(call.status).toBe(404);
    expect((await call.json()).error.type).toBe("route_not_found");
    expect((await create(other.auth, { slug: "fast-chat", config: { models: [LLAMA] } })).status).toBe(201);
    expect((await (await routes(owner.auth, "GET", undefined, "fast-chat")).json()).data.config.models).toEqual([QWEN, LLAMA]);
  });

  test("PATCH: rename, partial config, clearing a section, conflicts and catalog checks", async () => {
    await create(owner.auth, { slug: "patch-me", name: "Patch me", config: { models: [LLAMA], provider: { zdr: true }, params: { temperature: 0.1 } } });
    await create(owner.auth, { slug: "taken", config: { models: [LLAMA] } });
    let r = await routes(owner.auth, "PATCH", { config: { params: { top_p: 0.5 } }, description: "tuned" }, "patch-me");
    expect(r.status).toBe(200);
    let d = (await r.json()).data;
    expect(d.config).toEqual({ models: [LLAMA], provider: { zdr: true }, params: { top_p: 0.5 } });
    expect(d.description).toBe("tuned");
    expect(d.name).toBe("Patch me");
    r = await routes(owner.auth, "PATCH", { slug: "patched", config: { provider: null, models: [QWEN, LLAMA] } }, "patch-me");
    d = (await r.json()).data;
    expect(d).toMatchObject({ slug: "patched", model: "@route/patched", config: { models: [QWEN, LLAMA], params: { top_p: 0.5 } } });
    expect(d.config.provider).toBeUndefined();
    expect(new Date(d.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(d.created_at).getTime());
    expect((await routes(owner.auth, "GET", undefined, "patch-me")).status).toBe(404);
    const clash = await routes(owner.auth, "PATCH", { slug: "taken" }, "patched");
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.type).toBe("route_exists");
    expect((await routes(owner.auth, "PATCH", { config: { models: ["acme/nope"] } }, "patched")).status).toBe(400);
    expect((await routes(owner.auth, "PATCH", { config: { params: { messages: [] } } }, "patched")).status).toBe(400);
    expect((await routes(owner.auth, "PATCH", { name: "x" }, "nope")).status).toBe(404);
    expect((await routes(owner.auth, "DELETE", undefined, "taken")).status).toBe(200);
  });

  test("an account can save at most 100 routes", async () => {
    const k = await h.newKey();
    const accountId = accountIdFor(k.chainKeyHash);
    const now = new Date();
    await h.ctx.db.insert(savedRoutes).values(Array.from({ length: MAX_ROUTES_PER_ACCOUNT - 1 }, (_, i) => ({ id: `rt_fill_${i}`, accountId, slug: `r-${i}`, name: `r-${i}`, config: { models: [LLAMA] }, createdAt: now, updatedAt: now })));
    expect((await create(k.auth, { slug: "last-one", config: { models: [LLAMA] } })).status).toBe(201);
    const over = await create(k.auth, { slug: "one-too-many", config: { models: [LLAMA] } });
    expect(over.status).toBe(409);
    expect((await over.json()).error).toMatchObject({ type: "route_limit_reached", metadata: { limit: 100 } });
    expect((await (await routes(k.auth)).json()).data.length).toBe(100);
  });

  test("@route/ resolves to the first model, the route's provider prefs and default params", async () => {
    await create(owner.auth, { slug: "tuned", config: { models: [QWEN, LLAMA], provider: { only: ["alpha"], data_collection: "deny" }, params: { temperature: 0.3, max_tokens: 50, stop: ["END"], seed: 7 } } });
    const r = await chat(owner.auth, { model: "@route/tuned" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ model: QWEN, provider: "Alpha", route: "tuned" });
    const sent = await upstream("alpha");
    expect(sent).toMatchObject({ model: "qwen3-32b", temperature: 0.3, max_tokens: 50, stop: ["END"], seed: 7 });
    for (const f of ["provider", "models", "route"]) expect(sent).not.toHaveProperty(f);
    // The receipt binds the request as the caller sent it.
    const gen = (await (await h.request(`/api/v1/generation?id=${j.id}`, { headers: owner.auth })).json()).data;
    expect(gen.model).toBe(QWEN);
  });

  test("explicit request values win: params, provider fields and max_completion_tokens", async () => {
    const r = await chat(owner.auth, { model: "@route/tuned", temperature: 0.9, max_completion_tokens: 20, provider: { only: ["beta"] } });
    expect(r.status).toBe(200);
    const j = await r.json();
    // Beta only serves Llama: the route's fallback list moves the call to its second model.
    expect(j).toMatchObject({ model: LLAMA, provider: "Beta", route: "tuned" });
    const sent = await upstream("beta");
    expect(sent).toMatchObject({ temperature: 0.9, max_completion_tokens: 20, stop: ["END"] });
    expect(sent.max_tokens).toBeUndefined();
  });

  test("the key's allowed_models and guardrails still apply to a route", async () => {
    const llamaOnly = await subKey(owner.auth, { allowed_models: [LLAMA] });
    const r = await chat(llamaOnly.auth, { model: "@route/tuned", provider: { only: ["alpha"] } });
    expect(r.status).toBe(200);
    expect((await r.json()).model).toBe(LLAMA);
    await create(owner.auth, { slug: "qwen-only", config: { models: [QWEN] } });
    const denied = await chat(llamaOnly.auth, { model: "@route/qwen-only" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.type).toBe("model_not_allowed");
    const guarded = await subKey(owner.auth, { guardrails: { deny_patterns: ["forbidden-topic"] } });
    const blocked = await chat(guarded.auth, { model: "@route/tuned", messages: [{ role: "user", content: "tell me about forbidden-topic" }] });
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error.type).toBe("guardrail_blocked");
  });

  test("unknown, anonymous and nested route calls fail clearly", async () => {
    const unknown = await chat(owner.auth, { model: "@route/nope" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toMatchObject({ code: 404, type: "route_not_found" });
    const anonymous = await chat({}, { model: "@route/tuned" });
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.type).toBe("missing_key");
    const nested = await chat(owner.auth, { model: LLAMA, models: ["@route/tuned"] });
    expect(nested.status).toBe(400);
    expect((await nested.json()).error.message).toContain("@route/");
  });

  test("streaming carries the route on the final usage chunk; completions resolve routes too", async () => {
    const s = await sse(await chat(owner.auth, { model: "@route/tuned", stream: true }));
    expect(s.done).toBe(true);
    const last = s.events.at(-1);
    expect(last.usage.cost).toBeGreaterThan(0);
    expect(last.route).toBe("tuned");
    expect(s.events.every((e: { model: string }) => e.model === QWEN)).toBe(true);
    const c = await h.request("/api/v1/completions", { method: "POST", headers: owner.auth, json: { model: "@route/tuned", prompt: "Once upon" } });
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ object: "text_completion", model: QWEN, route: "tuned" });
  });

  test("a cached route response is never replayed to an equivalent direct request", async () => {
    const cache = { mode: "exact" };
    const content = "cache this routed call";
    await chat(owner.auth, { model: "@route/tuned", cache, messages: [{ role: "user", content }] });
    const hit = await chat(owner.auth, { model: "@route/tuned", cache, messages: [{ role: "user", content }] });
    expect(hit.headers.get("x-anyroute-cache")).toBe("hit");
    expect((await hit.json()).route).toBe("tuned");
    const direct = await chat(owner.auth, { model: QWEN, models: [QWEN, LLAMA], provider: { only: ["alpha"], data_collection: "deny" }, temperature: 0.3, max_tokens: 50, stop: ["END"], seed: 7, cache, messages: [{ role: "user", content }] });
    expect(direct.status).toBe(200);
    expect(direct.headers.get("x-anyroute-cache")).toBeNull();
    expect(await direct.json()).not.toHaveProperty("route");
  });

  test("LiteLLM key presets keep working, can point at a route, and rank below it for provider prefs", async () => {
    const k = await h.fundedKey(1n);
    await create(k.auth, { slug: "alpha-first", config: { models: [LLAMA], provider: { only: ["alpha"] } } });
    await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { routing: { aliases: { fast: { model: LLAMA }, prod: { model: "@route/alpha-first" } }, provider: { only: ["beta"] } } } });
    const plain = await (await chat(k.auth, { model: "fast" })).json();
    expect(plain).toMatchObject({ model: LLAMA, provider: "Beta" }); // the key default applies without a route
    expect(plain).not.toHaveProperty("route");
    expect(await (await chat(k.auth, { model: "@route/alpha-first" })).json()).toMatchObject({ provider: "Alpha", route: "alpha-first" });
    expect(await (await chat(k.auth, { model: "prod" })).json()).toMatchObject({ provider: "Alpha", route: "alpha-first" });
  });

  test("delete: the route is gone and calls to it fail; stored configs hold no message text", async () => {
    const rows = await h.ctx.db.select().from(savedRoutes).where(eq(savedRoutes.slug, "tuned"));
    expect(JSON.stringify(rows)).not.toContain("hello");
    expect(JSON.stringify(rows)).not.toContain("cache this routed call");
    const del = await routes(owner.auth, "DELETE", undefined, "tuned");
    expect(await del.json()).toEqual({ data: { slug: "tuned", model: "@route/tuned", deleted: true } });
    expect((await routes(owner.auth, "DELETE", undefined, "tuned")).status).toBe(404);
    expect((await chat(owner.auth, { model: "@route/tuned" })).status).toBe(404);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });
});
