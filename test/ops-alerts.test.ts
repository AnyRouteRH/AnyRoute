import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { kv } from "../src/db/schema.ts";
import { ALERT_LEASE_KEY, ALERT_STATE_KEY, markDelivered, planAlerts, renderAlert, resolveFormat, runAlertNotifier, type AlertMessage } from "../src/services/alerts.ts";
import { runAlertDrill } from "../scripts/alert-drill.ts";
import { startRouter, type Harness } from "./helpers.ts";

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const min = 60_000;
const SECRET_URL = "https://hooks.slack.com/services/T000FIXTURE/B000FIXTURE/fixture-webhook-secret";

describe("alert transition planning", () => {
  test("announces a failure only after it is sustained for two minutes, once, then its recovery once", () => {
    let p = planAlerts(null, { database: false, chain: true }, T0);
    expect(p.transitions).toEqual([]);
    p = planAlerts(p.state, { database: false, chain: true }, T0 + min);
    expect(p.transitions).toEqual([]);
    p = planAlerts(p.state, { database: false, chain: true }, T0 + 2 * min);
    expect(p.transitions).toEqual([{ check: "database", state: "failing", since: new Date(T0).toISOString() }]);
    expect(p.state.checks.database.firing).toBe(true);
    markDelivered(p.state, p.transitions);
    p = planAlerts(p.state, { database: false, chain: true }, T0 + 3 * min);
    expect(p.transitions).toEqual([]); // deduplicated
    p = planAlerts(p.state, { database: true, chain: true }, T0 + 4 * min);
    expect(p.transitions).toEqual([{ check: "database", state: "recovered", since: new Date(T0 + 4 * min).toISOString() }]);
    markDelivered(p.state, p.transitions);
    expect(planAlerts(p.state, { database: true, chain: true }, T0 + 5 * min).transitions).toEqual([]);
  });

  test("a failure that clears before the sustain window never notifies", () => {
    let p = planAlerts(null, { redis: false }, T0);
    p = planAlerts(p.state, { redis: false }, T0 + 90_000);
    p = planAlerts(p.state, { redis: true }, T0 + 110_000);
    expect(p.transitions).toEqual([]);
    p = planAlerts(p.state, { redis: false }, T0 + 115_000);
    p = planAlerts(p.state, { redis: false }, T0 + 200_000);
    expect(p.transitions).toEqual([]); // the window restarted when it recovered
  });

  test("undelivered notices are retried and a vanished failing check resolves once", () => {
    let p = planAlerts(null, { backup_fresh: false }, T0);
    p = planAlerts(p.state, { backup_fresh: false }, T0 + 2 * min);
    expect(p.transitions.length).toBe(1);
    p = planAlerts(p.state, { backup_fresh: false }, T0 + 3 * min); // delivery failed: still pending
    expect(p.transitions.map((t) => t.state)).toEqual(["failing"]);
    markDelivered(p.state, p.transitions);
    p = planAlerts(p.state, {}, T0 + 4 * min);
    expect(p.transitions).toEqual([{ check: "backup_fresh", state: "recovered", since: new Date(T0 + 4 * min).toISOString() }]);
    markDelivered(p.state, p.transitions);
    expect(planAlerts(p.state, {}, T0 + 5 * min).state.checks).toEqual({});
  });

  test("unexpected check names are folded into one anonymous check", () => {
    const p = planAlerts(null, { 'host="db.internal"': false, "Bad Name": true }, T0);
    expect(Object.keys(p.state.checks)).toEqual(["unnamed_check"]);
    expect(p.state.checks.unnamed_check.ok).toBe(false);
  });
});

