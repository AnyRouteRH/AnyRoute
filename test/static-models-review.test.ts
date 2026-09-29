import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { kv, offers, providers } from "../src/db/schema.ts";
import { encrypt } from "../src/lib/util.ts";
import { runRegistry } from "../src/services/registry.ts";
import { diffStaticModels, pendingKey, staticModelsDigest, staticModelsReviewHash } from "../src/providers/static-models.ts";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";

// The model list of a provider that is already approved changes in two steps: providers.proposeStaticModels stores a
// candidate and returns a review hash; providers.approveStaticModels applies it only for that hash.

const admin = { "x-admin-token": ADMIN };
const spec = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  anyroute: { slug: id },
  input_modalities: ["text"],
  output_modalities: ["text"],
  context_length: 32768,
  max_completion_tokens: 4096,
  pricing: { prompt: "0.000001", completion: "0.000002" },
  ...over,
});
const CHAT = spec("acme/chat-a");
const OLD = spec("acme/chat-old");
const VISION = spec("acme/vision-a", { input_modalities: ["text", "image"] });
const EMBED = spec("acme/embed-a", { output_modalities: ["embeddings"], context_length: 8192, max_completion_tokens: undefined, pricing: { prompt: "0.00000001", completion: "0" } });

let h: Harness;
beforeAll(async () => {
  h = await startRouter({ providers: [{ id: "vendor", name: "Vendor", models: [MODELS.llama] }] });
  const base = { name: "Live gateway", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "k"), dataPolicy: { training: false, retains_prompts: false, zdr: true } };
  await h.ctx.db.insert(providers).values({ id: "live-gw", ...base, status: "live", staticModels: [CHAT, OLD] });
  await h.ctx.db.insert(providers).values({ id: "pending-gw", ...base, status: "applied", staticModels: [CHAT] });
  await runRegistry(h.ctx);
});
afterAll(async () => h.close());

