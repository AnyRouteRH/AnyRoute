import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { providers } from "../src/db/schema.ts";
import { openDatabase } from "../src/db/client.ts";
import { cacheKey, lexicalVector } from "../src/gateway/cache.ts";
import { upstreamBody } from "../src/providers/upstream.ts";
import * as headerPhase from "../src/providers/headers.ts";
import { encrypt } from "../src/lib/util.ts";

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

// M-02 --------------------------------------------------------------------------------------------
describe("M-02: provider approval activates only the reviewed application revision", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h.close(); });
  const admin = { "x-admin-token": ADMIN };
  const spec = (id: string, baseUrl = h.mocks.alpha.url) => ({ id, name: "Reviewed provider", base_url: baseUrl, data_policy: { training: false, retains_prompts: false } });
  const apply = (json: unknown, token?: string) => h.request("/api/v1/providers/apply", { method: "POST", json, headers: token ? { "x-application-token": token } : {} });
  const review = async (id: string) => (await (await h.request(`/trpc/providers.review?input=${encodeURIComponent(JSON.stringify({ id }))}`, { headers: admin })).json()).result.data;
  const listed = async (id: string) => (await (await h.request("/trpc/providers.list", { headers: admin })).json()).result.data.find((p: { id: string }) => p.id === id);
  const approve = (json: Record<string, unknown>) => h.request("/trpc/providers.approve", { method: "POST", headers: admin, json });
  const row = async (id: string) => (await h.ctx.db.select().from(providers).where(eq(providers.id, id)))[0];

  test("an edit made after the operator's review cannot be activated by that review", async () => {
    const token = (await (await apply(spec("stale-review"))).json()).data.application_token;
    const reviewed = await review("stale-review");
    expect(reviewed.baseUrl).toBe(h.mocks.alpha.url);
    expect(reviewed.reviewHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await listed("stale-review")).reviewHash).toBe(reviewed.reviewHash);
    // Applicant swaps endpoint and payout destination after the operator looked.
    expect((await apply({ ...spec("stale-review", h.mocks.beta.url), payout_address: "0x1111111111111111111111111111111111111111" }, token)).status).toBe(201);
    const stale = await approve({ id: "stale-review", review_hash: reviewed.reviewHash });
    expect(stale.status).toBe(409);
    expect((await row("stale-review")).status).toBe("applied");
    // Reviewing the new revision yields a new hash, and only that hash approves it.
    const again = await review("stale-review");
    expect(again.reviewHash).not.toBe(reviewed.reviewHash);
    expect(again.baseUrl).toBe(h.mocks.beta.url);
    expect((await approve({ id: "stale-review", review_hash: again.reviewHash })).status).toBe(200);
    const approved = await row("stale-review");
    expect(approved.status).toBe("shadow");
    expect(approved.baseUrl).toBe(h.mocks.beta.url);
    expect((await listed("stale-review")).reviewHash).toBeNull();
    // Once approved, the applicant's token can no longer change the record.
    expect((await apply(spec("stale-review"), token)).status).toBe(409);
    expect((await row("stale-review")).baseUrl).toBe(h.mocks.beta.url);
  });

  test("approval racing an applicant edit never activates the unreviewed revision", async () => {
    for (let i = 0; i < 3; i++) {
      const id = `approval-race-${i}`;
      const token = (await (await apply(spec(id))).json()).data.application_token;
      const reviewed = await review(id);
      const [approval, edit] = await Promise.all([approve({ id, review_hash: reviewed.reviewHash }), apply(spec(id, h.mocks.beta.url), token)]);
      const after = await row(id);
      if (approval.status === 200) {
        expect(after.status).toBe("shadow");
        expect(after.baseUrl).toBe(h.mocks.alpha.url);
        expect(edit.status).toBe(409);
      } else {
        expect(approval.status).toBe(409);
        expect(edit.status).toBe(201);
        expect(after.status).toBe("applied");
        expect(after.baseUrl).toBe(h.mocks.beta.url);
      }
    }
  });

  test("approval requires a review hash, a pending application, and cannot be bypassed with setStatus", async () => {
    expect((await apply({ ...spec("needs-hash"), api_key: "applicant-upstream-key" })).status).toBe(201);
    expect((await approve({ id: "needs-hash" })).status).toBe(400);
    expect((await approve({ id: "needs-hash", review_hash: "0".repeat(64) })).status).toBe(409);
    expect((await approve({ id: "missing-provider", review_hash: "0".repeat(64) })).status).toBe(404);
    for (const status of ["shadow", "live"]) {
      const bypass = await h.request("/trpc/providers.setStatus", { method: "POST", headers: admin, json: { id: "needs-hash", status } });
      expect(bypass.status).toBe(409);
    }
    expect((await row("needs-hash")).status).toBe("applied");
    const reviewed = await review("needs-hash");
    expect((await approve({ id: "needs-hash", review_hash: reviewed.reviewHash, live: true })).status).toBe(200);
    expect((await row("needs-hash")).status).toBe("live");
    // A second approval of the same (no longer pending) revision is refused.
    expect((await approve({ id: "needs-hash", review_hash: reviewed.reviewHash })).status).toBe(409);
    // Operators keep ordinary lifecycle control over approved providers.
    for (const status of ["suspended", "live"]) expect((await h.request("/trpc/providers.setStatus", { method: "POST", headers: admin, json: { id: "needs-hash", status } })).status).toBe(200);
    // The review view never exposes the encrypted upstream key.
    expect(JSON.stringify(reviewed)).not.toContain("apiKeyEnc");
  });
});

