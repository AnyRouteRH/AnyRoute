import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { CatalogJsonCache, CATALOG_TTL_MS, cacheModelLists, invalidateCatalogJson } from "../src/rush/cache.ts";
import { balanceEndpoint, balanceLevel, creditFailure, initializeUpstreamMonitor, insufficientCredits, parseBalance, refreshUpstreamHealth, runUpstreamMonitor, upstreamAdminView, upstreamAlertChecks } from "../src/rush/monitor.ts";
import { readFunnel } from "../src/rush/funnel.ts";
import { HealthTracker } from "../src/services/health.ts";
import { loadConfig } from "../src/config.ts";
import { callUpstream } from "../src/providers/upstream.ts";
import { accounts, generations, keys, kv, ledger, providers } from "../src/db/schema.ts";
import { encrypt } from "../src/lib/util.ts";
import { ADMIN, MODELS, startRouter } from "./helpers.ts";
import type { Ctx } from "../src/context.ts";

test("ON3 flags default off, validate thresholds, and load for production API and worker roles", () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).rush).toEqual({ enabled: false, catalogCache: false, warnUsd: 25, criticalUsd: 5, exhaustedUsd: 0, balanceUrl: undefined });
  expect(balanceEndpoint({ baseUrl: "https://relay.example/v1" }, undefined)).toBeNull();
  for (const change of [{ UPSTREAM_BALANCE_WARN_USD: "-1" }, { UPSTREAM_BALANCE_CRITICAL_USD: "30" }, { UPSTREAM_BALANCE_WARN_USD: "Infinity" }]) expect(() => loadConfig({ ANYROUTE_ENV: "test", ...change })).toThrow();
  const address = "0x" + "1".repeat(40);
  const prod = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: address, ESCROW_START_BLOCK: "1", ESCROW_TOKENS: JSON.stringify([{ symbol: "STOCK", address, decimals: 18, feed: "0x" + "2".repeat(40) }]), UPSTREAM_MONITOR_ENABLED: "true", CATALOG_CACHE_ENABLED: "true" };
  expect(loadConfig(prod).rush.enabled).toBe(true);
  expect(loadConfig({ ...prod, RUNTIME_ROLE: "worker", WORKER_JOBS: "upstream-monitor" }).workerJobs).toEqual(["upstream-monitor"]);
});

test("balance thresholds have exact boundaries and configured account balances accept plain USD readings", () => {
  expect([0, 4.99, 5, 24.99, 25].map(n => balanceLevel(n, 25, 5))).toEqual(["exhausted", "critical", "warning", "warning", "ok"]);
  expect(parseBalance({ amount_usd: "12.50" })).toBe(12.5);
  expect(parseBalance({ data: { balance_usd: 0 } })).toBe(0);
  for (const v of [{ balance: 20, currency: "EUR" }, { balance_usd: null }, { balance_usd: true }, { balance_usd: "" }]) expect(parseBalance(v)).toBeNull();
  expect(balanceEndpoint({ baseUrl: "https://relay.example/v1" }, "https://relay.example/balance")).toBe("https://relay.example/balance");
  for (const baseUrl of ["https://inference.phala.com/v1", "https://relay.example.attacker.invalid", "http://relay.example", "https://relay.example:444/v1", "https://credential@relay.example"]) expect(balanceEndpoint({ baseUrl }, "https://relay.example/balance")).toBeNull();
});

test("credit errors are distinct from auth failures, client errors and rate limits", () => {
  for (const message of ["Insufficient credits", "insufficient_balance", "Out of credits", "Not enough credits"]) expect(insufficientCredits(402, message)).toBe(true);
  for (const message of ["Unauthorized", "Too many requests", "Invalid prompt", "insufficient permissions", "balance endpoint not found"]) expect(insufficientCredits(403, message)).toBe(false);
  expect(insufficientCredits(500, "insufficient credits")).toBe(false);
});

test("catalogue cache expires at 30 seconds, coalesces bursts and invalidates in-flight results", async () => {
  let now = 0, computes = 0;
  const cache = new CatalogJsonCache(() => now);
  const make = async () => JSON.stringify({ data: [++computes] });
  expect(await Promise.all(Array.from({ length: 25 }, () => cache.get("", make)))).toEqual(Array(25).fill('{"data":[1]}'));
  now = CATALOG_TTL_MS - 1; expect(await cache.get("", make)).toBe('{"data":[1]}');
  now++; expect(await cache.get("", make)).toBe('{"data":[2]}');
  cache.invalidate(); expect(await cache.get("", make)).toBe('{"data":[3]}');
  let resolve!: (s: string) => void;
  const pending = cache.get("slow", () => new Promise(r => { resolve = r; }));
  cache.invalidate(); resolve("old"); await pending;
  expect(await cache.get("slow", async () => "new")).toBe("new");
});