const call = (proc: string, json: unknown, headers: Record<string, string> = admin) => h.request(`/trpc/${proc}`, { method: "POST", headers, json });
const data = async (res: Response) => ((await res.json()) as any).result?.data;
const errorOf = async (res: Response) => ((await res.json()) as any).error?.message as string;
const query = async (proc: string, input: unknown) => (await h.request(`/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: admin })).json() as Promise<any>;
const row = async (id = "live-gw") => (await h.ctx.db.select().from(providers).where(eq(providers.id, id)))[0];
const listedIds = async () => ((await (await h.request("/api/v1/models")).json()) as { data: { id: string }[] }).data.map((m) => m.id);

describe("a live provider's model list changes only through a reviewed proposal", () => {
  test("setStaticModels still works only while the application is pending", async () => {
    const live = await call("providers.setStaticModels", { id: "live-gw", models: [CHAT] });
    expect(live.status).toBe(409);
    expect(await errorOf(live)).toContain("only while the application is pending");
    expect(((await row()).staticModels as any[]).map((m) => m.id)).toEqual(["acme/chat-a", "acme/chat-old"]);
  });
  test("both steps need the operator token, and a pending application uses setStaticModels instead", async () => {
    expect((await call("providers.proposeStaticModels", { id: "live-gw", models: [CHAT] }, {})).status).toBe(401);
    expect((await call("providers.approveStaticModels", { id: "live-gw", review_hash: "a".repeat(64) }, {})).status).toBe(401);
    expect((await call("providers.proposeStaticModels", { id: "no-such", models: [CHAT] })).status).toBe(404);
    const pending = await call("providers.proposeStaticModels", { id: "pending-gw", models: [CHAT, VISION] });
    expect(pending.status).toBe(409);
    expect(await errorOf(pending)).toContain("providers.setStaticModels");
    expect((await call("providers.approveStaticModels", { id: "pending-gw", review_hash: "a".repeat(64) })).status).toBe(409);
  });
  test("an invalid list, a repeated id or an unchanged list is refused and nothing is stored", async () => {
    expect((await call("providers.proposeStaticModels", { id: "live-gw", models: [{ id: "x" }] })).status).toBe(400);
    const dup = await call("providers.proposeStaticModels", { id: "live-gw", models: [CHAT, CHAT] });
    expect(dup.status).toBe(400);
    expect(await errorOf(dup)).toContain("listed twice");
    const same = await call("providers.proposeStaticModels", { id: "live-gw", models: [CHAT, OLD] });
    expect(same.status).toBe(400);
    expect(await errorOf(same)).toContain("already in force");
    expect((await h.ctx.db.select().from(kv).where(eq(kv.key, pendingKey("live-gw")))).length).toBe(0);
  });

  test("a proposal serves nothing until it is approved, and the review shows exactly what would change", async () => {
    const proposed = [spec("acme/chat-a", { pricing: { prompt: "0.000002", completion: "0.000002" } }), VISION, EMBED];
    const res = await call("providers.proposeStaticModels", { id: "live-gw", models: proposed });
    expect(res.status).toBe(200);
    const p = await data(res);
    expect(p).toMatchObject({ id: "live-gw", status: "live", models: 3 });
    expect(p.reviewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.diff).toMatchObject({ current_models: 2, proposed_models: 3, removed: ["acme/chat-old"], unchanged: 0 });
    expect(p.diff.added.map((m: any) => m.id).sort()).toEqual(["acme/embed-a", "acme/vision-a"]);
    expect(p.diff.added.find((m: any) => m.id === "acme/embed-a")).toMatchObject({ output_modalities: ["embeddings"], pricing: { prompt: "0.00000001", completion: "0" } });
    expect(p.diff.added.find((m: any) => m.id === "acme/vision-a")).toMatchObject({ input_modalities: ["text", "image"] });
    expect(p.diff.changed).toEqual([{ id: "acme/chat-a", fields: { pricing: { from: { prompt: "0.000001", completion: "0.000002" }, to: { prompt: "0.000002", completion: "0.000002" } } } }]);

    // Nothing that serves changed: the list in force, the catalogue and the offers are as before.
    expect(((await row()).staticModels as any[]).map((m) => m.id)).toEqual(["acme/chat-a", "acme/chat-old"]);
    await h.ctx.catalog.refresh();
    expect(await listedIds()).not.toContain("acme/vision-a");
    expect(await listedIds()).toContain("acme/chat-old");

    // The operator can read the pending list back, with the hash to approve.
    const review = (await query("providers.reviewStaticModels", { id: "live-gw" })).result.data;
    expect(review).toMatchObject({ pending: true, reviewHash: p.reviewHash, diff: p.diff });
    expect(review.models.map((m: any) => m.id)).toEqual(["acme/chat-a", "acme/vision-a", "acme/embed-a"]);
    expect(await query("providers.reviewStaticModels", { id: "vendor" }).then((r) => r.result.data)).toEqual({ id: "vendor", pending: false });
  });

  test("a wrong or malformed hash is refused and the list in force stays", async () => {
    const wrong = await call("providers.approveStaticModels", { id: "live-gw", review_hash: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect(await errorOf(wrong)).toContain("changed after it was reviewed");
    expect((await call("providers.approveStaticModels", { id: "live-gw", review_hash: "nope" })).status).toBe(400);
    expect(((await row()).staticModels as any[]).map((m) => m.id)).toEqual(["acme/chat-a", "acme/chat-old"]);
  });

  test("a newer proposal replaces the older one and its hash: the old approval is refused", async () => {
    const first = await data(await call("providers.proposeStaticModels", { id: "live-gw", models: [CHAT, VISION] }));
    const second = await data(await call("providers.proposeStaticModels", { id: "live-gw", models: [CHAT, VISION, EMBED] }));
    expect(second.reviewHash).not.toBe(first.reviewHash);
    expect((await call("providers.approveStaticModels", { id: "live-gw", review_hash: first.reviewHash })).status).toBe(409);
    expect(((await row()).staticModels as any[]).length).toBe(2);
  });

  test("the hash also covers the provider as reviewed: a changed application or list in force refuses it", async () => {
    const p = await data(await call("providers.proposeStaticModels", { id: "live-gw", models: [CHAT, VISION, EMBED] }));
    await h.ctx.db.update(providers).set({ baseUrl: "http://127.0.0.1:2/v1" }).where(eq(providers.id, "live-gw"));
    expect((await call("providers.approveStaticModels", { id: "live-gw", review_hash: p.reviewHash })).status).toBe(409);
    await h.ctx.db.update(providers).set({ baseUrl: "http://127.0.0.1:1/v1" }).where(eq(providers.id, "live-gw"));
    // Restored: the same review is valid again (the hash depends only on what was reviewed).
    const again = (await query("providers.reviewStaticModels", { id: "live-gw" })).result.data;
    expect(again.reviewHash).toBe(p.reviewHash);
    // The list in force changing under a proposal also invalidates it.
    await h.ctx.db.update(providers).set({ staticModels: [CHAT] }).where(eq(providers.id, "live-gw"));
    expect((await call("providers.approveStaticModels", { id: "live-gw", review_hash: p.reviewHash })).status).toBe(409);
    await h.ctx.db.update(providers).set({ staticModels: [CHAT, OLD] }).where(eq(providers.id, "live-gw"));
  });

  test("the reviewed hash applies the list: new models are offered with their modalities, removed ones stop, the proposal is cleared", async () => {
    const proposed = [spec("acme/chat-a", { pricing: { prompt: "0.000002", completion: "0.000002" } }), VISION, EMBED];
    const p = await data(await call("providers.proposeStaticModels", { id: "live-gw", models: proposed }));
    const res = await call("providers.approveStaticModels", { id: "live-gw", review_hash: p.reviewHash });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ id: "live-gw", status: "live", models: 3, previous_models: 2 });
    expect(((await row()).staticModels as any[]).map((m) => m.id)).toEqual(["acme/chat-a", "acme/vision-a", "acme/embed-a"]);
    expect((await h.ctx.db.select().from(kv).where(eq(kv.key, pendingKey("live-gw")))).length).toBe(0);

    // The registry ran: the catalogue serves the new models, and the removed one no longer has a live offer.
    const listed = ((await (await h.request("/api/v1/models")).json()) as { data: any[] }).data;
    const byId = new Map(listed.map((m) => [m.id, m]));
    expect(byId.get("acme/vision-a")).toMatchObject({ architecture: { input_modalities: ["text", "image"] } });
    expect(byId.get("acme/embed-a")).toMatchObject({ architecture: { modality: "text->embeddings", output_modalities: ["embeddings"] }, pricing: { prompt: "0.00000001", completion: "0" } });
    expect(byId.get("acme/chat-a")).toMatchObject({ pricing: { prompt: "0.000002" } });
    expect(byId.has("acme/chat-old")).toBe(false);
    const [old] = await h.ctx.db.select().from(offers).where(eq(offers.modelId, "acme/chat-old"));
    expect(old.status).toBe("disabled");
    const [added] = await h.ctx.db.select().from(offers).where(eq(offers.modelId, "acme/embed-a"));
    expect(added).toMatchObject({ providerId: "live-gw", status: "live" });

    // A used approval cannot be replayed.
    const replay = await call("providers.approveStaticModels", { id: "live-gw", review_hash: p.reviewHash });
    expect(replay.status).toBe(404);
    expect(await query("providers.reviewStaticModels", { id: "live-gw" }).then((r) => r.result.data)).toEqual({ id: "live-gw", pending: false });
  });
});

describe("the review hash", () => {
  test("depends on the provider, the reviewed application and the exact proposed list", async () => {
    const p = await row();
    const a = staticModelsReviewHash(p, [CHAT]);
    expect(a).toBe(staticModelsReviewHash({ ...p }, [CHAT]));
    expect(a).not.toBe(staticModelsReviewHash(p, [CHAT, VISION]));
    expect(a).not.toBe(staticModelsReviewHash({ ...p, baseUrl: "https://other.example/v1" }, [CHAT]));
    expect(a).not.toBe(staticModelsReviewHash({ ...p, apiKeyEnc: "v1.a.b.c" }, [CHAT]));
    expect(a).not.toBe(staticModelsReviewHash({ ...p, id: "other" }, [CHAT]));
    expect(staticModelsDigest(null)).toBe(staticModelsDigest(undefined));
  });
  test("a diff names added and removed models and per-field changes, whatever the order", () => {
    const d = diffStaticModels([CHAT, OLD], [VISION, spec("acme/chat-a", { context_length: 65536 })]);
    expect(d.removed).toEqual(["acme/chat-old"]);
    expect(d.added.map((m) => m.id)).toEqual(["acme/vision-a"]);
    expect(d.changed).toEqual([{ id: "acme/chat-a", fields: { context_length: { from: 32768, to: 65536 } } }]);
    expect(diffStaticModels(null, [CHAT]).added.length).toBe(1);
  });
});