// M-03 --------------------------------------------------------------------------------------------
const SECRET = "hardening-secret-hardening-secret-0123";
const PLAINTEXT = "LEGACY_PLAINTEXT_FIXTURE_VALUE";
const legacyRow = (id: string, headers: unknown, apiKey = true) => ({
  id, name: id, baseUrl: "https://provider.example", status: "live", dataPolicy: {}, headers,
  apiKeyEnc: apiKey ? encrypt(SECRET, `upstream-key-${id}`) : null,
});

describe("M-03: plaintext provider headers are a mandatory, idempotent deployment phase", () => {
  test("the phase refuses plaintext rows without APP_SECRET, converts them with it, and is idempotent", async () => {
    const handle = await openDatabase("pglite://memory");
    try {
      const { db } = handle;
      await db.insert(providers).values([
        legacyRow("legacy-a", { "x-api-key": PLAINTEXT }),
        legacyRow("legacy-empty", {}),
        legacyRow("sealed", headerPhase.sealProviderHeaders(SECRET, { "x-sealed": "fixture" })),
        legacyRow("none", null),
      ]);
      const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } throw new Error("expected the header phase to fail"); };

      const missing = await errorOf(headerPhase.enforceEncryptedProviderHeaders(db, undefined));
      expect(missing).toContain("legacy-a");
      expect(missing).toContain("APP_SECRET");
      expect(missing).not.toContain(PLAINTEXT);
      expect((await db.select().from(providers).where(eq(providers.id, "legacy-a")))[0].headers).toEqual({ "x-api-key": PLAINTEXT });

      const wrong = await errorOf(headerPhase.enforceEncryptedProviderHeaders(db, "some-other-secret-some-other-secret-00"));
      expect(wrong).toContain("does not decrypt");
      expect((await db.select().from(providers).where(eq(providers.id, "legacy-a")))[0].headers).toEqual({ "x-api-key": PLAINTEXT });

      const done = await headerPhase.enforceEncryptedProviderHeaders(db, SECRET);
      expect(done.converted.sort()).toEqual(["legacy-a", "legacy-empty"]);
      expect(done.remaining).toBe(0);
      const rows = Object.fromEntries((await db.select().from(providers)).map((r) => [r.id, r.headers]));
      expect(JSON.stringify(rows)).not.toContain(PLAINTEXT);
      expect(headerPhase.openProviderHeaders(SECRET, rows["legacy-a"])).toEqual({ "x-api-key": PLAINTEXT });
      expect(rows["legacy-empty"]).toBeNull();
      expect(headerPhase.openProviderHeaders(SECRET, rows.sealed)).toEqual({ "x-sealed": "fixture" });

      // Re-running needs no secret once nothing is left, and changes nothing.
      const again = await headerPhase.enforceEncryptedProviderHeaders(db, undefined);
      expect(again.converted).toEqual([]);
      expect(Object.fromEntries((await db.select().from(providers)).map((r) => [r.id, r.headers]))).toEqual(rows);
    } finally {
      await handle.close();
    }
  });

  test("malformed or mixed header values fail the phase by id and are refused at runtime", async () => {
    const handle = await openDatabase("pglite://memory");
    try {
      const sealed = headerPhase.sealProviderHeaders(SECRET, { "x-sealed": "fixture" })!;
      await handle.db.insert(providers).values([legacyRow("mixed", { ...sealed, authorization: PLAINTEXT }), legacyRow("nested", { authorization: { value: PLAINTEXT } })]);
      let message = "";
      try { await headerPhase.enforceEncryptedProviderHeaders(handle.db, SECRET); } catch (e) { message = (e as Error).message; }
      expect(message).toContain("mixed");
      expect(message).toContain("nested");
      expect(message).not.toContain(PLAINTEXT);
      expect(() => headerPhase.openProviderHeaders(SECRET, { ...sealed, authorization: PLAINTEXT })).toThrow();
      expect(() => headerPhase.openProviderHeaders(SECRET, { authorization: PLAINTEXT })).toThrow();
      expect(headerPhase.openProviderHeaders(SECRET, null)).toEqual({});
    } finally {
      await handle.close();
    }
  });

  test("the migration job wires the header phase and the migrate image ships its imports", async () => {
    const root = resolve(import.meta.dir, "..");
    const migrate = await Bun.file(resolve(root, "scripts/migrate.ts")).text();
    expect(migrate).toContain("enforceEncryptedProviderHeaders");
    const dockerfile = await Bun.file(resolve(root, "deploy/railway/migrate.Dockerfile")).text();
    for (const path of ["src/db", "src/lib/util.ts", "src/providers/headers.ts"]) expect(dockerfile).toContain(`COPY ${path} `);
  });

  // Runs the real migration job against PostgreSQL (TEST_PG_URL, see `bun run test:pg`).
  test.skipIf(!process.env.TEST_PG_URL)("scripts/migrate.ts fails on plaintext headers without APP_SECRET and converts them with it", async () => {
    const postgres = (await import("postgres")).default;
    const base = process.env.TEST_PG_URL!;
    const name = "ar_hdr_" + Math.random().toString(36).slice(2, 10);
    const adminSql = postgres(base, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(base);
    url.pathname = "/" + name;
    const run = (secret?: string) => {
      const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: url.toString(), APP_SECRET: secret };
      if (!secret) delete env.APP_SECRET;
      const p = Bun.spawnSync(["bun", "scripts/migrate.ts"], { cwd: resolve(import.meta.dir, ".."), env: env as Record<string, string> });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };
    try {
      expect(run().code).toBe(0); // fresh schema, nothing to convert, no secret needed
      const handle = await openDatabase(url.toString(), { migrate: false });
      try {
        await handle.db.insert(providers).values(legacyRow("legacy-pg", { "x-api-key": PLAINTEXT }));
        const refused = run();
        expect(refused.code).not.toBe(0);
        expect(refused.out).toContain("legacy-pg");
        expect(refused.out).not.toContain(PLAINTEXT);
        expect((await handle.db.select().from(providers))[0].headers).toEqual({ "x-api-key": PLAINTEXT });
        const converted = run(SECRET);
        expect(converted.code).toBe(0);
        expect(converted.out).not.toContain(PLAINTEXT);
        const [stored] = await handle.db.select().from(providers);
        expect(JSON.stringify(stored.headers)).not.toContain(PLAINTEXT);
        expect(headerPhase.openProviderHeaders(SECRET, stored.headers)).toEqual({ "x-api-key": PLAINTEXT });
        expect(run().code).toBe(0); // idempotent; secret no longer required
      } finally {
        await handle.close();
      }
    } finally {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await adminSql.end();
    }
  });
});
