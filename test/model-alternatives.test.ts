import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Candidate, ModelRow } from "../src/catalog/catalog.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { providers } from "../src/db/schema.ts";
import { ApiError } from "../src/lib/errors.ts";
import { addSuggestions, requiredAbilities, suggestions, type SuggestionInput } from "../src/model-alternatives/suggest.ts";
import { runUpstreamMonitor } from "../src/rush/monitor.ts";
import { HealthTracker } from "../src/services/health.ts";
import { MODELS, startRouter } from "./helpers.ts";

function fixture() {
  const catalog = new Catalog(null as never);
  const health = new HealthTracker();
  const ctx = { catalog, health, cfg: loadConfig({ ANYROUTE_ENV: "test" }) } as Ctx;
  function add(id: string, prompt = 100n, completion = 200n, tags = ["vision", "tools"], live = true) {
    const model = { id, name: id.toUpperCase(), hidden: false, ctx: 128000, arch: { input_modalities: tags.includes("vision") ? ["text", "image"] : ["text"], output_modalities: ["text"] } } as ModelRow;
    catalog.models.set(id, model);
    const offer = { modelId: id, providerId: id + "-provider", providerModelId: id, pricePrompt: prompt, priceCompletion: completion, priceRequest: 0n, status: "live", supportedParameters: tags.includes("tools") ? ["tools", "response_format"] : [], ctx: 128000,
      provider: { id: id + "-provider", status: live ? "live" : "disabled", dataPolicy: {} } } as Candidate;
    catalog.offersByModel.set(id, [offer]);
    return model;
  }
  const source = add("source");
  const body = { model: "source", messages: [{ role: "user", content: [{ type: "text", text: "Describe this." }, { type: "image_url", image_url: { url: "https://image.example/picture.jpg" } }] }], tools: [{ type: "function", function: { name: "read" } }], max_tokens: 100 };
  const input: SuggestionInput = { resolved: [{ model: source, modifiers: new Set() }], body, prefs: {}, params: ["tools", "max_tokens"], promptTokens: 20, byok: new Map(), allowed: new Set() };
  return { ctx, input, add, health, catalog };
}

test("request needs include images and tools, tool history, audio and image output", () => {
  expect(requiredAbilities(fixture().input.body)).toEqual(["vision", "tools"]);
  expect(requiredAbilities({ messages: [{ role: "tool", content: "result" }, { role: "user", content: [{ type: "input_audio" }] }], modalities: ["image"] })).toEqual(["tools", "audio", "imageOut"]);
});

test("healthy same-offer capabilities only; distinct models ranked by closest token-weighted cost, up to three", () => {
  const { ctx, input, add, health, catalog } = fixture();
  add("closest", 101n, 201n); add("cheaper", 90n, 180n); add("expensive", 200n, 400n); add("fourth", 300n, 600n);
  add("no-images", 100n, 200n, ["tools"]); add("no-tools", 100n, 200n, ["vision"]); add("disabled", 100n, 200n, ["vision", "tools"], false);
  add("down"); health.record({ modelId: "down", providerId: "down-provider", ok: false, errorKind: "connection", source: "probe" });
  const separate = add("separate"); const offer = catalog.offers(separate.id)[0];
  catalog.offersByModel.set(separate.id, [{ ...offer, supportedParameters: [] }, { ...offer, providerId: "other", provider: { ...offer.provider, id: "other" }, supportedParameters: ["tools"], status: "disabled" }]);
  const rows = suggestions(ctx, input);
  expect(rows.map(r => r.id)).toEqual(["closest", "cheaper", "expensive"]);
  expect(rows[0]).toMatchObject({ name: "CLOSEST", prompt_price: "0.000000000101", completion_price: "0.000000000201", why: "Same abilities: reads images, uses tools" });
  input.allowed = new Set(["source", "cheaper"]);
  expect(suggestions(ctx, input).map(r => r.id)).toEqual(["cheaper"]);
});

test("no matching model gives an empty list; source never suggested", () => {
  const { ctx, input, add } = fixture();
  expect(suggestions(ctx, input)).toEqual([]);
  add("text", 100n, 200n, []);
  expect(suggestions(ctx, input)).toEqual([]);
});

