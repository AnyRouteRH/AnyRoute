import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { accounts, generations, keys, kv } from "../src/db/schema.ts";
import { consumeCode } from "../src/telegram/linking.ts";
import { runWeeklySummaries } from "../src/telegram/weekly-summary.ts";
import { previousIsoWeek, weeklySummaryText, type WeekSummary } from "../src/telegram/weekly-summary-text.ts";
import { dailySummaryText } from "../src/telegram/daily-summary-text.ts";
import { claimSummary, summaryClaimed, summaryClaims, summaryPeriod, DEFAULT_SUMMARY_SCHEDULE, type SummarySchedule } from "../src/telegram/summary-schedule.ts";
import { weeklyInbox } from "../src/notifications/inbox.ts";
import { readPreferences } from "../src/notifications/prefs.ts";
import { flushQuietNotifications } from "../src/notifications/telegram.ts";
const daily: SummarySchedule = { cadence: "daily", hour: 9, time_zone: "America/Toronto" };
const at = (value: string, schedule = daily) => summaryPeriod(new Date(value), schedule);

test("unsaved weekly windows and delivery times remain the same, including ISO year rollover", () => {
  for (const date of ["2026-10-05T09:00Z", "2021-01-04T23:59Z", "2020-03-02T09:00Z"]) {
    const old = previousIsoWeek(new Date(date)), next = at(date, DEFAULT_SUMMARY_SCHEDULE)!;
    expect({ start: next.start, end: next.end, id: next.id }).toEqual(old);
    expect(weeklySummaryText(next, empty, "https://site.example")).toBe(weeklySummaryText(old, empty, "https://site.example"));
  }
  expect(at("2026-10-05T08:59:59Z", DEFAULT_SUMMARY_SCHEDULE)).toBeNull();
  expect(at("2026-10-06T09:00Z", DEFAULT_SUMMARY_SCHEDULE)).toBeNull();
});
test("daily previous-day windows follow 23- and 25-hour days, leap days and half-hour zones", () => {
  for (const [instant, start, end, hours] of [
    ["2026-03-09T13:00Z", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
    ["2026-11-02T14:00Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
  ] as const) {
    const period = at(instant)!;
    expect(period.start.toISOString()).toBe(start); expect(period.end.toISOString()).toBe(end);
    expect((period.end.getTime() - period.start.getTime()) / 3600000).toBe(hours);
  }
  expect(at("2026-03-09T12:59:59Z")).toBeNull();
  const india = { ...daily, time_zone: "Asia/Kolkata" };
  expect(at("2028-03-01T03:29Z", india)).toBeNull();
  expect(at("2028-03-01T03:30Z", india)!.id).toBe("2028-02-29");
  expect(at("2028-03-01T03:30Z", india)!.start.toISOString()).toBe("2028-02-28T18:30:00.000Z");
});
test("DST skipped hours send at the next hour and repeated hours share a claim; local Monday may be UTC Sunday", () => {
  const gap = { ...daily, hour: 2 }, fold = { ...daily, hour: 1 };
  expect(at("2026-03-08T06:59Z", gap)).toBeNull(); expect(at("2026-03-08T07:00Z", gap)!.id).toBe("2026-03-07");
  expect(at("2026-11-01T05:30Z", fold)).toEqual(at("2026-11-01T06:30Z", fold));
  const period = at("2026-10-04T19:00Z", { cadence: "weekly", hour: 9, time_zone: "Pacific/Kiritimati" })!;
  expect(period.id).toBe("2026-W40"); expect(period.end.toISOString()).toBe("2026-10-04T10:00:00.000Z");
  expect(at("2026-10-04T18:59Z", { cadence: "weekly", hour: 9, time_zone: "Pacific/Kiritimati" })).toBeNull();
  expect(weeklySummaryText(period, empty, "https://site.example")).toContain("Sep 28 – Oct 4");
});
test("claims survive cadence and time-zone switches; Inbox keeps the latest due window before the next hour", () => {
  const day = at("2026-10-05T13:00Z")!, week = at("2026-10-05T09:00Z", DEFAULT_SUMMARY_SCHEDULE)!;
  const saved = claimSummary(claimSummary(null, week), day);
  expect(summaryClaims(saved)).toEqual({ weekly: "2026-W40", daily: "2026-10-04" });
  expect(summaryClaimed(saved, week)).toBe(true); expect(summaryClaimed(saved, day)).toBe(true);
  expect(summaryClaimed(saved, at("2026-10-04T13:00Z")!)).toBe(true);
  expect(summaryClaimed(saved, at("2026-10-06T13:00Z")!)).toBe(false);
  expect(summaryPeriod(new Date("2026-10-05T12:59Z"), daily, true)!.id).toBe("2026-10-03");
  expect(summaryPeriod(new Date("2026-10-05T08:59Z"), DEFAULT_SUMMARY_SCHEDULE, true)!.id).toBe("2026-W39");
});
const empty: WeekSummary = { activity: 0, spent: 0n, agents: 0, topKeys: [], approvals: 0, approved: 0, denied: 0, stops: 0, topModel: null };
test("daily text skips empty sections, stays within twelve lines and escapes owner-selected line breaks", () => {
  const day = at("2026-10-05T13:00Z")!;
  expect(dailySummaryText(day, empty, "https://site.example/")).toBe("Anyroute: your day (Oct 4)\nActivity: https://site.example/dashboard/#activity");
  const text = dailySummaryText(day, { ...empty, spent: 1000000000000n, agents: 1, approvals: 1, stops: 1, topModel: "Model\nname", topKeys: [{ name: "sample-agent\nname", spent: 1000000000000n }], sections: Array.from({ length: 6 }, () => ({ text: "One short section", href: "/agents/" })) }, "https://site.example");
  expect(text.split("\n")).toHaveLength(12); expect(text).not.toContain("sample-agent\nname"); expect(text.length).toBeLessThan(4096);
});

const env = { TELEGRAM_LINKING_ENABLED: "true", AGENT_POLICY_ENABLED: "true", WEEKLY_SUMMARY_ENABLED: "true", NOTIFICATION_QUIET_HOURS_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789" };
const PATH = "/api/v1/account/notifications", LEGACY = "/api/v1/telegram/weekly-summary";
let h: Harness, uid = 188000, id = 0;
type Owner = Awaited<ReturnType<Harness["fundedKey"]>>;
beforeAll(async () => { h = await startRouter({ env }); });
afterAll(async () => { await h?.close(); });
async function key(owner: Owner) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash)))[0]!; }
async function save(owner: Owner, schedule?: SummarySchedule, telegram = false, quiet_hours: any = null) {
  const prefs = await readPreferences(h.ctx.db, (await key(owner)).accountId);
  prefs.channels.weekly_summary = { inbox: true, telegram };
  return h.request(PATH, { method: "PUT", headers: owner.auth, json: { channels: prefs.channels, quiet_hours, ...(schedule ? { summary_schedule: schedule } : {}) } });
}
async function linked(owner: Owner) {
  const response = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth });
  return consumeCode(h.ctx, ++uid, (await response.json()).data.code);
}
async function call(owner: Owner, ts: Date, cost = 1000000000000n) {
  expect((await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, on_breach: "deny", alerts: {} } })).status).toBe(200);
  await h.ctx.db.insert(generations).values({ id: `K188-call-${++id}`, keyHash: owner.hash, accountId: (await key(owner)).accountId, modelId: MODELS.llama.slug, providerId: "alpha", mode: "prepaid", cost, ts });
}
function transport() {
  const calls: { chat_id: number; text: string }[] = [];
  return { calls, fetch: (async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return Response.json({ ok: true, result: { message_id: calls.length } }); }) as typeof fetch };
}
test("schedule API preserves auth, read-key restrictions, account isolation, strict validation and legacy clients", async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey();
  for (const method of ["GET", "PUT"]) expect((await h.request(PATH, { method, json: method === "PUT" ? {} : undefined })).status).toBe(401);
  expect((await readPreferences(h.ctx.db, (await key(owner)).accountId)).summary_schedule).toBeUndefined();
  const response = await save(owner, daily); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).data.summary_schedule).toEqual(daily);
  expect((await readPreferences(h.ctx.db, (await key(other)).accountId)).summary_schedule).toBeUndefined();
  expect((await save(owner)).status).toBe(200); expect((await readPreferences(h.ctx.db, (await key(owner)).accountId)).summary_schedule).toEqual(daily);
  for (const invalid of [{ ...daily, hour: 24 }, { ...daily, hour: 9.5 }, { ...daily, time_zone: "Invalid/Zone" }, { ...daily, cadence: "monthly" }, { ...daily, extra: true }]) expect((await save(owner, invalid as any)).status).toBe(400);
  const child = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "summary-reader", scope: "read" } });
  expect(child.status).toBe(201); const auth = { authorization: `Bearer ${(await child.json()).key}` };
  expect((await h.request(PATH, { headers: auth })).status).toBe(403);
  expect((await h.request(PATH, { method: "PUT", headers: auth, json: {} })).status).toBe(403);
});
test("daily window excludes its end; concurrent workers, cadence switch and relinking cannot repeat a sent period", async () => {
  const owner = await h.fundedKey(), link = await linked(owner), now = new Date("2026-10-05T13:00Z"), period = summaryPeriod(now, daily)!;
  await call(owner, period.start); await call(owner, new Date(period.end.getTime() - 1)); await call(owner, period.end, 8000000000000n);
  expect((await save(owner, daily, true)).status).toBe(200);
  const tg = transport(), outcomes = await Promise.all([runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch }), runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch })]);
  expect(outcomes.reduce((n, outcome) => n + outcome.sent, 0)).toBe(1);
  expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(1); expect(tg.calls[0]!.text).toContain("Spent: $2.00 across 1 agent");
  await save(owner, DEFAULT_SUMMARY_SCHEDULE, true); await runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch });
  expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(2);
  expect((await (await h.request(LEGACY, { headers: owner.auth })).json()).data.last_sent_week).toBe("2026-W40");
  await save(owner, daily, true); await runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch }); expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(2);
  await h.request("/api/v1/telegram/link", { method: "DELETE", headers: owner.auth }); await linked(owner); await save(owner, daily, true);
  await runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch }); expect(tg.calls).toHaveLength(2);
  await save(owner, daily, false);
});
test("hour changes delay delivery, daily quiet-hours acceptance claims once, then uses existing queued delivery", async () => {
  const owner = await h.fundedKey(), link = await linked(owner), now = new Date("2026-10-06T13:00Z"), period = summaryPeriod(now, daily)!;
  await call(owner, period.start); await save(owner, { ...daily, hour: 10 }, true);
  const tg = transport(); await runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch }); expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(0);
  const real = new Date(), clock = (date: Date) => date.toISOString().slice(11, 16);
  await save(owner, daily, true, { from_utc: clock(new Date(real.getTime() - 60000)), to_utc: clock(new Date(real.getTime() + 3600000)) });
  await runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch }); await runWeeklySummaries(h.ctx, { now, telegramFetch: tg.fetch });
  expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(0);
  const rows = await h.ctx.db.select().from(kv).where(like(kv.key, "notification-quiet:%"));
  expect(rows.filter(row => (row.value as any).uid === link.uid)).toHaveLength(1);
  expect(summaryClaims((await h.ctx.db.select().from(accounts).where(eq(accounts.id, link.account)))[0]!.lastSentWeek).daily).toBe(period.id);
  await flushQuietNotifications(h.ctx, tg.fetch, new Date(real.getTime() + 2 * 3600000)); expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(1);
  await save(owner, daily, false);
});
test("Inbox uses the daily schedule and existing switches; empty daily periods and disabled worker send nothing", async () => {
  const owner = await h.fundedKey(), caller = await key(owner), schedule: SummarySchedule = { cadence: "daily", hour: 0, time_zone: "UTC" };
  await save(owner, schedule); expect(await weeklyInbox(h.ctx, caller, true)).toEqual([]);
  const period = summaryPeriod(new Date(), schedule, true)!; await call(owner, period.start);
  const response = await h.request("/api/v1/inbox", { headers: owner.auth }); expect(response.status).toBe(200);
  const item = (await response.json()).data.find((i: any) => i.kind === "weekly_summary");
  expect(item.id).toBe(`weekly-summary:${period.id}`); expect(item.title).toContain("Anyroute: your day"); expect(item.sections.length).toBeGreaterThan(0);
  expect(await weeklyInbox(h.ctx, caller, true, period.end.toISOString())).toEqual([]);
  expect(await weeklyInbox({ ...h.ctx, cfg: { ...h.ctx.cfg, weeklySummaryEnabled: false } }, caller, true)).toEqual([]);
  const tg = transport(), off = { ...h.ctx, cfg: { ...h.ctx.cfg, weeklySummaryEnabled: false } };
  expect(await runWeeklySummaries(off, { telegramFetch: tg.fetch })).toEqual({ sent: 0, skipped: "disabled" }); expect(tg.calls).toHaveLength(0);
  const prefs = await readPreferences(h.ctx.db, caller.accountId); prefs.channels.weekly_summary.inbox = false;
  expect((await h.request(PATH, { method: "PUT", headers: owner.auth, json: prefs })).status).toBe(200);
  expect(await weeklyInbox(h.ctx, caller, true)).toEqual([]);
});
