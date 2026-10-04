import { expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { kv, providers } from "../src/db/schema.ts";
import { encrypt, log } from "../src/lib/util.ts";
import { balanceState } from "../src/rush/balance-state.ts";
import { EXHAUSTED_REMINDER_MS } from "../src/rush/balance-alerts.ts";
import { CREDIT_HOLD_MS, MONITOR_INTERVAL_MS, initializeUpstreamMonitor, parseBalance, refreshUpstreamHealth, registerRushJobs, runUpstreamMonitor, upstreamAdminView, upstreamAlertChecks } from "../src/rush/monitor.ts";
import { markDelivered, planAlerts, runAlertNotifier } from "../src/services/alerts.ts";
import { HealthTracker } from "../src/services/health.ts";
import { Jobs } from "../src/services/jobs.ts";
import { MODELS, startRouter } from "./helpers.ts";

test("USD account shapes accept finite negative, zero and numeric strings without erasing explicit units", () => {
  for (const field of ["balance", "balance_usd", "amount_usd"]) {
    for (const raw of [-0.0039, 0, 1, "-0.0039", "0", "1.25", " -3.9e-3 "]) {
      expect(parseBalance({ [field]: raw })).toBe(Number(raw));
      expect(parseBalance({ data: { [field]: raw } })).toBe(Number(raw));
    }
  }
  expect(parseBalance({ balance: "-2", currency: "USD" })).toBe(-2);
  for (const balance of [NaN, Infinity, -Infinity, "Infinity", "NaN", "", " ", "0x10", "1 USD", true, null, {}, []]) expect(parseBalance({ balance })).toBeNull();
  for (const value of [null, undefined, {}, { balance: 1, currency: "EUR" }]) expect(parseBalance(value)).toBeNull();
  expect([-1, 0, 0.01, 4.99, 5, 24.99, 25].map(n => balanceState(n, 25, 5))).toEqual(["exhausted", "exhausted", "critical", "critical", "warning", "warning", "ok"]);
  expect(balanceState(0.05, 25, 5, 0.1)).toBe("exhausted");
  expect(() => loadConfig({ ANYROUTE_ENV: "test", UPSTREAM_BALANCE_EXHAUSTED_USD: "6" })).toThrow();
  expect(() => loadConfig({ ANYROUTE_ENV: "test", UPSTREAM_BALANCE_EXHAUSTED_USD: "-1" })).toThrow();
});

test("balance alerts transition immediately, deduplicate and remind only after six hours from delivery", () => {
  const prefix = "upstream_0123456789ab_";
  const observed = (level: string) => Object.fromEntries(["warning", "critical", "exhausted"].map(s => [prefix + s, s !== level]));
  const now = Date.UTC(2026, 9, 1);
  const first = planAlerts(null, observed("warning"), now);
  expect(first.transitions.map(t => [t.check, t.state])).toEqual([[prefix + "warning", "failing"]]);
  let prev = markDelivered(first.state, first.transitions);
  expect(planAlerts(prev, observed("warning"), now + 1).transitions).toEqual([]);
  let plan = planAlerts(prev, observed("critical"), now + 2);
  expect(plan.transitions.map(t => [t.check, t.state])).toEqual([[prefix + "warning", "recovered"], [prefix + "critical", "failing"]]);
  prev = markDelivered(plan.state, plan.transitions);
  plan = planAlerts(prev, observed("exhausted"), now + 3);
  expect(plan.transitions.filter(t => t.state === "failing").map(t => t.check)).toEqual([prefix + "exhausted"]);
  // Failed delivery leaves the transition pending.
  expect(planAlerts(plan.state, observed("exhausted"), now + 4).transitions.map(t => t.check)).toContain(prefix + "exhausted");
  prev = markDelivered(plan.state, plan.transitions);
  expect(planAlerts(prev, observed("exhausted"), now + 3 + EXHAUSTED_REMINDER_MS - 1).transitions).toEqual([]);
  plan = planAlerts(prev, observed("exhausted"), now + 3 + EXHAUSTED_REMINDER_MS);
  expect(plan.transitions).toHaveLength(1);
  prev = markDelivered(plan.state, plan.transitions);
  expect(planAlerts(prev, observed("exhausted"), now + 4 + EXHAUSTED_REMINDER_MS).transitions).toEqual([]);
  plan = planAlerts(prev, observed("ok"), now + 5 + EXHAUSTED_REMINDER_MS);
  expect(plan.transitions.map(t => t.state)).toEqual(["recovered"]);
  // Ordinary readiness alerts still sustain failures.
  expect(planAlerts(null, { database: false }, now).transitions).toEqual([]);
});

test("a configured positive exhaustion floor keeps routing blocked through the boundary", async () => {
  const h = await startRouter({ env: { ...monitorEnv, UPSTREAM_BALANCE_EXHAUSTED_USD: "0.1" } });
  try {
    await connectBalance(h);
    for (const balance of [0.05, 0.1]) {
      await runUpstreamMonitor(h.ctx, async () => Response.json({ balance }));
      expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(true);
    }
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: 0.10001 }));
    expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(false);
  } finally { await h.close(); }
});