describe("alert rendering", () => {
  const msg: AlertMessage = { kind: "alert", environment: "production", at: new Date(T0).toISOString(), transitions: [{ check: "chain", state: "failing", since: new Date(T0).toISOString() }, { check: "database", state: "recovered", since: new Date(T0).toISOString() }] };
  test("every format carries only check names, states and times", () => {
    for (const format of ["ntfy", "slack", "discord", "json"] as const) {
      const { headers, body } = renderAlert(format, msg);
      const all = JSON.stringify(headers) + body;
      expect(all).toContain("chain");
      expect(all).toContain("database");
      expect(all).not.toMatch(/https?:|secret|password|postgres|railway\.internal/i);
      for (const value of Object.values(headers)) expect(value).toMatch(/^[\x20-\x7e]+$/); // ASCII-only headers
    }
    expect(renderAlert("ntfy", msg).headers.priority).toBe("urgent");
    expect(JSON.parse(renderAlert("discord", msg).body).allowed_mentions).toEqual({ parse: [] });
    expect(JSON.parse(renderAlert("json", msg).body).checks).toEqual([
      { name: "chain", state: "failing", since: new Date(T0).toISOString() },
      { name: "database", state: "recovered", since: new Date(T0).toISOString() },
    ]);
    const drill = renderAlert("ntfy", { ...msg, kind: "test", transitions: [{ check: "alert_delivery", state: "test", since: msg.at }] });
    expect(drill.headers.title).toContain("synthetic test");
    expect(drill.body).toContain("drill");
  });

  test("format detection recognises common webhook hosts and falls back to JSON", () => {
    expect(resolveFormat("https://ntfy.sh/fixture-topic")).toBe("ntfy");
    expect(resolveFormat(SECRET_URL)).toBe("slack");
    expect(resolveFormat("https://discord.com/api/webhooks/1/fixture")).toBe("discord");
    expect(resolveFormat("https://alerts.example/hook")).toBe("json");
    expect(resolveFormat("https://alerts.example/hook", "ntfy")).toBe("ntfy");
  });
});

describe("alert notifier job", () => {
  let h: Harness;
  let clock = T0;
  let observed: Record<string, boolean> = {};
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  let failDelivery = false;
  let deliveryDelayMs = 0;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (deliveryDelayMs) await Bun.sleep(deliveryDelayMs);
    sent.push({ url: String(url), body: String(init?.body), headers: init?.headers as Record<string, string> });
    return new Response("ok", { status: failDelivery ? 500 : 200 });
  }) as typeof fetch;
  const tick = (extra: Parameters<typeof runAlertNotifier>[1] = {}) =>
    runAlertNotifier(h.ctx, { now: () => clock, evaluate: async () => observed, fetch: fakeFetch, ...extra });
  const stateRow = async () => (await h.ctx.db.select().from(kv).where(eq(kv.key, ALERT_STATE_KEY)))[0];

  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.ctx.db.delete(kv).where(eq(kv.key, ALERT_STATE_KEY));
    await h.ctx.db.delete(kv).where(eq(kv.key, ALERT_LEASE_KEY));
    sent.length = 0; clock = T0; failDelivery = false; deliveryDelayMs = 0;
    h.ctx.cfg.alerts.webhookUrl = SECRET_URL;
    h.ctx.cfg.alerts.webhookFormat = undefined;
  });

  test("sends after the sustain window, deduplicates, and announces recovery", async () => {
    observed = { database: false, rate_limiter: true };
    expect((await tick()).notices).toBe(0);
    clock += 2 * min;
    expect(await tick()).toMatchObject({ firing: ["database"], notices: 1, delivered: true });
    clock += min;
    await tick();
    expect(sent.length).toBe(1);
    observed = { database: true, rate_limiter: true };
    clock += min;
    await tick();
    expect(sent.length).toBe(2);
    expect(JSON.parse(sent[0].body).text).toContain("FAILING `database`");
    expect(JSON.parse(sent[1].body).text).toContain("RECOVERED `database`");
    for (const s of sent) expect(s.body).not.toContain("fixture-webhook-secret");
    const row = await stateRow();
    expect(JSON.stringify(row.value)).not.toContain("hooks.slack.com");
    expect((row.value as { checks: Record<string, { notified: string }> }).checks.database.notified).toBe("ok");
  });

  test("without a webhook the job records state only and never sends", async () => {
    h.ctx.cfg.alerts.webhookUrl = undefined;
    observed = { chain: false };
    await tick();
    clock += 3 * min;
    expect(await tick()).toMatchObject({ firing: ["chain"], webhook: false, delivered: false });
    expect(sent.length).toBe(0);
    expect((await stateRow()).value).toMatchObject({ checks: { chain: { ok: false, firing: true, notified: "ok" } } });
  });

  test("failed delivery is retried on the next tick without leaking the URL", async () => {
    observed = { escrow_indexer: false };
    await tick();
    clock += 2 * min;
    failDelivery = true;
    await expect(tick()).rejects.toThrow("Alert webhook delivery failed.");
    failDelivery = false;
    clock += min;
    await tick();
    expect(sent.length).toBe(2);
    clock += min;
    await tick();
    expect(sent.length).toBe(2);
  });

  test("concurrent replicas deliver a notice exactly once", async () => {
    observed = { providers: false };
    await tick();
    clock += 2 * min;
    deliveryDelayMs = 200;
    const results = await Promise.all([tick(), tick(), tick()]);
    expect(sent.length).toBe(1);
    expect(results.filter((r) => "skipped" in r).length).toBe(2);
    deliveryDelayMs = 0;
    clock += min;
    await tick();
    expect(sent.length).toBe(1);
  });

  test("an evaluation error is reported as a check name, never as exception text", async () => {
    const evaluate = async () => { throw new Error("connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432"); };
    await tick({ evaluate });
    clock += 2 * min;
    await tick({ evaluate });
    expect(sent.length).toBe(1);
    expect(sent[0].body).toContain("readiness_evaluation");
    expect(sent[0].body).not.toMatch(/hunter2|db\.internal|ECONNREFUSED/);
  });

  test("a stale lease from a crashed replica expires", async () => {
    await h.ctx.db.insert(kv).values({ key: ALERT_LEASE_KEY, value: { holder: "crashed", until: T0 - 1 } });
    observed = { chain: true };
    expect(await tick()).not.toHaveProperty("skipped");
    await h.ctx.db.insert(kv).values({ key: ALERT_LEASE_KEY, value: { holder: "live", until: T0 + min } });
    expect(await tick()).toHaveProperty("skipped");
  });
});

