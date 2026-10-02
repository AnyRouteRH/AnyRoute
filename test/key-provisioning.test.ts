import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keys } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { inferenceRouteAllowed } from "../src/provisioning/scope.ts";
import { accountDefaultScope, keyPagination } from "../src/provisioning/keys.ts";
import { startRouter, type Harness } from "./helpers.ts";

const model = "meta-llama/llama-3.3-70b-instruct";
const chat = { model, messages: [{ role: "user", content: "hello" }], max_tokens: 32 };

describe("provisioned key compatibility and inference-only access", () => {
  let h: Harness;
  let owner: Awaited<ReturnType<Harness["fundedKey"]>>;
  let child: { secret: string; hash: string; auth: Record<string, string> };
  const create = async (spec: Record<string, unknown>, headers = owner.auth) => {
    const res = await h.request("/api/v1/keys", { method: "POST", headers, json: spec });
    const body = await res.json();
    return { res, body };
  };
  beforeAll(async () => {
    h = await startRouter({ env: { INFERENCE_KEYS_ENABLED: "true" } });
    owner = await h.fundedKey();
    const { res, body } = await create({ scope: "inference", limit: 0.125, include_byok_in_limit: true, expires_at: new Date(Date.now() + 300_000).toISOString() });
    expect(res.status).toBe(201);
    child = { secret: body.key, hash: body.data.hash, auth: { authorization: `Bearer ${body.key}` } };
  });
  afterAll(async () => { await h?.close(); });

  test("stock issuer create/update/read shapes, exact counters and nonoverlapping usage", async () => {
    let res = await h.request(`/api/v1/keys/${child.hash}`, { headers: owner.auth });
    let data = (await res.json()).data;
    expect(data.include_byok_in_limit).toBe(true);
    expect(data.limit).toBe(0.125);
    expect(data.limit_reset).toBeNull();
    expect(data.expires_at).toBeTruthy();
    expect(data.byok_usage).toBe(0);
    await h.ctx.db.update(keys).set({ spentTotal: 123_456_789n, spent: 123_456_789n }).where(eq(keys.keyHash, child.hash));
    data = (await (await h.request(`/api/v1/keys/${child.hash}`, { headers: owner.auth })).json()).data;
    expect(data.usage).toBe(0.000123456789);
    expect(data.usage + data.byok_usage).toBe(data.usage);
    expect(data.usage_pico_usd).toBe("123456789");
    expect(data.usage_period_pico_usd).toBe("123456789");
    expect(data.usage_micro_usd).toBe("124");
    expect(data.byok_usage_pico_usd).toBe("0");
    res = await h.request(`/api/v1/keys/${child.hash}`, { method: "PATCH", headers: owner.auth, json: { include_byok_in_limit: false } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.include_byok_in_limit).toBe(false);
    await h.ctx.db.update(keys).set({ spentTotal: 0n, spent: 0n }).where(eq(keys.keyHash, child.hash));
  });

  test("pagination terminates, includes disabled keys, keeps old unpaginated lists", async () => {
    const made = await create({ name: "retired" });
    const hash = made.body.data.hash;
    const deleted = await h.request(`/api/v1/keys/${hash}`, { method: "DELETE", headers: owner.auth });
    expect(await deleted.json()).toEqual({ deleted: true, data: { hash, deleted: true } });
    const all = (await (await h.request("/api/v1/keys", { headers: owner.auth })).json()).data;
    expect(all.find((k: any) => k.hash === hash).disabled).toBe(true);
    const hashes: string[] = [];
    for (let offset = 0; offset <= all.length; offset++) {
      const page = (await (await h.request(`/api/v1/keys?offset=${offset}&limit=1`, { headers: owner.auth })).json()).data;
      expect(page.length).toBe(offset === all.length ? 0 : 1);
      hashes.push(...page.map((k: any) => k.hash));
    }
    expect(hashes).toEqual(all.map((k: any) => k.hash));
    expect((await h.request("/api/v1/keys?offset=-1", { headers: owner.auth })).status).toBe(400);
    expect((await h.request("/api/v1/keys?limit=1001", { headers: owner.auth })).status).toBe(400);
    expect(keyPagination({ offset: "0" }).limit).toBe(100);
    // Large integers never go through a JSON number in the additive fields.
    await h.ctx.db.update(keys).set({ spentTotal: 9_007_199_254_740_993n }).where(eq(keys.keyHash, hash));
    const data = (await (await h.request(`/api/v1/keys/${hash}`, { headers: owner.auth })).json()).data;
    expect(data.usage_pico_usd).toBe("9007199254740993");
    expect(data.usage_micro_usd).toBe("9007199255");
  });

  test("enumerate registered routes: every route outside the allow-list refuses the key", async () => {
    let checked = 0;
    const routes = new Map(h.app.routes.filter((r) => r.method !== "ALL").map((r) => [`${r.method} ${r.path}`, r]));
    for (const route of routes.values()) {
      const path = route.path.replace(/:[^/]+/g, "sample-id");
      if (inferenceRouteAllowed(route.method, path)) continue;
      const res = await h.request(path, { method: route.method, headers: child.auth, ...(route.method === "GET" ? {} : { json: {} }) });
      expect(res.status, `${route.method} ${path}`).toBe(403);
      if (route.method !== "HEAD") expect((await res.json()).error.message).toContain("Inference-only");
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
    for (const path of ["/dashboard", "/agents", "/api/v1/admin", "/api/v1/account", "/api/v1/settings", "/api/v1/future-route", "/api/v1/keys/defaults", "/api/v1/hosts", "/api/v1/receipts/keys"]) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) expect((await h.request(path, { method, headers: child.auth })).status, `${method} ${path}`).toBe(403);
    }
    expect((await h.request("/api/v1/activity", { headers: { "x-api-key": child.secret } })).status).toBe(403);
    expect((await h.request("/api/v1/inbox", { headers: { ...owner.auth, "x-api-key": child.secret } })).status).toBe(403);
  });

  test("all inference adapters and aliases reach normal validation, model listing works", async () => {
    for (const base of ["/api/v1", "/v1"]) {
      expect((await h.request(`${base}/models`, { headers: child.auth })).status).toBe(200);
      for (const path of ["chat/completions", "completions", "embeddings", "responses", "messages"]) {
        const res = await h.request(`${base}/${path}`, { method: "POST", headers: child.auth, json: {} });
        expect(res.status, path).toBe(400);
      }
    }
    expect((await h.request("/api/v1/messages", { method: "POST", headers: { "x-api-key": child.secret }, json: {} })).status).toBe(400);
  });

  test("inference cannot read account presets through model names or per-key aliases", async () => {
    const save = await h.request("/api/v1/presets/operator-settings", { method: "PUT", headers: owner.auth, json: { models: [model], system_prompt: "Account configuration must stay with the owner." } });
    expect(save.status).toBe(201);
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: owner.auth, json: { ...chat, model: "@preset/operator-settings" } })).status).toBe(200);
    for (const name of ["@preset/operator-settings", "@route/operator-settings", "@character/operator-settings"]) {
      expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: child.auth, json: { ...chat, model: name } })).status).toBe(403);
      expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: child.auth, json: { ...chat, models: [name] } })).status).toBe(403);
    }
    await h.request(`/api/v1/keys/${child.hash}`, { method: "PATCH", headers: owner.auth, json: { routing: { aliases: { primary: { model: "@preset/operator-settings" } } } } });
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: child.auth, json: { ...chat, model: "primary" } })).status).toBe(403);
    await h.request(`/api/v1/keys/${child.hash}`, { method: "PATCH", headers: owner.auth, json: { routing: null } });
  });

  test("billed calls and own-generation/receipt reads work; sibling and foreign reads do not", async () => {
    const own = await h.request("/api/v1/chat/completions", { method: "POST", headers: child.auth, json: chat });
    expect(own.status).toBe(200);
    const ownId = own.headers.get("x-receipt-id")!;
    expect(ownId).toBeTruthy();
    const sibling = await h.request("/api/v1/chat/completions", { method: "POST", headers: owner.auth, json: chat });
    expect(sibling.status).toBe(200);
    const siblingId = sibling.headers.get("x-receipt-id")!;
    const foreign = await h.fundedKey();
    const other = await h.request("/api/v1/chat/completions", { method: "POST", headers: foreign.auth, json: chat });
    const foreignId = other.headers.get("x-receipt-id")!;
    for (const id of [ownId, siblingId, foreignId]) {
      const expected = id === ownId ? 200 : 404;
      for (const path of [`/api/v1/generation?id=${id}`, `/api/v1/receipts/${id}`, `/api/v1/receipts/${id}/proof`, `/api/v1/receipts/${id}/privacy`]) {
        expect((await h.request(path, { headers: child.auth })).status, path).toBe(expected);
      }
    }
    const listed = (await (await h.request("/api/v1/generations", { headers: child.auth })).json()).data;
    expect(listed.map((g: any) => g.id)).toEqual([ownId]);
    const data = (await (await h.request(`/api/v1/keys/${child.hash}`, { headers: owner.auth })).json()).data;
    expect(data.usage).toBeGreaterThan(0);
    expect(data.byok_usage).toBe(0);
    expect(data.usage + data.byok_usage).toBe(data.usage);
    expect(data.usage_pico_usd).not.toBe("0");
    // Scope does not erase the existing public-by-identifier receipt contract.
    expect((await h.request(`/api/v1/receipts/${siblingId}`)).status).toBe(200);
  });

  test("account default is owner-only, inherited, and does not rescope existing keys", async () => {
    const normal = await create({});
    const ordinary = { authorization: `Bearer ${normal.body.key}` };
    expect(normal.body.data.scope).toBe("account");
    expect((await h.request("/api/v1/keys/defaults", { method: "PATCH", headers: owner.auth, json: { scope: "inference" } })).status).toBe(200);
    const defaults = (await (await h.request("/api/v1/keys/defaults", { headers: owner.auth })).json()).data;
    expect(defaults.scope).toBe("inference");
    expect((await create({})).body.data.scope).toBe("inference");
    expect((await create({ scope: "account", management: true })).body.data.management).toBe(true);
    expect((await create({ management: true })).res.status).toBe(400);
    expect((await create({ scope: "inference" }, ordinary)).res.status).toBe(403);
    expect((await create({ scope: "inference" }, {})).res.status).toBe(403);
    expect((await h.request("/api/v1/keys/defaults", { headers: ordinary })).status).toBe(403);
    expect((await h.request("/api/v1/credits", { headers: ordinary })).status).toBe(200);
    const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
    expect(await accountDefaultScope(h.ctx, h.ctx.db, row.accountId)).toBe("inference");
    const sessions = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 0.05, ttl_seconds: 300 } });
    expect(sessions.status).toBe(201);
    const session = await sessions.json();
    expect((await h.request("/api/v1/activity", { headers: { authorization: `Bearer ${session.data.key}` } })).status).toBe(403);
    expect((await h.request(`/api/v1/keys/${child.hash}`, { method: "PATCH", headers: owner.auth, json: { scope: "account" } })).status).toBe(400);
    expect((await h.request(`/api/v1/keys/${child.hash}`, { method: "PATCH", headers: owner.auth, json: { management: true } })).status).toBe(403);
    h.ctx.cfg.inferenceKeysEnabled = false;
    expect((await create({ scope: "inference" })).res.status).toBe(403);
    expect((await h.request("/api/v1/credits", { headers: child.auth })).status).toBe(403);
    expect((await h.request("/api/v1/models", { headers: child.auth })).status).toBe(200);
    expect((await h.request("/api/v1/keys/defaults", { method: "PATCH", headers: owner.auth, json: { scope: "account" } })).status).toBe(200);
    h.ctx.cfg.inferenceKeysEnabled = true;
  });
});

test("flag defaults off; production config with feature enabled passes existing guards", () => {
  expect(loadConfig({ ANYROUTE_ENV: "test", INFERENCE_KEYS_ENABLED: "false" }).inferenceKeysEnabled).toBe(false);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", INFERENCE_KEYS_ENABLED: "true", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: "0x" + "1".repeat(40), CALLPAY_ADDRESS: "0x" + "1".repeat(40), PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40), RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40), ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) });
  expect(cfg.production).toBe(true);
  expect(cfg.inferenceKeysEnabled).toBe(true);
});

test("provisioning is unavailable when the flag is absent", async () => {
  const h = await startRouter();
  try {
    expect(h.ctx.cfg.inferenceKeysEnabled).toBe(false);
    const owner = await h.newKey();
    expect((await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { scope: "inference" } })).status).toBe(403);
    expect((await h.request("/api/v1/keys/defaults", { method: "PATCH", headers: owner.auth, json: { scope: "inference" } })).status).toBe(403);
  } finally { await h.close(); }
});