async function connectBalance(h: Awaited<ReturnType<typeof startRouter>>) {
  await h.ctx.db.update(providers).set({ baseUrl: "https://relay.example/v1", apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "fixture-upstream-key") }).where(eq(providers.id, "alpha"));
  await h.ctx.catalog.refresh();
}
const monitorEnv = { UPSTREAM_MONITOR_ENABLED: "true", CATALOG_CACHE_ENABLED: "true", UPSTREAM_BALANCE_URL: "https://relay.example/balance" };

test("exhaustion survives stale and failed polls, restarts and expired holds; recovery restores exact catalogue bytes", async () => {
  const h = await startRouter({ env: monitorEnv, rand: () => 0 });
  try {
    await connectBalance(h);
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: 30 }));
    const healthy = await (await h.request("/api/v1/models")).text();
    const old = Date.now() - CREDIT_HOLD_MS - MONITOR_INTERVAL_MS;
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: "-0.0039" }), old);
    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, "upstream-balance:alpha"));
    expect(row.value).toEqual({ balance_usd: -0.0039, checked_at: old, status: "ok" });
    expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(true);
    const unavailable = await (await h.request("/api/v1/models")).json() as any;
    expect(unavailable.data.find((m: any) => m.id === MODELS.qwen.slug).availability).toBe("temporarily_unavailable");
    expect(unavailable.data.find((m: any) => m.id === MODELS.llama.slug).availability).toBeUndefined();
    expect(JSON.stringify(unavailable)).not.toContain("balance_usd");
    const replica = new HealthTracker();
    await initializeUpstreamMonitor({ ...h.ctx, health: replica });
    expect(replica.outage(MODELS.qwen.slug, "alpha")).toBe(true);
    for (const fetcher of [async () => Response.json({ unrelated: 5 }), async () => Response.json({}, { status: 500 }), async () => { throw new Error("https://relay.example/balance fixture-upstream-key"); }]) {
      await runUpstreamMonitor(h.ctx, fetcher);
      expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(true);
      const view = (await upstreamAdminView(h.ctx)).providers.find(p => p.provider === "alpha")!;
      expect(view).toMatchObject({ balance_usd: -0.0039, status: "exhausted", checked_at: new Date(old).toISOString(), last_check_status: "unknown" });
    }
    const account = await h.fundedKey();
    const request = { method: "POST", headers: account.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], provider: { order: ["alpha", "beta"] } } };
    const failover = await h.request("/api/v1/chat/completions", request);
    expect(failover.status).toBe(200); expect((await failover.json() as any).provider).toBe("Beta");
    const refused = await h.request("/api/v1/chat/completions", { ...request, json: { ...request.json, model: MODELS.qwen.slug } });
    expect(refused.status).toBe(503); expect(await refused.text()).toContain("temporarily unavailable");
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: 0 }));
    expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(true);
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: "0.01" }));
    await refreshUpstreamHealth(replica, h.ctx.db);
    expect(replica.outage(MODELS.qwen.slug, "alpha")).toBe(false);
    expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(false);
    expect(await (await h.request("/api/v1/models")).text()).toBe(healthy);
    expect(await (await h.request("/v1/models")).text()).toBe(healthy);
    await h.ctx.db.update(providers).set({ baseUrl: h.mocks.alpha.url.toString().replace(/\/$/, "") }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    const recovered = await h.request("/api/v1/chat/completions", { ...request, json: { ...request.json, model: MODELS.qwen.slug } });
    expect(recovered.status).toBe(200);
    await h.ctx.db.insert(kv).values({ key: "upstream-balance:alpha", value: { balance_usd: 0, checked_at: Date.now(), status: "ok" } }).onConflictDoUpdate({ target: kv.key, set: { value: { balance_usd: 0, checked_at: Date.now(), status: "ok" } } });
    // An API replica's warm cache observes another worker's change after the five-second refresh window.
    const clock = spyOn(performance, "now").mockReturnValue(performance.now() + 5_000);
    try { expect(await (await h.request("/api/v1/models")).text()).not.toBe(healthy); }
    finally { clock.mockRestore(); }
  } finally { await h.close(); }
});