test("list middleware shares byte-identical JSON across aliases, respects filters and sync, and excludes errors", async () => {
  const app = new Hono();
  const catalog = {} as Ctx["catalog"];
  cacheModelLists(app, { catalog, cfg: { rush: { catalogCache: true } } } as Ctx);
  let count = 0;
  const list = (c: import("hono").Context) => c.req.query("lane") === "invalid" ? c.json({ error: "invalid" }, 400) : c.json({ data: [{ value: ++count, lane: c.req.query("lane") ?? "public" }] });
  app.get("/api/v1/models", list); app.get("/v1/models", list);
  const a = await app.request("/api/v1/models"); const bytes = await a.text();
  expect(a.headers.get("cache-control")).toBe("public, max-age=30");
  expect(await (await app.request("/v1/models")).text()).toBe(bytes); expect(count).toBe(1);
  expect(await (await app.request("/v1/models?lane=attested")).text()).not.toBe(bytes);
  invalidateCatalogJson(catalog); expect(await (await app.request("/v1/models")).text()).not.toBe(bytes);
  const errors = await Promise.all(Array.from({ length: 4 }, () => app.request("/v1/models?lane=invalid")));
  expect(errors.map(r => r.status)).toEqual([400, 400, 400, 400]);
  expect(errors.every(r => !r.headers.has("cache-control"))).toBe(true);
});

test("monitor polls with existing credentials, shares holds across replicas and keeps balances operator-only", async () => {
  const h = await startRouter({ env: { UPSTREAM_MONITOR_ENABLED: "true", CATALOG_CACHE_ENABLED: "true", UPSTREAM_BALANCE_URL: "https://relay.example/balance" } });
  try {
    await h.ctx.db.update(providers).set({ baseUrl: "https://relay.example/v1", apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "fixture-upstream-key") }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    const fetcher: typeof import("../src/providers/network.ts").providerFetch = async (url, init) => {
      expect(url).toBe("https://relay.example/balance");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-upstream-key");
      expect(init.redirect).toBe("error"); expect(init.body).toBe("{}");
      return Response.json({ amount_usd: 0 });
    };
    expect(await runUpstreamMonitor(h.ctx, fetcher)).toEqual({ checked: 2 });
    expect(h.ctx.health.outage("another/model", "alpha")).toBe(true);
    const replica = new HealthTracker();
    await initializeUpstreamMonitor({ ...h.ctx, health: replica });
    expect(replica.outage("another/model", "alpha")).toBe(true);
    const checks = await upstreamAlertChecks(h.ctx);
    expect(Object.entries(checks).filter(([k, v]) => k.endsWith("_exhausted") && !v)).toHaveLength(1);
    const view = await upstreamAdminView(h.ctx);
    expect(view.providers.find(p => p.provider === "alpha")?.status).toBe("exhausted");
    expect(view.providers.find(p => p.provider === "beta")?.balance_usd).toBeNull();
    const publicModels = await (await h.request("/api/v1/models")).text();
    expect(publicModels).not.toContain("balance_usd");
    const path = "/trpc/rush?input=" + encodeURIComponent(JSON.stringify({ days: 7 }));
    expect((await h.request(path)).status).toBe(401);
    const account = await h.newKey(); expect((await h.request(path, { headers: account.auth })).status).toBe(401);
    const admin = await h.request(path, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(admin.status).toBe(200); expect(admin.headers.get("cache-control")).toBe("no-store");
    const data = (await admin.json() as any).result.data;
    expect(data.funnel).toHaveLength(7); expect(JSON.stringify(data)).not.toContain("fixture-upstream-key");
    expect((await h.request("/trpc/rush?input=" + encodeURIComponent(JSON.stringify({ days: 91 })), { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(400);
    await h.ctx.db.update(kv).set({ value: { until: Date.now() - 1 } }).where(eq(kv.key, "upstream-credit-hold:alpha"));
    // Expiring a failure hold cannot undo a successfully observed exhausted balance.
    const fresh = new HealthTracker(); await initializeUpstreamMonitor({ ...h.ctx, health: fresh });
    expect(fresh.outage("another/model", "alpha")).toBe(true);
    await runUpstreamMonitor(h.ctx, async () => Response.json({ unknown: 500 }));
    expect((await upstreamAdminView(h.ctx)).providers.find(p => p.provider === "alpha")?.status).toBe("exhausted");
  } finally { await h.close(); }
});

test("credit exhaustion fails over, returns a clear 503 when exhausted, and ignores BYOK for shared health", async () => {
  const h = await startRouter({ env: { UPSTREAM_MONITOR_ENABLED: "true" }, rand: () => 0 });
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }) });
  try {
    await h.ctx.db.update(providers).set({ baseUrl: upstream.url.toString().replace(/\/$/, ""), apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "fixture-upstream-key") }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    const cand = h.ctx.catalog.offers(MODELS.llama.slug).find(c => c.providerId === "alpha")!;
    const opts = { health: h.ctx.health, candidate: cand, path: "/chat/completions" as const, body: {}, stream: false, apiKey: "caller-upstream-key", appSecret: h.ctx.cfg.appSecret, signal: AbortSignal.timeout(1000), timeoutMs: 1000, firstTokenTimeoutMs: 1000, production: false };
    const own = await callUpstream(opts);
    expect(own.ok).toBe(false); expect(h.ctx.health.outage(cand.modelId, "alpha")).toBe(false);
    const key = await h.fundedKey();
    const request = { method: "POST", headers: key.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], provider: { order: ["alpha", "beta"] } } };
    const response = await h.request("/api/v1/chat/completions", request);
    expect(response.status).toBe(200); expect((await response.json() as any).provider).toBe("Beta");
    expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(true);
    const unavailable = await h.request("/api/v1/chat/completions", { ...request, json: { ...request.json, model: MODELS.qwen.slug } });
    expect(unavailable.status).toBe(503); expect(await unavailable.text()).toContain("temporarily unavailable");
    await refreshUpstreamHealth(h.ctx.health, h.ctx.db);
  } finally { upstream.stop(); await h.close(); }
});

