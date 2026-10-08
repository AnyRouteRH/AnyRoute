import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { agentActionDecisions } from "../src/agents/guard-schema.ts";
import { QUIET_HOURS, QUIET_PREFIX, quietDue, quietTitle, readQuietSetting, registerQuietAlertsJob, runQuietAlerts, saveQuietSetting } from "../src/agents/quiet-alerts.ts";
import { keys, kv, ledger, teamMembers } from "../src/db/schema.ts";
import { linkKey } from "../src/telegram/linking.ts";
import { startRouter, type Harness } from "./helpers.ts";

let h: Harness, off: Harness, sequence = 0;
const HOUR = 3_600_000;
const policy = { version: 1, models: {}, caps: {}, on_breach: "deny", alerts: {} };
type Key = { hash: string; auth: Record<string, string> };
const path = (key: Key) => `/api/v1/agents/${key.hash}/quiet-alert`;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
beforeAll(async () => {
  h = await startRouter({ env: { QUIET_AGENT_ALERTS_ENABLED: "true", AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "141:fixture-only-telegram-token" } });
  off = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
});
afterAll(async () => { await h?.close(); await off?.close(); });
beforeEach(async () => { await h.ctx.db.delete(kv).where(like(kv.key, QUIET_PREFIX + "%")); });
const row = async (key: Key) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0];
async function enable(key: Key, hours: typeof QUIET_HOURS[number] = 6, at = ago(24)) { await saveQuietSetting(h.ctx, await row(key), hours, at); }
async function charge(key: Key, at: Date, kind = "usage", amount = -1n) {
  const owner = await row(key), id = `quiet-charge-${++sequence}`;
  await h.ctx.db.insert(ledger).values({ id, ref: id, accountId: owner.accountId, keyHash: key.hash, amount, kind, createdAt: at });
}
async function guard(key: Key, at: Date, decision: "allow" | "deny" | "approval_required" = "allow") {
  await h.ctx.db.insert(agentActionDecisions).values({ id: `quiet-decision-${++sequence}`, keyHash: key.hash, eventId: sequence, action: "purchase", amountPico: 0n, decision, createdAt: at });
}
async function inbox(key: Key, router = h, since?: string) {
  const response = await router.request("/api/v1/inbox" + (since ? "?since=" + encodeURIComponent(since) : ""), { headers: key.auth });
  expect(response.status).toBe(200);
  return (await response.json()).data.filter((item: any) => item.kind === "quiet-agent");
}
async function child(owner: Key) {
  const value = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: {} })).json();
  return { hash: value.data.hash, auth: { authorization: "Bearer " + value.key } };
}

