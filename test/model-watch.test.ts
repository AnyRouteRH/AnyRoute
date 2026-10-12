import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { health, keys, kv, models, providers } from "../src/db/schema.ts";
import { modelWatches } from "../src/model-watch/schema.ts";
import { availability, FRESH_MS, HOLD_MS, initialState, observe, PAIR_MS, replay } from "../src/model-watch/state.ts";
import { routeOutage } from "../src/model-watch/outage.ts";
import { registerModelWatchJob, runModelWatch } from "../src/model-watch/worker.ts";
import { loadConfig } from "../src/config.ts";
import { HealthTracker, type HealthEvent } from "../src/services/health.ts";
import { consumeCode, removeLink } from "../src/telegram/linking.ts";
import { readPreferences, savePreferences } from "../src/notifications/prefs.ts";
import { flushQuietNotifications } from "../src/notifications/telegram.ts";
const PATH = "/api/v1/account/model-watch", MODEL = MODELS.llama.slug;
const event = (at: number, ok = false, providerId = "alpha", extra = {}): HealthEvent => ({ modelId: MODEL, providerId, at, ok, source: "probe", errorKind: ok ? null : "connection", ...extra });
function series(from: number, to: number, ok = false, routes = ["alpha", "beta"]) {
  const result: HealthEvent[] = [];
  for (let at = from; at <= to; at += 15_000) for (const route of routes) result.push(event(at, ok, route));
  return result;
}
test("debounce waits five minutes, resets on changes, and pairs back only after down", () => {
  const state = initialState(0);
  expect(observe(state, "up", 0)).toBeNull(); expect(observe(state, "up", HOLD_MS)).toBeNull();
  expect(observe(state, "down", HOLD_MS)).toBeNull(); expect(observe(state, "down", 2 * HOLD_MS - 1)).toBeNull();
  expect(observe(state, "up", 2 * HOLD_MS)).toBeNull(); expect(observe(state, "down", 2 * HOLD_MS + 1)).toBeNull();
  expect(observe(state, "down", 3 * HOLD_MS + 1)).toBe("down");
  expect(observe(state, "down", 4 * HOLD_MS)).toBeNull();
  expect(observe(state, "up", 4 * HOLD_MS)).toBeNull(); expect(observe(state, "up", 5 * HOLD_MS)).toBe("up");
  expect(observe(state, "up", 6 * HOLD_MS)).toBeNull();
});
test("a rolling hour suppresses new pairs but allows the open pair to recover later", () => {
  const state = initialState(0); observe(state, "down", 0); expect(observe(state, "down", HOLD_MS)).toBe("down");
  observe(state, "up", HOLD_MS + 1); expect(observe(state, "up", 2 * HOLD_MS + 1)).toBe("up");
  observe(state, "down", 2 * HOLD_MS + 2); expect(observe(state, "down", PAIR_MS + HOLD_MS - 1)).toBeNull();
  expect(observe(state, "down", PAIR_MS + HOLD_MS)).toBe("down");
  observe(state, "up", 2 * PAIR_MS); expect(observe(state, "up", 2 * PAIR_MS + HOLD_MS)).toBe("up");
});
test("router and worker share outage rules including caller diversity, rejection and stale probes", () => {
  const now = Date.now();
  for (const events of [[], [event(now)], [event(now, false, "alpha", { source: "traffic" })], [event(now, false, "alpha", { errorKind: "rejected" })], [event(now - 30_001)], [event(now - 5, false, "alpha", { source: "traffic", errorKind: "empty200", caller: "one" }), event(now, false, "alpha", { source: "traffic", errorKind: "empty200", caller: "one" })], [event(now - 5, false, "alpha", { source: "traffic", errorKind: "empty200", caller: "one" }), event(now, false, "alpha", { source: "traffic", errorKind: "empty200", caller: "two" })]]) {
    const tracker = new HealthTracker(); for (const e of events) tracker.record(e);
    expect(routeOutage(events, now)).toBe(tracker.outage(MODEL, "alpha"));
  }
  expect(availability(["alpha", "beta"], [event(now), event(now, true, "beta")], now)).toBe("up");
  expect(availability(["alpha", "beta"], [event(now), event(now, false, "beta")], now)).toBe("down");
  expect(availability([], [event(now)], now)).toBeNull();
  expect(availability(["alpha"], [event(now - 30_001)], now)).toBe("down"); // latest fresh check failed
  expect(availability(["alpha"], [event(now - FRESH_MS - 1)], now)).toBeNull(); // too old to say anything
  expect(availability(["alpha"], [event(now - 6 * 60_000), event(now - 60_000, true)], now)).toBe("up");
});
test("replay catches a brief recovery between ticks, stale gaps and worker restarts", () => {
  const state = initialState(0), events = series(0, HOLD_MS);
  expect(replay(state, ["alpha", "beta"], events, 0)).toBeNull();
  expect(replay(state, ["alpha", "beta"], events, HOLD_MS)).toBe("down");
  const restored = JSON.parse(JSON.stringify(state));
  expect(replay(restored, ["alpha", "beta"], events, HOLD_MS)).toBeNull();
  const interrupted = initialState(0), outage = series(0, HOLD_MS);
  outage.push(event(120_000, true, "alpha"), event(120_001, true, "alpha"), event(120_002, true, "alpha")); outage.sort((a, b) => a.at! - b.at!);
  expect(replay(interrupted, ["alpha", "beta"], outage, HOLD_MS)).toBeNull();
  const stale = initialState(0); expect(replay(stale, ["alpha", "beta"], series(0, 60_000), 60_000 + FRESH_MS + 1)).toBeNull(); // checks went stale
  const stopped = initialState(0); expect(replay(stopped, ["alpha", "beta"], series(0, HOLD_MS * 2), HOLD_MS * 2)).toBe("down");
  // A gap over five minutes starts its hold at the oldest replayed instant, never before that.
  expect(stopped.since).toBe(HOLD_MS);
});
let h: Harness;
type Owner = Awaited<ReturnType<Harness["fundedKey"]>>;
const env = { AGENT_POLICY_ENABLED: "true", MODEL_WATCH_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789", NOTIFICATION_QUIET_HOURS_ENABLED: "true" };
beforeAll(async () => { h = await startRouter({ env }); });
afterAll(async () => { await h?.close(); });
beforeEach(async () => { if (h) { await h.ctx.db.delete(modelWatches); await h.ctx.db.delete(health); } });
async function account(owner: Owner) { const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash)); return key!.accountId; }
async function watch(owner: Owner, at: number) {
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { model: MODEL } })).status).toBe(200);
  const id = await account(owner); await h.ctx.db.update(modelWatches).set({ state: initialState(at) }).where(eq(modelWatches.accountId, id)); return id;
}
async function readings(events: HealthEvent[]) { await h.ctx.db.insert(health).values(events.map(e => ({ modelId: e.modelId, providerId: e.providerId, ts: new Date(e.at!), ok: e.ok, source: e.source, errorKind: e.errorKind }))); }
const tick = (at: number, telegramFetch?: typeof fetch) => runModelWatch(h.ctx, { now: new Date(at), telegramFetch });
async function notices(owner: Owner) { return (await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data.filter((row: any) => row.kind === "model_watch"); }
function telegram() {
  const calls: any[] = [];
  return { calls, fetch: (async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return Response.json({ ok: true, result: { message_id: calls.length } }); }) as typeof fetch };
}
let telegramUid = 159000;
async function link(owner: Owner) { const response = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth }); expect(response.status).toBe(200); return consumeCode(h.ctx, ++telegramUid, (await response.json()).data.code); }
test("default off does no database work and registers no job; enabled worker name is valid", async () => {
  expect(loadConfig({}).modelWatchEnabled).toBe(false);
  expect(loadConfig({ RUNTIME_ROLE: "worker", WORKER_JOBS: "model-watch" }).workerJobs).toEqual(["model-watch"]);
  const off = { ...h.ctx, cfg: { ...h.ctx.cfg, modelWatchEnabled: false }, db: null } as any;
  expect(await runModelWatch(off)).toEqual({ created: 0, skipped: "disabled" });
  const names: string[] = [], jobs = { register: (name: string) => names.push(name) };
  registerModelWatchJob({ ...off, jobs }); expect(names).toEqual([]);
  registerModelWatchJob({ ...h.ctx, cfg: { ...h.ctx.cfg, runtimeRole: "api" }, db: null, jobs } as any); expect(names).toEqual([]);
  expect(await runModelWatch({ ...off, cfg: { ...h.ctx.cfg, runtimeRole: "api" } })).toEqual({ created: 0, skipped: "disabled" });
  registerModelWatchJob({ ...h.ctx, jobs } as any); expect(names).toEqual(["model-watch"]);
  const owner = await h.fundedKey(), enabled = h.ctx.cfg.modelWatchEnabled; h.ctx.cfg.modelWatchEnabled = false;
  try { for (const method of ["GET", "PUT", "DELETE"]) { const response = await h.request(PATH, { method, headers: owner.auth, json: method === "GET" ? undefined : { model: MODEL } }); expect(response.status).toBe(404); expect((await response.json()).error.type).toBe("feature_disabled"); } }
  finally { h.ctx.cfg.modelWatchEnabled = enabled; }
});
test("every route authenticates and refuses ordinary, session, read-only and revoked keys", async () => {
  const owner = await h.fundedKey();
  const child = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "sample-watch-key" } });
  const reader = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "sample-watch-reader", scope: "read" } });
  const session = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { name: "sample-watch-session", budget_usd: 1, ttl_minutes: 5 } });
  expect(session.status).toBe(201);
  const denied = [{}, { authorization: "Bearer invalid" }, { authorization: `Bearer ${(await child.json()).key}` }, { authorization: `Bearer ${(await reader.json()).key}` }, { authorization: `Bearer ${(await session.json()).data.key}` }];
  for (const method of ["GET", "PUT", "DELETE"]) for (const [index, headers] of denied.entries()) expect((await h.request(PATH, { method, headers, json: method === "GET" ? undefined : { model: MODEL } })).status).toBe(index < 2 ? 401 : 403);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash));
  for (const method of ["GET", "PUT", "DELETE"]) expect((await h.request(PATH, { method, headers: owner.auth, json: method === "GET" ? undefined : { model: MODEL } })).status).toBe(401);
});
test("watch mutations are strict, idempotent, isolated and capped at twenty", async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey();
  for (const method of ["PUT", "DELETE"]) for (const json of [{}, { model: MODEL, extra: true }, { model: "" }]) expect((await h.request(PATH, { method, headers: owner.auth, json })).status).toBe(400);
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { model: "unknown/model" } })).status).toBe(404);
  const base = h.ctx.catalog.models.get(MODEL)!;
  const extras = Array.from({ length: 21 }, (_, i) => ({ ...base, id: `sample-watch/model-${i}`, name: `Sample model ${i}` }));
  await h.ctx.db.insert(models).values(extras); await h.ctx.catalog.refresh();
  for (const model of extras.slice(0, 20)) expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { model: model.id } })).status).toBe(200);
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { model: extras[0].id } })).status).toBe(200);
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { model: extras[20].id } })).status).toBe(409);
  const response = await h.request(PATH, { headers: owner.auth }); expect(response.headers.get("cache-control")).toBe("no-store"); expect((await response.json()).data).toHaveLength(20);
  expect((await (await h.request(PATH, { headers: other.auth })).json()).data).toEqual([]);
  for (let i = 0; i < 2; i++) expect((await h.request(PATH, { method: "DELETE", headers: owner.auth, json: { model: extras[0].id } })).status).toBe(200);
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { model: extras[20].id } })).status).toBe(200);
  await h.ctx.db.update(models).set({ hidden: true }).where(eq(models.id, extras[0].id)); await h.ctx.catalog.refresh();
  expect((await h.request(PATH, { method: "PUT", headers: other.auth, json: { model: extras[0].id } })).status).toBe(404);
});
test("database health produces one down/back pair, ignores API memory and prevents duplicate claims", async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey(), start = Date.now() - 20 * 60_000;
  await watch(owner, start); await readings(series(start, start + HOLD_MS));
  expect((await tick(start)).created).toBe(0); expect((await tick(start + HOLD_MS - 1)).created).toBe(0);
  // The API process has no outage observations, but the worker sees the shared database.
  expect(h.ctx.health.outage(MODEL, "alpha")).toBe(false);
  expect((await tick(start + HOLD_MS)).created).toBe(1); expect((await tick(start + HOLD_MS)).created).toBe(0);
  expect((await notices(owner)).map((r: any) => r.title)).toEqual([h.ctx.catalog.models.get(MODEL)!.name + " is unavailable right now"]); expect(await notices(other)).toEqual([]);
  await readings(series(start + HOLD_MS + 15_000, start + 2 * HOLD_MS + 45_000, true));
  await tick(start + HOLD_MS + 45_000); expect((await tick(start + 2 * HOLD_MS + 15_000)).created).toBe(0);
  expect((await tick(start + 2 * HOLD_MS + 15_001)).created).toBe(1);
  const items = await notices(owner); expect(items[0].title).toBe(h.ctx.catalog.models.get(MODEL)!.name + " is back"); expect(items[0].href).toBe("/models/model/?id=" + encodeURIComponent(MODEL));
  await h.request(PATH, { method: "DELETE", headers: owner.auth, json: { model: MODEL } }); expect(await notices(owner)).toEqual([]); expect((await tick(start + 2 * HOLD_MS + 45_000)).created).toBe(0);
});
test("one healthy route prevents down; absent, disabled and stale routes do not prove recovery", async () => {
  const owner = await h.fundedKey(), start = Date.now() - 20 * 60_000, id = await watch(owner, start);
  await readings(series(start, start + HOLD_MS, false, ["alpha"]).concat(series(start, start + HOLD_MS, true, ["beta"])));
  expect((await tick(start + HOLD_MS)).created).toBe(0);
  await h.ctx.db.update(modelWatches).set({ state: { ...initialState(start), down: true, lastDown: start } }).where(eq(modelWatches.accountId, id));
  expect((await tick(start + HOLD_MS + FRESH_MS + 1)).created).toBe(0); // readings older than FRESH_MS prove nothing
  await h.ctx.db.update(providers).set({ status: "disabled" }).where(eq(providers.id, "beta"));
  try { await readings(series(start + HOLD_MS + FRESH_MS + 2, start + 2 * HOLD_MS + FRESH_MS + 2, true, ["beta"])); expect((await tick(start + 2 * HOLD_MS + FRESH_MS + 2)).created).toBe(0); }
  finally { await h.ctx.db.update(providers).set({ status: "live" }).where(eq(providers.id, "beta")); }
});
test("Model watch honors Inbox and Telegram switches, quiet hours, feature rechecks and unlink", async () => {
  const owner = await h.fundedKey(), linked = await link(owner), id = await account(owner), tg = telegram();
  const prefs = await readPreferences(h.ctx.db, id); prefs.channels.model_watch = { inbox: false, telegram: false }; await savePreferences(h.ctx.db, id, prefs);
  const start = Date.now() - 20 * 60_000; await watch(owner, start); await readings(series(start, start + HOLD_MS));
  expect((await tick(start + HOLD_MS, tg.fetch)).created).toBe(1); expect(tg.calls).toHaveLength(0); expect(await notices(owner)).toEqual([]);
  prefs.channels.model_watch.inbox = true; await savePreferences(h.ctx.db, id, prefs); expect(await notices(owner)).toHaveLength(1);
  prefs.channels.model_watch.telegram = true;
  const now = new Date(), clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  prefs.quiet_hours = { from_utc: clock(now.getTime() - 60_000), to_utc: clock(now.getTime() + 3_600_000) }; await savePreferences(h.ctx.db, id, prefs);
  await readings(series(start + HOLD_MS + 15_000, start + 2 * HOLD_MS + 45_000, true));
  expect((await tick(start + 2 * HOLD_MS + 45_000, tg.fetch)).created).toBe(1); expect(tg.calls).toHaveLength(0);
  const future = new Date(now.getTime() + 2 * 3_600_000);
  expect((await flushQuietNotifications({ ...h.ctx, cfg: { ...h.ctx.cfg, modelWatchEnabled: false } }, tg.fetch, future)).sent).toBe(0);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, future)).sent).toBe(1); expect(tg.calls[0].text).toContain(" is back");
  // A later queued notice must be discarded after unlinking.
  const { sendLinkedAlert } = await import("../src/telegram/delivery.ts");
  await sendLinkedAlert(h.ctx, linked, "Sample model is back", owner.hash, tg.fetch, undefined, "model_watch"); await removeLink(h.ctx, linked.uid);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, future)).sent).toBe(0); expect(tg.calls).toHaveLength(1);
});
test("enabled linked Telegram receives one exact notice and failed attempts are not retried", async () => {
  const owner = await h.fundedKey(); await link(owner); const tg = telegram(), start = Date.now() - 20 * 60_000;
  await watch(owner, start); await readings(series(start, start + HOLD_MS));
  expect((await tick(start + HOLD_MS, tg.fetch)).created).toBe(1); expect(tg.calls).toHaveLength(1); expect(tg.calls[0].text).toBe(h.ctx.catalog.models.get(MODEL)!.name + " is unavailable right now");
  expect((await tick(start + HOLD_MS, tg.fetch)).created).toBe(0); expect(tg.calls).toHaveLength(1);
  await readings(series(start + HOLD_MS + 15_000, start + 2 * HOLD_MS + 45_000, true));
  let attempts = 0; const failed = (async () => { attempts++; return Response.json({ ok: false, error_code: 429 }); }) as typeof fetch;
  expect((await tick(start + 2 * HOLD_MS + 45_000, failed)).created).toBe(1); expect(attempts).toBe(1);
  expect((await tick(start + 2 * HOLD_MS + 45_000, tg.fetch)).created).toBe(0); expect(tg.calls).toHaveLength(1);
});

