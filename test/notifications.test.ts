import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { keys, kv, generations } from "../src/db/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { encrypt } from "../src/lib/util.ts";
import { runAgentAlerts } from "../src/agents/alert-delivery.ts";
import { weeklyInbox } from "../src/notifications/inbox.ts";
import { previousIsoWeek } from "../src/telegram/weekly-summary-text.ts";
import { noticeFeatureEnabled } from "../src/notifications/config.ts";
import { loadConfig } from "../src/config.ts";
import { NOTICE_TYPES, readPreferences, quietUntil, type Preferences } from "../src/notifications/prefs.ts";
import { filterNotificationInbox } from "../src/notifications/inbox.ts";
import { deferTelegram, flushQuietNotifications, registerNotificationQuietJob } from "../src/notifications/telegram.ts";
import { consumeCode, removeLink } from "../src/telegram/linking.ts";
import { sendLinkedAlert, deliverTelegramApprovals } from "../src/telegram/delivery.ts";
import { TelegramApi } from "../src/services/telegram.ts";
let h: Harness, uid = 146000;
const PATH = "/api/v1/account/notifications";
const env = { TELEGRAM_LINKING_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789", WEEKLY_SUMMARY_ENABLED: "true", SECURITY_ALERTS_ENABLED: "true", NOTIFICATION_QUIET_HOURS_ENABLED: "true", DEPOSIT_PINGS_ENABLED: "true" };
beforeAll(async () => { h = await startRouter({ env }); });
afterAll(async () => { await h?.close(); });
type Owner = Awaited<ReturnType<Harness["fundedKey"]>>;
async function principal(owner: Owner) { const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash)); return row!; }
async function linked(owner: Owner) {
  const res = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth });
  expect(res.status).toBe(200); return consumeCode(h.ctx, ++uid, (await res.json()).data.code);
}
async function read(owner: Owner) { const res = await h.request(PATH, { headers: owner.auth }); expect(res.status).toBe(200); return (await res.json()).data; }
async function save(owner: Owner, value: Preferences) { const res = await h.request(PATH, { method: "PUT", headers: owner.auth, json: { channels: value.channels, quiet_hours: value.quiet_hours } }); expect(res.status).toBe(200); return (await res.json()).data; }
function telegram() {
  const calls: any[] = [];
  const fetch = (async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return Response.json({ ok: true, result: { message_id: calls.length } }); }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const clock = (date: Date) => date.toISOString().slice(11, 16);
function quietNow() { const now = new Date(); return { from_utc: clock(new Date(now.getTime() - 60_000)), to_utc: clock(new Date(now.getTime() + 60 * 60_000)) }; }
const kinds = ["approval", "alert", "deposit", "low_balance", "weekly_summary", "security", "quiet-agent", "price_notice", "project_budget", "schedule"];
test("quiet windows include start, exclude end, wrap midnight and reject equal clocks as a delay", () => {
  const quiet = { from_utc: "22:00", to_utc: "08:00" };
  for (const at of ["2026-10-10T22:00:00Z", "2026-10-11T07:59:59Z"]) expect(quietUntil(quiet, new Date(at))?.toISOString()).toBe("2026-10-11T08:00:00.000Z");
  for (const at of ["2026-10-10T21:59:59Z", "2026-10-11T08:00:00Z"]) expect(quietUntil(quiet, new Date(at))).toBeNull();
  expect(quietUntil({ from_utc: "09:00", to_utc: "17:00" }, new Date("2026-10-10T10:00Z"))?.toISOString()).toBe("2026-10-10T17:00:00.000Z");
  expect(quietUntil({ from_utc: "08:00", to_utc: "08:00" })).toBeNull();
});
test("off/default worker is absent and does not touch a database; selected job is allowed", async () => {
  expect(loadConfig({}).notificationQuietHoursEnabled).toBe(false);
  expect(loadConfig({ ...env, RUNTIME_ROLE: "worker", WORKER_JOBS: "notification-quiet" }).workerJobs).toEqual(["notification-quiet"]);
  const off = { ...h.ctx, cfg: { ...h.ctx.cfg, notificationQuietHoursEnabled: false } };
  expect(await flushQuietNotifications(off)).toEqual({ sent: 0, skipped: "disabled" });
  const names: string[] = [];
  registerNotificationQuietJob({ ...off, jobs: { register: (name: string) => names.push(name) } } as any);
  expect(names).toEqual([]);
  registerNotificationQuietJob({ ...h.ctx, jobs: { register: (name: string) => names.push(name) } } as any);
  expect(names).toEqual(["notification-quiet"]);
});
test("GET/PUT authenticate, isolate accounts, exclude ordinary and session keys and validate strictly", async () => {
  for (const method of ["GET", "PUT"]) expect((await h.request(PATH, { method, json: method === "PUT" ? {} : undefined })).status).toBe(401);
  const owner = await h.fundedKey(), other = await h.fundedKey();
  const response = await h.request(PATH, { headers: owner.auth }); expect(response.headers.get("cache-control")).toBe("no-store");
  const value = (await response.json()).data;
  expect(value.telegram_linked).toBe(false); expect(value.quiet_hours).toBeNull();
  expect(value.channels.weekly_summary).toEqual({ inbox: false, telegram: false });
  for (const type of NOTICE_TYPES.filter(t => t !== "weekly_summary")) expect(value.channels[type]).toEqual({ inbox: true, telegram: true });
  for (const json of [{}, { channels: {} }, { ...value }, { channels: value.channels, quiet_hours: { from_utc: "24:00", to_utc: "08:00" } }]) expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json })).status).toBe(400);
  value.channels.agent_alerts.inbox = false; await save(owner, value);
  expect((await read(other)).channels.agent_alerts.inbox).toBe(true);
  const child = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "sample-notice-key" } });
  const childAuth = { authorization: `Bearer ${(await child.json()).key}` };
  for (const method of ["GET", "PUT"]) expect((await h.request(PATH, { method, headers: childAuth, json: method === "PUT" ? { channels: value.channels, quiet_hours: null } : undefined })).status).toBe(403);
  const session = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { name: "sample-session", budget_usd: 1, ttl_minutes: 5 } });
  expect(session.status).toBe(201);
  const body = await session.json();
  for (const method of ["GET", "PUT"]) expect((await h.request(PATH, { method, headers: { authorization: `Bearer ${body.data.key}` }, json: method === "PUT" ? { channels: value.channels, quiet_hours: null } : undefined })).status).toBe(403);
  value.channels.weekly_summary.telegram = true;
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: { channels: value.channels, quiet_hours: null } })).status).toBe(409);
});
test("each notice respects both switches and defaults keep exact Telegram text", async () => {
  const owner = await h.fundedKey(), link = await linked(owner), caller = await principal(owner), tg = telegram();
  let value = await read(owner);
  value.channels.weekly_summary.telegram = true; value.channels.weekly_summary.inbox = true; value = await save(owner, value);
  for (const [index, type] of NOTICE_TYPES.entries()) {
    const text = `Notice ${type}`;
    expect(await sendLinkedAlert(h.ctx, link, text, owner.hash, tg.fetch, undefined, type)).toBe(true);
    expect(tg.calls.at(-1).text).toBe(text);
    const before = tg.calls.length;
    value.channels[type].telegram = false; value.channels[type].inbox = false; await save(owner, value);
    expect(await sendLinkedAlert(h.ctx, link, text, owner.hash, tg.fetch, undefined, type)).toBe(true);
    expect(tg.calls.length).toBe(before);
    const items = [{ kind: kinds[index]!, title: text }, { kind: "agreement", title: "Agreement" }];
    await filterNotificationInbox(h.ctx, caller.accountId, items); expect(items.map(i => i.kind)).toEqual(["agreement"]);
    value.channels[type].telegram = true; value.channels[type].inbox = true; await save(owner, value);
    await filterNotificationInbox(h.ctx, caller.accountId, items); // Never re-add hidden rows.
    const enabled = [{ kind: kinds[index]! }]; await filterNotificationInbox(h.ctx, caller.accountId, enabled); expect(enabled).toHaveLength(1);
  }
});
test("weekly and security legacy controls share values with the page in both directions", async () => {
  const owner = await h.fundedKey(); await linked(owner); let value = await read(owner);
  await h.request("/api/v1/telegram/weekly-summary", { method: "PUT", headers: owner.auth, json: { opted_in: true } });
  expect((await read(owner)).channels.weekly_summary.telegram).toBe(true);
  value.channels.weekly_summary.telegram = false; value.channels.security_alerts = { inbox: false, telegram: true }; await save(owner, value);
  expect((await (await h.request("/api/v1/telegram/weekly-summary", { headers: owner.auth })).json()).data.opted_in).toBe(false);
  expect((await read(owner)).channels.security_alerts).toEqual({ inbox: false, telegram: true });
  await h.request("/api/v1/account/security-alerts", { method: "PATCH", headers: owner.auth, json: { enabled: false } });
  expect((await read(owner)).channels.security_alerts).toEqual({ inbox: false, telegram: false });
  await h.request("/api/v1/account/security-alerts", { method: "PATCH", headers: owner.auth, json: { enabled: true } });
  expect((await read(owner)).channels.security_alerts).toEqual({ inbox: true, telegram: true });
});
test("quiet messages wait and bundle, approvals send immediately with buttons, muted approvals skip", async () => {
  const owner = await h.fundedKey(), link = await linked(owner), tg = telegram(); let value = await read(owner);
  value.quiet_hours = quietNow(); await save(owner, value);
  await sendLinkedAlert(h.ctx, link, "First alert", owner.hash, tg.fetch, undefined, "agent_alerts");
  await sendLinkedAlert(h.ctx, link, "Deposit credited", owner.hash, tg.fetch, undefined, "deposits");
  expect(tg.calls).toHaveLength(0); expect((await flushQuietNotifications(h.ctx, tg.fetch)).sent).toBe(0);
  const id = "E146approvalnotice0000001";
  await h.ctx.db.insert(agentApprovals).values({ id, keyHash: owner.hash, intent: {}, intentHash: "notification-intent", maxCostPico: 1n, expiresAt: new Date(Date.now() + 900_000) });
  await deliverTelegramApprovals(h.ctx, new TelegramApi(env.TELEGRAM_BOT_TOKEN, tg.fetch));
  expect(tg.calls).toHaveLength(1); expect(tg.calls[0].reply_markup.inline_keyboard[0][0].text).toBe("Approve");
  value.channels.approvals.telegram = false; await save(owner, value);
  await h.ctx.db.insert(agentApprovals).values({ id: "E146approvalnotice0000002", keyHash: owner.hash, intent: {}, intentHash: "notification-intent", maxCostPico: 1n, expiresAt: new Date(Date.now() + 900_000) });
  await deliverTelegramApprovals(h.ctx, new TelegramApi(env.TELEGRAM_BOT_TOKEN, tg.fetch)); expect(tg.calls).toHaveLength(1);
  expect((await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data.filter((r: any) => r.kind === "approval")).toHaveLength(2);
  value.channels.approvals.inbox = false; await save(owner, value);
  expect((await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data.filter((r: any) => r.kind === "approval")).toHaveLength(0);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date(Date.now() + 2 * 3_600_000))).sent).toBe(1);
  expect(tg.calls).toHaveLength(2); expect(tg.calls[1].text).toContain("2 notifications"); expect(tg.calls[1].text).toContain("First alert"); expect(tg.calls[1].text).toContain("Deposit credited");
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date(Date.now() + 2 * 3_600_000))).sent).toBe(0);
});
test("queue encrypts preview text, rejects revoked links, honors muting and pauses while off", async () => {
  const owner = await h.fundedKey(), link = await linked(owner), tg = telegram(), caller = await principal(owner); const value = await read(owner);
  value.quiet_hours = { from_utc: "22:00", to_utc: "08:00" }; await save(owner, value);
  const now = new Date("2026-10-10T23:00:00Z");
  expect(await deferTelegram(h.ctx, link, owner.hash, "Private answer preview", "scheduled_results", caller, now)).toBe(true);
  const queue = await h.ctx.db.select().from(kv).where(like(kv.key, "notification-quiet:%")); expect(JSON.stringify(queue)).not.toContain("Private answer preview");
  expect((await flushQuietNotifications({ ...h.ctx, cfg: { ...h.ctx.cfg, notificationQuietHoursEnabled: false } }, tg.fetch)).sent).toBe(0);
  await removeLink(h.ctx, link.uid);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date("2026-10-11T08:00Z"))).sent).toBe(0);
  const next = await linked(owner); await deferTelegram(h.ctx, next, owner.hash, "Muted alert", "agent_alerts", caller, now);
  value.channels.agent_alerts.telegram = false; await save(owner, value);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date("2026-10-11T08:00Z"))).sent).toBe(0); expect(tg.calls).toHaveLength(0);
  const off = { ...h.ctx, cfg: { ...h.ctx.cfg, notificationQuietHoursEnabled: false } };
  expect(await deferTelegram(off, next, owner.hash, "Outside quiet feature", "deposits", caller, now)).toBe(false);
});
test("every source feature guard is rechecked at queue delivery, including API role", async () => {
  const flags = { approvals: "agentPolicyEnabled", agent_alerts: "agentPolicyEnabled", deposits: "depositPingsEnabled", low_balance: "lowBalanceAlertsEnabled", weekly_summary: "weeklySummaryEnabled", security_alerts: "securityAlertsEnabled", quiet_agents: "quietAgentAlertsEnabled", price_notices: "priceNoticesEnabled", project_budgets: "projectBudgetTelegramEnabled", scheduled_results: "scheduledPromptsEnabled" } as const;
  for (const type of NOTICE_TYPES) {
    expect(noticeFeatureEnabled({ ...h.ctx, cfg: { ...h.ctx.cfg, [flags[type]]: false } }, type)).toBe(false);
    expect(noticeFeatureEnabled({ ...h.ctx, cfg: { ...h.ctx.cfg, [flags[type]]: true } }, type)).toBe(true);
  }
  expect(await flushQuietNotifications({ ...h.ctx, cfg: { ...h.ctx.cfg, runtimeRole: "api" } })).toEqual({ sent: 0, skipped: "disabled" });
  const owner = await h.fundedKey(), link = await linked(owner), caller = await principal(owner), tg = telegram();
  const value = await read(owner); value.quiet_hours = { from_utc: "22:00", to_utc: "08:00" }; await save(owner, value);
  await deferTelegram(h.ctx, link, owner.hash, "Scheduled answer", "scheduled_results", caller, new Date("2026-10-10T23:00Z"));
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date("2026-10-11T08:00Z"))).sent).toBe(0);
  expect((await flushQuietNotifications({ ...h.ctx, cfg: { ...h.ctx.cfg, scheduledPromptsEnabled: true } }, tg.fetch, new Date("2026-10-11T08:00Z"))).sent).toBe(1);
  expect(tg.calls[0].text).toContain("Scheduled answer");
});
test("legacy Telegram agent alerts use the same switch, quiet queue and current key authority", async () => {
  const owner = await h.fundedKey(), caller = await principal(owner), tg = telegram(), legacyUid = ++uid;
  await h.ctx.db.insert(kv).values({ key: `telegram:user:${legacyUid}`, value: { v: 1, key: encrypt(h.ctx.cfg.appSecret, `tg:${legacyUid}:${owner.secret}`) } });
  expect((await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, on_breach: "deny", alerts: { channels: ["telegram"] } } })).status).toBe(200);
  let value = await read(owner); value.channels.agent_alerts.telegram = false; await save(owner, value);
  await h.request(`/api/v1/agents/${owner.hash}/kill`, { method: "POST", headers: owner.auth, json: {} });
  await runAgentAlerts(h.ctx, { telegramFetch: tg.fetch }); expect(tg.calls).toHaveLength(0);
  value.channels.agent_alerts.telegram = true; value.quiet_hours = quietNow(); await save(owner, value);
  await h.request(`/api/v1/agents/${owner.hash}/kill`, { method: "POST", headers: owner.auth, json: {} });
  await runAgentAlerts(h.ctx, { telegramFetch: tg.fetch }); expect(tg.calls).toHaveLength(0);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date(Date.now() + 2 * 3_600_000))).sent).toBe(1); expect(tg.calls[0].chat_id).toBe(legacyUid);
  await deferTelegram(h.ctx, { account: caller.accountId, key_hash: caller.keyHash, uid: legacyUid, generation: caller.keyHash, linked_at: new Date().toISOString() }, owner.hash, "Revoked legacy alert", "agent_alerts", caller, new Date(), true);
  await h.ctx.db.delete(kv).where(eq(kv.key, `telegram:user:${legacyUid}`));
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date(Date.now() + 2 * 3_600_000))).sent).toBe(0); expect(tg.calls).toHaveLength(1);
});
test("queued failures retry, while expired messages and revoked principal keys are discarded", async () => {
  const owner = await h.fundedKey(), link = await linked(owner), caller = await principal(owner), value = await read(owner), tg = telegram();
  value.quiet_hours = { from_utc: "22:00", to_utc: "08:00" }; await save(owner, value);
  await deferTelegram(h.ctx, link, owner.hash, "Retry notice", "agent_alerts", caller, new Date("2026-10-10T23:00Z"));
  const failed = (async () => Response.json({ ok: false, error_code: 429 })) as typeof fetch;
  expect((await flushQuietNotifications(h.ctx, failed, new Date("2026-10-11T08:00Z"))).sent).toBe(0);
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date("2026-10-11T08:01Z"))).sent).toBe(1);
  await deferTelegram(h.ctx, link, owner.hash, "Expired notice", "agent_alerts", caller, new Date("2026-10-10T23:00Z"));
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date("2026-10-18T08:00Z"))).sent).toBe(0);
  await deferTelegram(h.ctx, link, owner.hash, "Revoked notice", "agent_alerts", caller, new Date("2026-10-10T23:00Z"));
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash));
  expect((await flushQuietNotifications(h.ctx, tg.fetch, new Date("2026-10-11T08:00Z"))).sent).toBe(0); expect(tg.calls).toHaveLength(1);
});
test("weekly Inbox is opt-in and reuses the previous week's existing call records", async () => {
  const owner = await h.fundedKey(), caller = await principal(owner), week = previousIsoWeek(new Date()), value = await read(owner);
  expect((await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, on_breach: "deny" } })).status).toBe(200);
  await h.ctx.db.insert(generations).values({ id: `E146-weekly-${++uid}`, keyHash: owner.hash, accountId: caller.accountId, modelId: MODELS.llama.slug, providerId: "alpha", mode: "prepaid", cost: 2_000_000_000_000n, ts: week.start });
  expect(await weeklyInbox(h.ctx, caller, true)).toEqual([]);
  value.channels.weekly_summary.inbox = true; await save(owner, value);
  const data = (await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data;
  const item = data.find((row: any) => row.kind === "weekly_summary"); expect(item.id).toBe(`weekly-summary:${week.id}`); expect(item.title).toContain("$2.00");
  expect(await weeklyInbox(h.ctx, caller, true, week.end.toISOString())).toEqual([]);
  expect(await weeklyInbox(h.ctx, caller, false)).toEqual([]);
  expect(await weeklyInbox({ ...h.ctx, cfg: { ...h.ctx.cfg, weeklySummaryEnabled: false } }, caller, true)).toEqual([]);
});