test("availability alone is additive; preferences, strict lanes, rate limits and client failures stay byte-identical", () => {
  const { ctx, input, add, health } = fixture(); add("alternative");
  const error = () => new ApiError(404, "Original message", "no_providers", { excluded: [] });
  health.record({ modelId: "source", providerId: "source-provider", ok: false, errorKind: "connection", source: "probe" });
  const decorated = addSuggestions(error(), ctx, input).toJSON();
  expect(decorated).toMatchObject({ error: { code: 404, message: "Original message", type: "no_providers", metadata: { excluded: [] } }, suggested_models: [{ id: "alternative" }] });
  for (const prefs of [{ only: ["missing"] }, { lane: "attested" as const }, { disclosure: "none" as const }, { private: true }, { max_price: { prompt: 0 } }]) {
    const original = error(); const bytes = JSON.stringify(original.toJSON());
    expect(JSON.stringify(addSuggestions(original, ctx, { ...input, prefs }).toJSON())).toBe(bytes);
  }
  for (const type of ["invalid_request", "model_not_allowed", "rate_limited", "agent_policy_denied", "provider_rejected", "no_attested_endpoint"]) {
    const original = new ApiError(403, "Refused", type);
    expect(addSuggestions(original, ctx, input).toJSON()).toEqual(original.toJSON());
  }
  for (const error_kind of ["rejected", "rate_limited", "provider_auth"]) {
    expect(addSuggestions(new ApiError(502, "Failed", "providers_unavailable"), ctx, input, [{ model: "source", provider: "source-provider", ok: false, error_kind } as never]).toJSON()).not.toHaveProperty("suggested_models");
  }
});

test("text requests do not require unused vision/tools; hidden, embedding-only and short-context models are excluded", () => {
  const { ctx, input, add, catalog } = fixture();
  input.body = { messages: [{ role: "user", content: "hello" }], max_tokens: 100 }; input.params = [];
  const text = add("text", 101n, 200n, []);
  add("hidden").hidden = true;
  add("embedding").arch = { input_modalities: ["text"], output_modalities: ["embeddings"] };
  add("short"); catalog.offers("short")[0].ctx = 100;
  expect(suggestions(ctx, input).map(m => m.id)).toEqual([text.id]);
});

const chatBody = { model: MODELS.qwen.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 32 };
const paths = ["/api/v1/chat/completions", "/api/v1/responses", "/v1/messages"];
function requestBody(path: string, stream = false) {
  return path.endsWith("responses") ? { model: MODELS.qwen.slug, input: "hello", max_output_tokens: 32, stream }
    : path.endsWith("messages") ? { ...chatBody, stream } : { ...chatBody, stream };
}

test("no-route suggestions reach chat, Responses and Messages with existing auth and errors; no funds charged", async () => {
  const h = await startRouter();
  try {
    const key = await h.fundedKey();
    await h.ctx.db.update(providers).set({ status: "disabled" }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    for (const path of paths) {
      const rejected = await h.request(path, { method: "POST", headers: { authorization: "Bearer invalid" }, json: requestBody(path) });
      expect(rejected.status).toBe(401); expect(await rejected.json()).not.toHaveProperty("suggested_models");
      const res = await h.request(path, { method: "POST", headers: key.auth, json: requestBody(path) });
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json.error.message).toBe("No providers match this request's model and routing preferences.");
      expect(json.suggested_models.map((m: any) => m.id)).toEqual([MODELS.llama.slug]);
    }
    const empty = await h.request(paths[0], { method: "POST", headers: key.auth, json: { ...chatBody, provider: { only: ["missing"] } } });
    expect(await empty.json()).not.toHaveProperty("suggested_models");
    const lane = await h.request(paths[0], { method: "POST", headers: { ...key.auth, "x-anyroute-lane": "attested" }, json: chatBody });
    expect(await lane.json()).not.toHaveProperty("suggested_models");
    const bad = await h.request(paths[0], { method: "POST", headers: key.auth, json: { ...chatBody, messages: [] } });
    expect(bad.status).toBe(400); expect(await bad.json()).not.toHaveProperty("suggested_models");
    const balance = await h.request("/api/v1/credits", { headers: key.auth });
    expect((await balance.json() as any).data.total_usage).toBe(0);
  } finally { await h.close(); }
});

test("runtime exhaustion and stream failures carry suggestions through shared adapters", async () => {
  const h = await startRouter({ providers: [
    { id: "alpha", name: "Alpha", models: [MODELS.qwen], behaviour: "error500" },
    { id: "beta", name: "Beta", models: [MODELS.llama] },
  ] });
  try {
    const key = await h.fundedKey();
    for (const path of paths) {
      // Reset health so each request exercises routing exhaustion rather than preselection.
      h.ctx.health = new HealthTracker();
      const res = await h.request(path, { method: "POST", headers: key.auth, json: requestBody(path, true) });
      if (path.endsWith("messages")) {
        expect(res.status).toBe(502); expect((await res.json() as any).suggested_models[0].id).toBe(MODELS.llama.slug);
      } else {
        expect(res.status).toBe(200);
        const events = (await res.text()).split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)));
        const error = events.find((e: any) => e.error || e.type === "error");
        expect(error.suggested_models[0].id).toBe(MODELS.llama.slug);
      }
    }
    h.ctx.health = new HealthTracker();
    const res = await h.request(paths[0], { method: "POST", headers: key.auth, json: chatBody });
    expect(res.status).toBe(502); expect((await res.json() as any).suggested_models[0].id).toBe(MODELS.llama.slug);
  } finally { await h.close(); }
});