test("unwatch and rewatch preserve the hourly cooldown without using a watch slot", async () => {
  const owner = await h.fundedKey(), start = Date.now() - 20 * 60_000, id = await watch(owner, start);
  await readings(series(start, start + HOLD_MS)); expect((await tick(start + HOLD_MS)).created).toBe(1);
  expect((await h.request(PATH, { method: "DELETE", headers: owner.auth, json: { model: MODEL } })).status).toBe(200);
  expect((await (await h.request(PATH, { headers: owner.auth })).json()).data).toEqual([]);
  let [saved] = await h.ctx.db.select().from(modelWatches).where(eq(modelWatches.accountId, id));
  expect(saved.watching).toBe(false); expect(saved.state.lastDown).toBe(start + HOLD_MS); expect(saved.state.notices).toEqual([]); expect(saved.state.down).toBe(false);
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { model: MODEL } })).status).toBe(200);
  [saved] = await h.ctx.db.select().from(modelWatches).where(eq(modelWatches.accountId, id)); expect(saved.watching).toBe(true); expect(saved.state.lastDown).toBe(start + HOLD_MS);
  const rewatchAt = saved.state.checkedAt; await readings(series(rewatchAt, rewatchAt + HOLD_MS));
  expect((await tick(rewatchAt + HOLD_MS)).created).toBe(0);
  await h.request(PATH, { method: "DELETE", headers: owner.auth, json: { model: MODEL } });
  await tick(start + HOLD_MS + PAIR_MS); expect(await h.ctx.db.select().from(modelWatches).where(eq(modelWatches.accountId, id))).toEqual([]);
});