test("shared ops delivery deduplicates transitions and reminders without account credential or endpoint details", async () => {
  const h = await startRouter({ env: { ...monitorEnv, ALERT_WEBHOOK_URL: "https://ops.example/alerts" } });
  const messages: string[] = [], logs: unknown[] = [];
  let failDelivery = false;
  const warn = spyOn(log, "warn").mockImplementation((...args) => { logs.push(args); });
  const error = spyOn(log, "error").mockImplementation((...args) => { logs.push(args); });
  try {
    await connectBalance(h);
    let now = Date.now();
    const notify = () => runAlertNotifier(h.ctx, { now: () => now, evaluate: () => upstreamAlertChecks(h.ctx, now), fetch: (async (_url, init) => { messages.push(String(init?.body)); return new Response(null, { status: failDelivery ? 500 : 204 }); }) as typeof fetch });
    for (const balance of [20, 1, -0.0039]) {
      await runUpstreamMonitor(h.ctx, async () => Response.json({ balance }), now);
      expect((await notify()).delivered).toBe(true);
      const count = messages.length;
      expect((await notify()).delivered).toBe(false); expect(messages).toHaveLength(count);
      now += 60_000;
    }
    expect(messages).toHaveLength(3);
    now += EXHAUSTED_REMINDER_MS;
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: -0.0039 }), now);
    await notify(); await notify();
    expect(messages).toHaveLength(4);
    await runUpstreamMonitor(h.ctx, async () => { throw new Error("https://relay.example/balance fixture-upstream-key"); }, now);
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: 30 }), now);
    failDelivery = true;
    await expect(notify()).rejects.toThrow("Alert webhook delivery failed.");
    failDelivery = false;
    expect((await notify()).delivered).toBe(true);
    const count = messages.length;
    expect((await notify()).delivered).toBe(false);
    expect(messages).toHaveLength(count);
    await h.ctx.db.update(providers).set({ headers: { encrypted_v1: encrypt(h.ctx.cfg.appSecret, "fixture-upstream-key relay.example invalid-json") } }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    await runUpstreamMonitor(h.ctx, async () => Response.json({ balance: 30 }), now);
    const output = JSON.stringify({ messages, logs });
    for (const sensitive of ["fixture-upstream-key", "relay.example", "/balance", "authorization", "balance_usd"]) expect(output).not.toContain(sensitive);
    expect(messages.some(body => body.includes("_warning"))).toBe(true);
    expect(messages.some(body => body.includes("_critical"))).toBe(true);
    expect(messages.some(body => body.includes("_exhausted"))).toBe(true);
  } finally { warn.mockRestore(); error.mockRestore(); await h.close(); }
});

test("production config enables the monitor on an explicitly assigned worker at the one-minute interval", async () => {
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", WORKER_JOBS: "upstream-monitor,alert-notifier", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: address, ESCROW_START_BLOCK: "1", ESCROW_TOKENS: JSON.stringify([{ symbol: "STOCK", address, decimals: 18, feed: "0x" + "2".repeat(40) }]), ...monitorEnv });
  expect(cfg.workers.enabled).toBe(true);
  const jobs = new Jobs(undefined, undefined, cfg.workerJobs);
  const h = await startRouter({ env: monitorEnv });
  try {
    await connectBalance(h);
    let balance = -0.0039;
    await h.ctx.db.update(providers).set({ apiKeyEnc: encrypt(cfg.appSecret, "fixture-upstream-key") }).where(eq(providers.id, "alpha"));
    await h.ctx.catalog.refresh();
    const ctx = { ...h.ctx, cfg, jobs };
    registerRushJobs(ctx, async (_url, _init, options) => {
      expect(options?.production).toBe(true);
      return Response.json({ balance });
    });
    expect(jobs.status()).toMatchObject([{ name: "upstream-monitor", every_ms: 60_000 }]);
    expect(await jobs.run("upstream-monitor")).toEqual({ checked: 2 });
    expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(true);
    balance = 30;
    await jobs.run("upstream-monitor");
    expect(h.ctx.health.outage(MODELS.qwen.slug, "alpha")).toBe(false);
    expect(jobs.status()[0]).toMatchObject({ runs: 2, last_error: null });
    expect(jobs.status()[0].last_success).not.toBeNull();
  } finally { await jobs.stop(); await h.close(); }
});
