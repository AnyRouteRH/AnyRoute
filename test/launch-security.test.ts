import { afterAll, beforeAll, expect, test, describe } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, ADMIN, type Harness } from "./helpers.ts";
import { providers, kv, chainCursor, spentRoots } from "../src/db/schema.ts";
import { runRegistry } from "../src/services/registry.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { sealProviderHeaders } from "../src/providers/headers.ts";
import { boundedJson } from "../src/providers/network.ts";
import { CRITICAL_JOBS, jobReady } from "../src/services/readiness.ts";
import { Jobs } from "../src/services/jobs.ts";

const application = (id: string, url: string) => ({ id, name: "Audit provider", base_url: url, data_policy: { training: false, retains_prompts: false }, contact: "private@example.test", headers: { "x-private": "AUDIT_PLACEHOLDER" }, tee: { kind: "dev", attestation_url: url + "/attestation" } });
describe("launch security regressions", () => {
  let h: Harness;
  let target: ReturnType<typeof Bun.serve>;
  let hits = 0;
  beforeAll(async () => {
    target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return Response.json({ data: [] }); } });
    h = await startRouter();
  });
  afterAll(async () => { await h.close(); target.stop(true); });
  test("REST and tRPC applications cannot initiate discovery or attestation, even after bonding", async () => {
    const url = `http://127.0.0.1:${target.port}`;
    expect((await h.request("/api/v1/providers/apply", { method: "POST", json: application("untrusted-rest", url) })).status).toBe(201);
    expect((await h.request("/trpc/providers.onboard", { method: "POST", json: application("untrusted-trpc", url) })).status).toBe(200);
    await h.ctx.db.update(providers).set({ bondUsdg: 20_000_000_000n }).where(eq(providers.id, "untrusted-rest"));
    await runRegistry(h.ctx); await runAttestor(h.ctx);
    expect(hits).toBe(0);
    expect((await h.request("/trpc/providers.approve", { method: "POST", json: { id: "untrusted-rest" } })).status).toBe(401);
    const review = (await (await h.request(`/trpc/providers.review?input=${encodeURIComponent(JSON.stringify({ id: "untrusted-rest" }))}`, { headers: { "x-admin-token": ADMIN } })).json()).result.data;
    expect((await h.request("/trpc/providers.approve", { method: "POST", headers: { "x-admin-token": ADMIN }, json: { id: "untrusted-rest", review_hash: review.reviewHash } })).status).toBe(200);
    expect(hits).toBeGreaterThan(0);
  });
  test("public provider responses omit every private field; operator views remain protected", async () => {
    const r = await h.request(`/trpc/providers.get?input=${encodeURIComponent(JSON.stringify({ id: "untrusted-trpc" }))}`);
    expect(r.status).toBe(200);
    const p = (await r.json()).result.data;
    const [stored] = await h.ctx.db.select().from(providers).where(eq(providers.id, "untrusted-trpc"));
    expect(JSON.stringify(stored.headers)).not.toContain("AUDIT_PLACEHOLDER");
    expect(Object.keys(p).sort()).toEqual(["id", "name", "status", "dataPolicy", "datacenter", "teeKind", "attested", "attestedAt"].sort());
    expect(JSON.stringify(p)).not.toContain("AUDIT_PLACEHOLDER");
    expect((await h.request("/trpc/providers.list")).status).toBe(401);
  });
  test("encrypted provider headers work for both JSON and streaming inference", async () => {
    await h.ctx.db.update(providers).set({ headers: sealProviderHeaders(h.ctx.cfg.appSecret, { "x-provider-fixture": "private-value" }) }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    const key = await h.fundedKey();
    for (const stream of [false, true]) {
      const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: { model: "meta-llama/llama-3.3-70b-instruct", provider: { only: ["alpha"] }, stream, messages: [{ role: "user", content: "hello" }] } });
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).not.toContain("Internal router error");
      if (stream) expect(text).toContain("[DONE]");
    }
  });
  test("both onboarding APIs use production URL validation", async () => {
    const production = h.ctx.cfg.production;
    h.ctx.cfg.production = true;
    try {
      for (const path of ["/api/v1/providers/apply", "/trpc/providers.onboard"]) {
        expect((await h.request(path, { method: "POST", json: application("bad-http", "http://127.0.0.1") })).status).toBe(400);
        const v = application("bad-tee", "https://provider.example"); v.tee.attestation_url = "http://127.0.0.1/metadata";
        expect((await h.request(path, { method: "POST", json: v })).status).toBe(400);
      }
    } finally { h.ctx.cfg.production = production; }
  });
  test("concurrent applications cannot overwrite the first applicant", async () => {
    const v = application("race-fixture", `http://127.0.0.1:${target.port}`);
    const results = await Promise.all([h.request("/api/v1/providers/apply", { method: "POST", json: v }), h.request("/api/v1/providers/apply", { method: "POST", json: { ...v, name: "Other applicant" } })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const token = (await results.find((r) => r.status === 201)!.json()).data.application_token;
    expect((await h.request("/api/v1/providers/apply", { method: "POST", json: { ...v, name: "Token holder" }, headers: { "x-application-token": token } })).status).toBe(201);
    expect((await h.request("/trpc/providers.onboard", { method: "POST", json: v })).status).toBe(409);
  });
  test("shared application rate limit is applied to REST and tRPC", async () => {
    const old = h.ctx.limiter;
    h.ctx.limiter = { take: async () => ({ ok: false, remaining: 0, retryAfterMs: 1000 }), close: async () => {} };
    try { for (const path of ["/api/v1/providers/apply", "/trpc/providers.onboard"]) expect((await h.request(path, { method: "POST", json: application("rate-limited", "https://provider.example") })).status).toBe(429); }
    finally { h.ctx.limiter = old; }
  });
  test("readiness succeeds for healthy dependencies and rejects failed shared worker state", async () => {
    const oldCredits = h.ctx.cfg.chain.credits, oldAnchor = h.ctx.cfg.chain.receiptAnchor;
    const oldChainId = h.ctx.chain.client.getChainId;
    h.ctx.cfg.chain.credits = "0x0000000000000000000000000000000000000001";
    h.ctx.cfg.chain.receiptAnchor = "0x0000000000000000000000000000000000000002";
    h.ctx.chain.client.getChainId = async () => h.ctx.cfg.chain.id;
    try {
      await h.ctx.db.insert(chainCursor).values({ id: "main", block: 100n }).onConflictDoUpdate({ target: chainCursor.id, set: { block: 100n } });
      for (const name of CRITICAL_JOBS) {
        const value = { name, every_ms: 5000, last_error: null, last_success: new Date().toISOString() };
        await h.ctx.db.insert(kv).values({ key: `job-health:${name}`, value }).onConflictDoUpdate({ target: kv.key, set: { value } });
      }
      expect((await h.request("/ready")).status).toBe(200);
      h.chain.controlsReady = false;
      expect((await h.request("/ready")).status).toBe(503);
      h.chain.controlsReady = true;
      await h.ctx.db.insert(spentRoots).values({ epoch: 1, root: "0x" + "11".repeat(32), asOf: new Date(), totalSpentUsdg: 0n, leaves: [], status: "awaiting_approval", createdAt: new Date(Date.now() - 25 * 3_600_000) });
      expect((await h.request("/ready")).status).toBe(200); // normal timelock review isn't a failed submission
      await h.ctx.db.update(spentRoots).set({ createdAt: new Date(Date.now() - 49 * 3_600_000) });
      expect((await h.request("/ready")).status).toBe(503);
      await h.ctx.db.delete(spentRoots);
      await h.ctx.db.update(kv).set({ value: { name: "settlement", every_ms: 5000, last_error: "fixture failure", last_success: new Date().toISOString() } }).where(eq(kv.key, "job-health:settlement"));
      expect((await h.request("/ready")).status).toBe(503);
    } finally { h.ctx.cfg.chain.credits = oldCredits; h.ctx.cfg.chain.receiptAnchor = oldAnchor; h.ctx.chain.client.getChainId = oldChainId; }
  });
  test("liveness remains available while readiness fails closed on absent dependencies", async () => {
    expect((await h.request("/health")).status).toBe(200);
    const r = await h.request("/ready");
    expect(r.status).toBe(503);
    expect((await r.json()).ok).toBe(false);
  });
});

test("untrusted JSON is bounded even without Content-Length", async () => {
  await expect(boundedJson(new Response('"' + "x".repeat(100) + '"'), 16)).rejects.toThrow("size limit");
  expect(await boundedJson(Response.json({ ok: true }))).toEqual({ ok: true });
});
test("worker failures propagate, persist failure state and recover on the next run", async () => {
  let failing = true;
  const recorded: any[] = [];
  const jobs = new Jobs(undefined, async (s) => { recorded.push(s); });
  jobs.register("fixture", 1000, async () => { if (failing) throw new Error("fixture failure"); return true; });
  await expect(jobs.run("fixture")).rejects.toThrow("fixture failure");
  expect(recorded.at(-1).last_error).toBe("fixture failure");
  expect(jobReady(recorded.at(-1))).toBe(false);
  failing = false; await jobs.run("fixture");
  expect(jobReady(recorded.at(-1))).toBe(true);
  expect(jobReady(recorded.at(-1), Date.now() + 120_000)).toBe(false);
  await jobs.stop();
});