describe("alert configuration and drill", () => {
  const address = "0x" + "1".repeat(40);
  const base = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, WORKER_JOBS: "alert-notifier,holds-expire" };
  test("the webhook is optional in production; when set it must be https", () => {
    expect(loadConfig(base).alerts.webhookUrl).toBeUndefined();
    expect(loadConfig({ ...base, ALERT_WEBHOOK_URL: "https://ntfy.sh/fixture", ALERT_WEBHOOK_FORMAT: "ntfy" }).alerts).toEqual({ webhookUrl: "https://ntfy.sh/fixture", webhookFormat: "ntfy" });
    expect(() => loadConfig({ ...base, ALERT_WEBHOOK_URL: "http://ntfy.sh/fixture" })).toThrow("https");
    expect(() => loadConfig({ ...base, ALERT_WEBHOOK_URL: "not a url" })).toThrow("https");
    expect(() => loadConfig({ ...base, ALERT_WEBHOOK_FORMAT: "teams" })).toThrow();
    expect(() => loadConfig({ ...base, WORKER_JOBS: "alert-notifier,unknown" })).toThrow();
  });
  test("backup freshness is opt-in with a positive window", () => {
    expect(loadConfig(base).backup).toEqual({ required: false, maxAgeHours: 26 });
    expect(loadConfig({ ...base, BACKUP_REQUIRED: "true", BACKUP_MAX_AGE_HOURS: "8" }).backup).toEqual({ required: true, maxAgeHours: 8 });
    expect(() => loadConfig({ ...base, BACKUP_MAX_AGE_HOURS: "0" })).toThrow();
  });

  test("the drill sends one labelled synthetic alert and never prints the URL", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response(null, { status: 200 }); }) as typeof fetch;
    const ok = await runAlertDrill({ ALERT_WEBHOOK_URL: "https://ntfy.sh/fixture-secret-topic" }, fetchImpl);
    expect(ok.code).toBe(0);
    expect(ok.line).toMatchObject({ ok: true, format: "ntfy", status: 200 });
    expect(JSON.stringify(ok.line)).not.toContain("fixture-secret-topic");
    expect(bodies[0]).toContain("TEST alert_delivery");
    expect((await runAlertDrill({}, fetchImpl)).code).toBe(2);
    expect((await runAlertDrill({ ALERT_WEBHOOK_URL: "http://ntfy.sh/x" }, fetchImpl)).code).toBe(2);
    const refused = await runAlertDrill({ ALERT_WEBHOOK_URL: SECRET_URL }, (async () => new Response(null, { status: 403 })) as unknown as typeof fetch);
    expect(refused.code).toBe(1);
    expect(JSON.stringify(refused.line)).not.toContain("fixture-webhook-secret");
    const down = await runAlertDrill({ ALERT_WEBHOOK_URL: SECRET_URL }, (async () => { throw new Error(`connect failed ${SECRET_URL}`); }) as unknown as typeof fetch);
    expect(down.code).toBe(1);
    expect(JSON.stringify(down.line)).not.toContain("fixture-webhook-secret");
  });
});
