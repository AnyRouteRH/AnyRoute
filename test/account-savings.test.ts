import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Catalog, type Candidate, type ModelRow } from "../src/catalog/catalog.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { generations, keys, teamMembers } from "../src/db/schema.ts";
import { HealthTracker } from "../src/services/health.ts";
import { savingsQuery } from "../src/savings/query.ts";
import { savingsSuggestion, sameTokenCost, type SavingsMix } from "../src/savings/suggest.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

const mix: SavingsMix = { model: "source", calls: "2", tokens_in: "1000000", tokens_out: "1000000", charged_pico: "7400000000000", max_tokens: 1000, max_output: 500, safe: true, lanes: ["public"], disclosures: ["vendor-forwarded"] };
function fixture() {
  const catalog = new Catalog(null as never), health = new HealthTracker();
  const ctx = { catalog, health, cfg: loadConfig({ ANYROUTE_ENV: "test" }) } as Ctx;
  function add(id: string, prompt = 2000000n, completion = 4000000n) {
    const model = { id, name: id.toUpperCase(), ctx: 128000, maxOut: 8000, hidden: false, arch: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] } } as ModelRow;
    const offer = { modelId: id, providerId: id, providerModelId: id, status: "live", pricePrompt: prompt, priceCompletion: completion,
      priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, ctx: 128000, maxOut: 8000, supportedParameters: ["tools", "response_format"],
      provider: { id, status: "live", dataPolicy: {} } } as Candidate;
    catalog.models.set(id, model); catalog.offersByModel.set(id, [offer]); return { model, offer };
  }
  add("source"); return { ctx, add, catalog, health };
}
test("exact estimate maths includes input, output and request rates, independent of historical charges", () => {
  const { ctx, add } = fixture();
  const { offer } = add("cheaper", 1000000n, 2000000n); offer.priceRequest = 50000000000n;
  expect(sameTokenCost(offer, mix)).toBe(3100000000000n);
  expect(savingsSuggestion(ctx, mix)).toMatchObject({ charged_usd: "7.4", alternative: { model: "cheaper", estimated_cost_usd: "3.1", estimated_saving_usd: "4.3" } });
  expect(sameTokenCost({ ...offer, pricePrompt: 7n, priceCompletion: 11n, priceRequest: 3n }, { ...mix, tokens_in: "900719925474099300", tokens_out: "1", calls: "2" })).toBe(6305039478318695117n);
});
test("preserves image input/output, tools and full long context on a single endpoint; missing metadata skips", () => {
  const { ctx, add, catalog } = fixture();
  add("no-images", 1n, 1n).model.arch = { input_modalities: ["text"], output_modalities: ["text", "image"] };
  add("no-image-output", 1n, 1n).model.arch = { input_modalities: ["text", "image"], output_modalities: ["text"] };
  add("no-tools", 1n, 1n).offer.supportedParameters = ["response_format"];
  add("short", 1n, 1n).offer.ctx = 64000;
  add("short-output", 1n, 1n).offer.maxOut = 100;
  add("unknown", 1n, 1n).model.arch = {};
  add("audio", 1n, 1n).model.arch = { input_modalities: ["text"], output_modalities: ["audio"] };
  const separate = add("separate", 1n, 1n); separate.offer.supportedParameters = [];
  catalog.offersByModel.set("separate", [separate.offer, { ...separate.offer, providerId: "other", supportedParameters: ["tools", "response_format"], status: "disabled" }]);
  expect(savingsSuggestion(ctx, mix)).toBeNull();
  add("match", 1000000n, 2000000n); expect(savingsSuggestion(ctx, mix)?.alternative.model).toBe("match");
  catalog.models.get("source")!.arch = {}; expect(savingsSuggestion(ctx, mix)).toBeNull();
});
test("closest cheaper price uses today's source rates and actual charges, with live eligibility and key restrictions", () => {
  const { ctx, add, health } = fixture();
  add("cheap", 1000000n, 1000000n); add("closest", 2000000n, 3000000n);
  add("same", 2000000n, 4000000n); add("more", 3000000n, 4000000n);
  add("hidden", 2500000n, 2500000n).model.hidden = true;
  add("disabled", 2500000n, 2500000n).offer.provider.status = "disabled";
  add("down", 2500000n, 2500000n); health.record({ modelId: "down", providerId: "down", ok: false, errorKind: "connection", source: "probe" });
  expect(savingsSuggestion(ctx, mix)?.alternative.model).toBe("closest");
  expect(savingsSuggestion(ctx, mix, new Set(["cheap"]))?.alternative.model).toBe("cheap");
  expect(savingsSuggestion(ctx, mix, new Set(["source"]))).toBeNull();
  expect(savingsSuggestion(ctx, { ...mix, charged_pico: "1" })).toBeNull();
  expect(savingsSuggestion(ctx, { ...mix, safe: false })).toBeNull();
  expect(savingsSuggestion(ctx, { ...mix, tokens_in: "0", tokens_out: "0" })).toBeNull();
  expect(savingsSuggestion(ctx, { ...mix, lanes: ["attested"], disclosures: ["attested"] })).toBeNull();
  expect(savingsSuggestion(ctx, { ...mix, lanes: ["unknown"] })).toBeNull();
  expect(savingsSuggestion(ctx, { ...mix, disclosures: ["unknown"] })).toBeNull();
});
test("extra media/search rates and missing source context or audio omit uncertain comparisons", () => {
  const { ctx, add, catalog } = fixture();
  const c = add("cheaper", 1n, 1n); c.offer.priceImage = 1n; expect(savingsSuggestion(ctx, mix)).toBeNull();
  c.offer.priceImage = 0n; c.offer.priceWebSearch = 1n; expect(savingsSuggestion(ctx, mix)).toBeNull();
  c.offer.priceWebSearch = 0n;
  catalog.offers("source")[0].maxOut = 30000;
  c.offer.maxOut = null; c.model.maxOut = null;
  expect(savingsSuggestion(ctx, { ...mix, max_output: 20000 })).toBeNull(); // Router defaults to at most 16,384 output tokens.
  c.offer.maxOut = 30000;
  expect(savingsSuggestion(ctx, { ...mix, max_output: 20000 })?.alternative.model).toBe("cheaper");
  catalog.offers("source")[0].ctx = 0; expect(savingsSuggestion(ctx, mix)).toBeNull();
  catalog.offers("source")[0].ctx = 128000;
  catalog.models.get("source")!.arch = { input_modalities: ["text", "audio"], output_modalities: ["text"] }; expect(savingsSuggestion(ctx, mix)).toBeNull();
});
test("rolling UTC range defaults to 30 and rejects malformed or unbounded days", () => {
  expect(savingsQuery({}, new Date("2026-10-12T12:00:00Z"))).toEqual({ days: 30, from: "2026-09-12T12:00:00.000Z", to: "2026-10-12T12:00:00.000Z" });
  expect(savingsQuery({ days: "1" }, new Date("2026-10-12T12:00:00Z")).from).toBe("2026-10-11T12:00:00.000Z");
  for (const days of ["0", "31", "1.5", "03", "", "bad"]) expect(() => savingsQuery({ days })).toThrow();
});