test("all windows use elapsed UTC time, including boundary and once per anchor", () => {
  const anchor = "2026-10-07T01:00:00.000Z";
  for (const hours of QUIET_HOURS) {
    expect(quietDue(hours, anchor, null, new Date(Date.parse(anchor) + hours * HOUR - 1))).toBe(false);
    expect(quietDue(hours, anchor, null, new Date(Date.parse(anchor) + hours * HOUR))).toBe(true);
    expect(quietDue(hours, anchor, anchor, new Date(Date.parse(anchor) + 100 * HOUR))).toBe(false);
    expect(quietDue(hours, anchor, "2026-10-08T01:00:00.000Z", new Date("2027-01-01Z"))).toBe(false);
  }
  expect(quietDue(null, anchor, null, new Date("2027-01-01Z"))).toBe(false);
  expect(quietDue(1, anchor, null, new Date("2026-10-07T03:00:00+02:00"))).toBe(false);
  expect(quietTitle("shop-agent", 6, "2026-10-07T14:05:00Z")).toBe("shop-agent has made no calls for 6 hours (last call 14:05 UTC)");
  expect(quietTitle(null, 1, null)).toBe("Unnamed agent has made no calls for 1 hour (no calls recorded)");
});
test("flag off and API role register no job, make no reads and add no inbox items", async () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).quietAgentAlertsEnabled).toBe(false);
  expect(off.ctx.jobs.status().some(job => job.name === "quiet-agent-alerts")).toBe(false);
  expect(h.ctx.jobs.status().find(job => job.name === "quiet-agent-alerts")?.every_ms).toBe(300_000);
  const registered: string[] = [];
  for (const cfg of [{ quietAgentAlertsEnabled: false }, { quietAgentAlertsEnabled: true, agentPolicyEnabled: false }, { quietAgentAlertsEnabled: true, agentPolicyEnabled: true, runtimeRole: "api" }]) {
    registerQuietAlertsJob({ cfg, jobs: { register: (name: string) => registered.push(name) } } as any);
    expect(await runQuietAlerts({ cfg } as any)).toEqual({ skipped: true, created: 0 });
  }
  expect(registered).toEqual([]);
  const owner = await off.newKey();
  for (const method of ["GET", "PUT"]) {
    expect((await off.request(path(owner), { method, headers: owner.auth, ...(method === "PUT" ? { json: { hours: 6 } } : {}) })).status).toBe(404);
    expect((await off.request(path(owner), { method })).status).toBe(404);
  }
  expect(await inbox(owner, off)).toEqual([]);
});
test("GET defaults to Off; PUT validates choices and leaves existing agents response and rulebook unchanged", async () => {
  const owner = await h.newKey();
  await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy });
  const before = await (await h.request("/api/v1/agents", { headers: owner.auth })).text();
  const response = await h.request(path(owner), { headers: owner.auth });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ data: { key_hash: owner.hash, hours: null } });
  for (const hours of [...QUIET_HOURS, null]) {
    const saved = await h.request(path(owner), { method: "PUT", headers: owner.auth, json: { hours } });
    expect(saved.status).toBe(200); expect((await saved.json()).data.hours).toBe(hours);
    expect((await (await h.request(path(owner), { headers: owner.auth })).json()).data.hours).toBe(hours);
  }
  for (const body of [{ hours: 0 }, { hours: 2 }, { hours: "6" }, {}, { hours: 6, quiet: true }]) expect((await h.request(path(owner), { method: "PUT", headers: owner.auth, json: body })).status).toBe(400);
  expect(await (await h.request("/api/v1/agents", { headers: owner.auth })).text()).toBe(before);
});
test("once per quiet period, even across concurrent workers; next charged call re-arms between checks", async () => {
  const owner = await h.newKey(), now = new Date(); await enable(owner); await charge(owner, new Date(now.getTime() - 7 * HOUR));
  const results = await Promise.all([runQuietAlerts(h.ctx, { now }), runQuietAlerts(h.ctx, { now })]);
  expect(results.reduce((n, result) => n + result.created, 0)).toBe(1);
  expect(await runQuietAlerts(h.ctx, { now })).toEqual({ created: 0 });
  expect(await inbox(owner)).toHaveLength(1);
  // No worker runs during the intervening active period.
  await charge(owner, new Date(now.getTime() + HOUR));
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 7 * HOUR - 1) })).created).toBe(0);
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 7 * HOUR) })).created).toBe(1);
  expect((await readQuietSetting(h.ctx.db, owner.hash))?.notices).toHaveLength(2);
});
test("Guard allow, deny and ask-first decisions refresh the clock; unrelated ledger kinds do not", async () => {
  const owner = await h.newKey(), now = new Date(); await enable(owner);
  for (const decision of ["allow", "deny", "approval_required"] as const) {
    await guard(owner, new Date(now.getTime() - HOUR), decision);
  }
  await charge(owner, now, "deposit", 10n); await charge(owner, now, "withdrawal");
  await charge(owner, new Date(now.getTime() + HOUR));
  expect((await runQuietAlerts(h.ctx, { now })).created).toBe(0);
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 5 * HOUR) })).created).toBe(0);
  // The future call becomes real at that later worker time and sets a later boundary.
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 7 * HOUR) })).created).toBe(1);
});
test("never-called agents wait from enable time; saving and changing a window preserve an already reported period", async () => {
  const owner = await h.newKey(), now = new Date(); await enable(owner, 1, new Date(now.getTime() - HOUR));
  await saveQuietSetting(h.ctx, await row(owner), 1, now);
  expect((await runQuietAlerts(h.ctx, { now })).created).toBe(1);
  await saveQuietSetting(h.ctx, await row(owner), 1, now);
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + HOUR) })).created).toBe(0);
  await saveQuietSetting(h.ctx, await row(owner), 3, now);
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 3 * HOUR - 1) })).created).toBe(0);
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 3 * HOUR) })).created).toBe(0);
  await saveQuietSetting(h.ctx, await row(owner), null, now);
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 72 * HOUR) })).created).toBe(0);
});
test("existing charged calls anchor a newly enabled alert; a later Guard decision re-arms it", async () => {
  const owner = await h.newKey(), now = new Date();
  await charge(owner, new Date(now.getTime() - 7 * HOUR));
  expect((await h.request(path(owner), { method: "PUT", headers: owner.auth, json: { hours: 6 } })).status).toBe(200);
  expect((await runQuietAlerts(h.ctx, { now })).created).toBe(1);
  await saveQuietSetting(h.ctx, await row(owner), 1, now);
  expect((await runQuietAlerts(h.ctx, { now })).created).toBe(0);
  await guard(owner, new Date(now.getTime() + HOUR));
  expect((await runQuietAlerts(h.ctx, { now: new Date(now.getTime() + 2 * HOUR) })).created).toBe(1);
});
test("stopped, disabled and expired keys are excluded; resume makes the old clock eligible again", async () => {
  const owner = await h.newKey(); await enable(owner);
  await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy });
  expect((await h.request(`/api/v1/agents/${owner.hash}/kill`, { method: "POST", headers: owner.auth, json: {} })).status).toBe(200);
  expect((await runQuietAlerts(h.ctx)).created).toBe(0);
  await h.request(`/api/v1/agents/${owner.hash}/resume`, { method: "POST", headers: owner.auth });
  expect((await runQuietAlerts(h.ctx)).created).toBe(1);
  for (const field of [{ disabled: true }, { expiresAt: ago(1) }]) {
    const key = await h.newKey(); await enable(key); await h.ctx.db.update(keys).set(field).where(eq(keys.keyHash, key.hash));
  }
  expect((await runQuietAlerts(h.ctx)).created).toBe(0);
});
test("session activity refreshes its parent; inherited Stop excludes a session", async () => {
  const owner = await h.newKey(); await enable(owner);
  const value = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  const session = { hash: value.key_hash, auth: { authorization: "Bearer " + value.key } };
  await charge(session, ago(1)); expect((await runQuietAlerts(h.ctx)).created).toBe(0);
  await enable(session);
  await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy });
  await h.request(`/api/v1/agents/${owner.hash}/kill`, { method: "POST", headers: owner.auth, json: {} });
  expect((await runQuietAlerts(h.ctx)).created).toBe(0);
});
test("GET and PUT require owner/management auth; inference, session, foreign, disabled and expired keys refused", async () => {
  const owner = await h.newKey(), foreign = await h.newKey(), ordinary = await child(owner);
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  for (const method of ["GET", "PUT"]) {
    const request = (headers: Record<string, string>, target = owner) => h.request(path(target), { method, headers, ...(method === "PUT" ? { json: { hours: 6 } } : {}) });
    expect((await request({})).status).toBe(401);
    expect((await request({ authorization: "Bearer invalid" })).status).toBe(401);
    expect((await request(ordinary.auth)).status).toBe(403);
    expect((await request({ authorization: "Bearer " + session.key })).status).toBe(403);
    expect((await request(foreign.auth)).status).toBe(404);
  }
  await h.ctx.db.update(keys).set({ scope: "inference" }).where(eq(keys.keyHash, ordinary.hash));
  for (const method of ["GET", "PUT"]) expect((await h.request(path(owner), { method, headers: ordinary.auth, ...(method === "PUT" ? { json: { hours: 6 } } : {}) })).status).toBe(403);
  for (const field of [{ disabled: true }, { expiresAt: ago(1) }]) {
    const key = await h.newKey(); await h.ctx.db.update(keys).set(field).where(eq(keys.keyHash, key.hash));
    expect((await h.request(path(owner), { headers: key.auth })).status).toBe(401);
  }
});
test("team ownership scopes settings and inbox; ordinary/session keys never get owner notices", async () => {
  const owner = await h.newKey(), admin = await child(owner), peer = await child(owner), hidden = await child(owner), foreign = await h.newKey();
  for (const key of [admin, peer]) await h.ctx.db.update(keys).set({ teamId: "quiet-team-a" }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.update(keys).set({ teamId: "quiet-team-b" }).where(eq(keys.keyHash, hidden.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "quiet-team-a", keyHash: admin.hash, role: "admin" });
  for (const key of [peer, hidden, foreign]) await enable(key);
  for (const method of ["GET", "PUT"]) {
    const request = (target: Key) => h.request(path(target), { method, headers: admin.auth, ...(method === "PUT" ? { json: { hours: 6 } } : {}) });
    expect((await request(peer)).status).toBe(200);
    expect((await request(hidden)).status).toBe(403);
    expect((await request(foreign)).status).toBe(404);
  }
  await runQuietAlerts(h.ctx);
  expect(await inbox(owner)).toHaveLength(2); expect(await inbox(admin)).toHaveLength(1);
  expect(await inbox(peer)).toHaveLength(0); expect(await inbox(foreign)).toHaveLength(1);
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect(await inbox({ hash: "unused", auth: { authorization: "Bearer " + session.key } })).toHaveLength(0);
  const notices = await inbox(owner);
  expect(await inbox(owner, h, notices.at(-1).at)).toHaveLength(0);
});
test("Telegram receives one readable notice after claim, never retries failed sends", async () => {
  const owner = await h.newKey(), key = await row(owner), now = new Date(); await enable(owner);
  await h.ctx.db.insert(kv).values({ key: linkKey(14101), value: { account: key.accountId, key_hash: key.keyHash, uid: 14101, generation: "quiet-link", linked_at: now.toISOString() } });
  const sent: any[] = [];
  const telegramFetch = (async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  expect((await runQuietAlerts(h.ctx, { now, telegramFetch })).created).toBe(1);
  await runQuietAlerts(h.ctx, { now, telegramFetch }); expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain("has made no calls for 6 hours (no calls recorded)");
  await charge(owner, new Date(now.getTime() + HOUR));
  let attempts = 0;
  const failed = (async () => { attempts++; throw new Error("fixture send failed"); }) as typeof fetch;
  const later = new Date(now.getTime() + 7 * HOUR);
  await runQuietAlerts(h.ctx, { now: later, telegramFetch: failed });
  await runQuietAlerts(h.ctx, { now: later, telegramFetch: failed }); expect(attempts).toBe(1);
  expect((await readQuietSetting(h.ctx.db, key.keyHash))?.notices).toHaveLength(2);
});