test("disabled monitoring preserves classifications and writes no upstream state", async () => {
  const h = await startRouter();
  try {
    const cand = h.ctx.catalog.offers(MODELS.llama.slug)[0];
    expect(await creditFailure(h.ctx.health, cand, undefined, 402, "Insufficient credits")).toBe(false);
    expect(await runUpstreamMonitor(h.ctx)).toEqual({ skipped: "disabled" });
    expect(await upstreamAlertChecks(h.ctx)).toEqual({});
    expect((await h.ctx.db.select().from(kv)).some(r => r.key.startsWith("upstream-"))).toBe(false);
  } finally { await h.close(); }
});

test("funnel counts first retained milestones only, excludes deposit-created wallet accounts and failed calls", async () => {
  const h = await startRouter({ providers: [] });
  try {
    const today = new Date("2026-09-30T12:00:00Z"), old = new Date("2026-06-01T12:00:00Z");
    await h.ctx.db.insert(accounts).values([{ id: "rush-wallet", kind: "wallet", createdAt: today }, { id: "rush-deposit-wallet", kind: "wallet", createdAt: today }, { id: "rush-existing", createdAt: old }, { id: "rush-key", createdAt: today }]);
    await h.ctx.db.insert(keys).values({ keyHash: "rush-wallet-key", chainKeyHash: "rush-chain-key", keyAddress: "0x" + "1".repeat(40), accountId: "rush-wallet", label: "sample", management: true, createdAt: today });
    await h.ctx.db.insert(ledger).values([
      { id: "rush-old", ref: "rush-old", accountId: "rush-existing", kind: "deposit", amount: 1n, createdAt: old },
      { id: "rush-repeat", ref: "rush-repeat", accountId: "rush-existing", kind: "deposit", amount: 1n, createdAt: today },
      { id: "rush-a", ref: "rush-a", accountId: "rush-wallet", kind: "stock_deposit", amount: 1n, createdAt: today },
      { id: "rush-b", ref: "rush-b", accountId: "rush-wallet", kind: "anyr_deposit", amount: 1n, createdAt: today },
      { id: "rush-credit", ref: "rush-credit", accountId: "rush-key", kind: "credit", amount: 1n, createdAt: today },
      { id: "rush-negative", ref: "rush-negative", accountId: "rush-deposit-wallet", kind: "deposit", amount: 0n, createdAt: today },
    ]);
    const generation = (id: string, accountId: string | null, ts = today, extra = {}) => ({ id, accountId, ts, modelId: "sample/model", providerId: "sample", mode: "prepaid", receiptSig: "fixture-signature", finishReason: "stop", ...extra });
    await h.ctx.db.insert(generations).values([generation("rush-g-old", "rush-existing", old), generation("rush-g-repeat", "rush-existing"), generation("rush-g-a", "rush-wallet"), generation("rush-g-b", "rush-wallet"), generation("rush-g-error", "rush-key", today, { finishReason: "error" }), generation("rush-g-cancelled", "rush-key", today, { cancelled: true }), generation("rush-g-unsigned", "rush-key", today, { receiptSig: null }), generation("rush-g-blind", null)]);
    const result = await readFunnel(h.ctx.db, 90, today);
    expect(result).toHaveLength(90); expect(result.at(-1)).toEqual({ day: "2026-09-30", wallet_sign_ins: 1, first_deposits: 1, first_calls: 1 });
    expect(Object.keys(result.at(-1)!)).toEqual(["day", "wallet_sign_ins", "first_deposits", "first_calls"]);
    expect(result.slice(0, -1).every(d => !d.wallet_sign_ins && !d.first_deposits && !d.first_calls)).toBe(true);
    await expect(readFunnel(h.ctx.db, 91)).rejects.toThrow();
  } finally { await h.close(); }
});