let h: Harness;
beforeAll(async () => { h = await startRouter(); });
afterAll(async () => { await h?.close(); });
type Key = { hash: string; auth: Record<string, string> };
async function child(owner: Key) {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Savings key" } });
  expect(r.status).toBe(201); const j = await r.json(); return { hash: j.data.hash, auth: { authorization: "Bearer " + j.key } };
}
async function call(key: Key, id: string, extra: Partial<typeof generations.$inferInsert> = {}) {
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.insert(generations).values({ id, keyHash: key.hash, accountId: k.accountId, modelId: MODELS.qwen.slug, providerId: "alpha", mode: "prepaid",
    ts: new Date(Date.now() - 86400000), tokensIn: 1000, tokensOut: 500, cost: 1000000000n, receipt: { lane: "public", disclosure: "vendor-forwarded" }, ...extra });
}
async function read(key: Key) {
  const r = await h.request("/api/v1/account/savings?days=30", { headers: key.auth });
  expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); return r.json();
}
test("account/own-key scopes, charged-only range and no cross-account leakage, including deleted keys", async () => {
  const owner = await h.fundedKey(), agent = await child(owner), other = await h.fundedKey();
  await call(owner, "savings-owner"); await call(agent, "savings-agent"); await call(other, "savings-other", { cost: 999000000000n });
  await call(owner, "savings-free", { cost: 0n }); await call(owner, "savings-old", { ts: new Date(Date.now() - 31 * 86400000) });
  await call(owner, "savings-future", { ts: new Date(Date.now() + 86400000) });
  await call(owner, "savings-corrupt-account", { accountId: (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, other.hash)))[0].accountId });
  const r = await read(owner);
  expect(r.scope).toBe("account"); expect(r.models).toHaveLength(1);
  expect(r.models[0]).toMatchObject({ calls: "2", tokens_in: "2000", tokens_out: "1000", charged_usd: "0.002", alternative: { model: MODELS.llama.slug, estimated_cost_usd: "0.00052", estimated_saving_usd: "0.00148" } });
  expect((await read(agent))).toMatchObject({ scope: "key", models: [{ calls: "1", charged_usd: "0.001" }] });
  expect((await read(other)).models[0].charged_usd).toBe("1"); // Account-stamped records follow Activity visibility.
  for (const hash of [owner.hash, agent.hash, other.hash]) expect(JSON.stringify(r)).not.toContain(hash);
  await h.ctx.db.delete(keys).where(eq(keys.keyHash, agent.hash)); expect((await read(owner)).models[0].calls).toBe("2");
});
test("Activity team call visibility and sessions cannot expand into account scope", async () => {
  const owner = await h.fundedKey(), admin = await child(owner), sameTeam = await child(owner), otherTeam = await child(owner);
  for (const key of [admin, sameTeam]) await h.ctx.db.update(keys).set({ teamId: "savings-team" }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.update(keys).set({ teamId: "savings-other-team" }).where(eq(keys.keyHash, otherTeam.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "savings-team", keyHash: admin.hash, role: "admin" });
  await call(sameTeam, "savings-team-call"); await call(otherTeam, "savings-other-team-call");
  expect(await read(admin)).toMatchObject({ scope: "account", models: [{ calls: "2" }] });
  expect(await read(sameTeam)).toMatchObject({ scope: "key", models: [{ calls: "1" }] });
  const response = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } });
  expect(response.status).toBe(201); const session = (await response.json()).data;
  const sk = { hash: session.key_hash, auth: { authorization: "Bearer " + session.key } };
  await call(sk, "savings-session"); await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, sk.hash));
  expect(await read(sk)).toMatchObject({ scope: "key", models: [{ calls: "1" }] });
});
test("auth, validation, no records and default/off spend switch; read-only scope remains refused", async () => {
  expect(h.ctx.cfg.spendInsightsEnabled).toBe(false);
  expect((await h.request("/api/v1/account/savings")).status).toBe(401);
  expect((await h.request("/api/v1/account/savings", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
  const owner = await h.fundedKey(); expect(await read(owner)).toMatchObject({ days: 30, models: [] });
  for (const days of ["0", "31", "bad"]) expect((await h.request("/api/v1/account/savings?days=" + days, { headers: owner.auth })).status).toBe(400);
  const ordinary = await child(owner); await h.ctx.db.update(keys).set({ scope: "read" }).where(eq(keys.keyHash, ordinary.hash));
  expect((await h.request("/api/v1/account/savings", { headers: ordinary.auth })).status).toBe(403);
  await h.ctx.db.update(keys).set({ scope: null, disabled: true }).where(eq(keys.keyHash, ordinary.hash));
  expect((await h.request("/api/v1/account/savings", { headers: ordinary.auth })).status).toBe(401);
  await h.ctx.db.update(keys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(keys.keyHash, owner.hash));
  expect((await h.request("/api/v1/account/savings", { headers: owner.auth })).status).toBe(401);
});
test("unsafe records omit the whole model; no cheaper match and model restrictions omit it too", async () => {
  for (const [i, extra] of [{ receipt: {} }, { cachedTokens: 1 }, { reasoningTokens: 1 }, { cacheWriteTokens: 1 }, { mode: "cache" }, { isByok: true }, { private: true }].entries()) {
    const owner = await h.fundedKey(); await call(owner, "savings-safe-" + i); await call(owner, "savings-unsafe-" + i, extra);
    expect((await read(owner)).models).toEqual([]);
  }
  const cheapest = await h.fundedKey(); await call(cheapest, "savings-cheapest", { modelId: MODELS.llama.slug }); expect((await read(cheapest)).models).toEqual([]);
  const owner = await h.fundedKey(), agent = await child(owner); await call(agent, "savings-restricted");
  await h.ctx.db.update(keys).set({ allowedModels: [MODELS.qwen.slug] }).where(eq(keys.keyHash, agent.hash)); expect((await read(agent)).models).toEqual([]);
});
