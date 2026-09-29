import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { cacheKey, lexicalVector } from "../src/gateway/cache.ts";
import { upstreamBody } from "../src/providers/upstream.ts";

const LLAMA = MODELS.llama.slug;

// M-01 --------------------------------------------------------------------------------------------
describe("M-01: the opt-in response cache is scoped to the forwarded end-user identity", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h.close(); });
  const chat = async (auth: Record<string, string>, json: Record<string, unknown>) => {
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json });
    expect(r.status).toBe(200);
    return r.json();
  };

  test("the upstream sees `user`, so the exact cache key must depend on it", () => {
    const body = { model: LLAMA, messages: [{ role: "user", content: "same prompt" }] };
    const forwarded = upstreamBody({ providerModelId: "m", supportedParameters: [] } as never, { ...body, user: "tenant-user-a" }, false).body;
    expect(forwarded.user).toBe("tenant-user-a");
    expect(cacheKey("scope", { ...body, user: "tenant-user-a" })).not.toBe(cacheKey("scope", { ...body, user: "tenant-user-b" }));
    expect(cacheKey("scope", { ...body, user: "tenant-user-a" })).not.toBe(cacheKey("scope", body));
  });

  for (const mode of ["exact", "semantic"] as const)
    test(`${mode} cache: a second end user behind the same key is a miss and reaches the provider as itself`, async () => {
      const key = await h.fundedKey();
      const base = { model: LLAMA, provider: { only: ["alpha"] }, temperature: 0, cache: { mode }, messages: [{ role: "user", content: `per-user ${mode} cache` }] };
      const stats = h.mocks.alpha.stats;
      const before = stats.requests;
      expect((await chat(key.auth, { ...base, user: "tenant-user-a" })).cached).not.toBe(true);
      expect((await chat(key.auth, { ...base, user: "tenant-user-a" })).cached).toBe(true); // same user still hits
      const other = await chat(key.auth, { ...base, user: "tenant-user-b" });
      expect(other.cached).not.toBe(true);
      expect(stats.lastBody.user).toBe("tenant-user-b");
      expect((await chat(key.auth, base)).cached).not.toBe(true); // no user is its own scope as well
      expect(stats.requests - before).toBe(3);
    });

  test("semantic near-duplicates are only served to the end user who caused them", async () => {
    const key = await h.fundedKey();
    const words = Array.from({ length: 80 }, (_, i) => `term${i}`).join(" ");
    const original = `summarise ${words}`;
    const nearDuplicate = `${original} thanks`;
    const sim = ((a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0))(lexicalVector(`user: ${original}`), lexicalVector(`user: ${nearDuplicate}`));
    expect(sim).toBeGreaterThanOrEqual(h.ctx.cfg.gateway.semanticThreshold);
    const body = (content: string, user: string) => ({ model: LLAMA, provider: { only: ["alpha"] }, temperature: 0, cache: { mode: "semantic" }, user, messages: [{ role: "user", content }] });
    expect((await chat(key.auth, body(original, "tenant-user-a"))).cached).not.toBe(true);
    expect((await chat(key.auth, body(nearDuplicate, "tenant-user-a"))).cached).toBe(true);
    const other = await chat(key.auth, body(nearDuplicate, "tenant-user-b"));
    expect(other.cached).not.toBe(true);
    expect(h.mocks.alpha.stats.lastBody.user).toBe("tenant-user-b");
  });
});