test("success, rejected requests and rate-limited providers receive no suggestions", async () => {
  const h = await startRouter();
  try {
    const key = await h.fundedKey();
    for (const behaviour of ["ok", "reject400", "rate429"]) {
      await fetch(h.mocks.alpha.url + "/_control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behaviour }) });
      h.ctx.health = new HealthTracker();
      const res = await h.request(paths[0], { method: "POST", headers: key.auth, json: chatBody });
      expect(res.status).toBe(behaviour === "ok" ? 200 : behaviour === "reject400" ? 400 : 502);
      expect(await res.json()).not.toHaveProperty("suggested_models");
    }
  } finally { await h.close(); }
});

test("a healthy unattempted route suppresses suggestions, as do rate-limit health outages", () => {
  const { ctx, input, add, health, catalog } = fixture(); add("alternative");
  const offer = catalog.offers("source")[0];
  catalog.offersByModel.set("source", [offer, { ...offer, providerId: "unattempted", provider: { ...offer.provider, id: "unattempted" } }]);
  const original = new ApiError(502, "Failed", "providers_unavailable");
  expect(addSuggestions(original, ctx, input, [{ model: "source", provider: "source-provider", ok: false, error_kind: "connection" } as never]).toJSON()).not.toHaveProperty("suggested_models");
  catalog.offersByModel.set("source", [offer]);
  health.record({ modelId: "source", providerId: "source-provider", ok: false, errorKind: "rate_limited", source: "probe" });
  expect(addSuggestions(original, ctx, input).toJSON()).not.toHaveProperty("suggested_models");
});

test("empty availability suggestions and current health outage are returned without a new worker or flag", async () => {
  const h = await startRouter();
  try {
    expect(h.ctx.cfg.rush.enabled).toBe(false);
    const key = await h.fundedKey();
    h.ctx.health.record({ modelId: MODELS.qwen.slug, providerId: "alpha", ok: false, errorKind: "connection", source: "probe" });
    let res = await h.request(paths[0], { method: "POST", headers: key.auth, json: chatBody });
    expect(res.status).toBe(404);
    expect((await res.json() as any).suggested_models[0].id).toBe(MODELS.llama.slug);
    h.ctx.health.record({ modelId: MODELS.llama.slug, providerId: "alpha", ok: false, errorKind: "connection", source: "probe" });
    h.ctx.health.record({ modelId: MODELS.llama.slug, providerId: "beta", ok: false, errorKind: "connection", source: "probe" });
    res = await h.request(paths[0], { method: "POST", headers: key.auth, json: chatBody });
    expect(res.status).toBe(404); expect((await res.json() as any).suggested_models).toEqual([]);
  } finally { await h.close(); }
});

test("provider account with no credit preserves its 503 and offers a healthy alternative", async () => {
  const h = await startRouter({ env: { UPSTREAM_MONITOR_ENABLED: "true", UPSTREAM_BALANCE_URL: "https://relay.example/balance" } });
  try {
    const key = await h.fundedKey();
    await h.ctx.db.update(providers).set({ baseUrl: "https://relay.example/v1" }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: 0 }));
    const res = await h.request(paths[0], { method: "POST", headers: key.auth, json: chatBody });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 503, type: "providers_unavailable", message: "Providers are temporarily unavailable." }, suggested_models: [{ id: MODELS.llama.slug }] });
  } finally { await h.close(); }
});

test("explicit image-only output matches without requiring unused text output", () => {
  const { ctx, input, add } = fixture();
  input.resolved[0].model.arch = { input_modalities: ["text"], output_modalities: ["image"] };
  input.body = { messages: [{ role: "user", content: "Draw a tree" }], modalities: ["image"], max_tokens: 100 };
  input.params = [];
  add("image-only", 101n, 200n, []).arch = { input_modalities: ["text"], output_modalities: ["image"] };
  add("text-only", 100n, 200n, []);
  expect(suggestions(ctx, input).map(m => m.id)).toEqual(["image-only"]);
});
