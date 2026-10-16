import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { generations, keys, ledger, kv, accounts, teamMembers } from "../src/db/schema.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { modelWatches } from "../src/model-watch/schema.ts";
import { initialState } from "../src/model-watch/state.ts";
import { readSummarySections, capConcern } from "../src/telegram/weekly-summary-sections.ts";
import { readWeeklySummary } from "../src/telegram/weekly-summary-read.ts";
import { previousIsoWeek, weeklySummaryText } from "../src/telegram/weekly-summary-text.ts";
import { runWeeklySummaries } from "../src/telegram/weekly-summary.ts";
import { consumeCode } from "../src/telegram/linking.ts";
import { decrypt } from "../src/lib/util.ts";
import { readPreferences, savePreferences } from "../src/notifications/prefs.ts";
let h: Harness, sequence = 0;
const env = { AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", WEEKLY_SUMMARY_ENABLED: "true", MODEL_WATCH_ENABLED: "true", NOTIFICATION_QUIET_HOURS_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789" };
const week = previousIsoWeek(new Date()), during = new Date(week.end.getTime() - 1000);
const monday = new Date(week.end.getTime() + 9 * 3600000);
beforeAll(async () => { h = await startRouter({ env }); });
afterAll(async () => { await h?.close(); });
type Owner = Awaited<ReturnType<Harness["fundedKey"]>>;
async function caller(owner: Owner) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash)))[0]!; }
async function policy(owner: Owner) {
  expect((await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: { per_week_usd: 1 }, on_breach: "deny", alerts: {} } })).status).toBe(200);
}
async function calls(owner: Owner, count = 1) {
  const key = await caller(owner);
  await h.ctx.db.insert(generations).values(Array.from({ length: count }, (_, i) => ({ id: `summary-section-call-${++sequence}`, keyHash: owner.hash, accountId: key.accountId,
    ts: during, modelId: MODELS.qwen.slug, providerId: "alpha", mode: "prepaid", cost: 1000000000n, tokensIn: 1000, tokensOut: 500,
    finishReason: i < 3 && count === 100 ? "error" : "stop", receipt: { lane: "public", disclosure: "vendor-forwarded" } })));
}
async function watches(owner: Owner) {
  const key = await caller(owner);
  const notices = ["Qwen is unavailable right now", "Qwen is back"].map(title => ({ id: `summary-watch-${++sequence}`, model: MODELS.qwen.slug, title, at: during.toISOString() }));
  notices.push({ ...notices[0]!, id: `summary-watch-${++sequence}`, title: "excluded-end", at: week.end.toISOString() });
  await h.ctx.db.insert(modelWatches).values({ accountId: key.accountId, modelId: MODELS.qwen.slug, state: { ...initialState(during.getTime()), notices } });
}
async function expiry(owner: Owner) {
  // Approved-but-unused expiries have a decision and must not be counted.
  for (const [status, decidedAt, expiresAt] of [["pending", null, during], ["expired", null, week.start], ["expired", during, during], ["approved", during, during], ["pending", null, week.end]] as const) {
    await h.ctx.db.insert(agentApprovals).values({ id: `summary-expired-${++sequence}`, keyHash: owner.hash, intent: {}, intentHash: "summary-expiry", maxCostPico: 1n, status, decidedAt, requestedAt: new Date(week.start.getTime() - 1000), expiresAt });
  }
}
const texts = (sections: Awaited<ReturnType<typeof readSummarySections>>) => sections.map(s => s.text).join("\n");

test("empty additions preserve today's message bytes and cap boundaries omit unknown per-request usage", async () => {
  const owner = await h.fundedKey(), key = await caller(owner);
  expect(await readSummarySections(h.ctx, key, week)).toEqual([]);
  const summary = await readWeeklySummary(h.ctx.db, key, week);
  const original = weeklySummaryText(week, summary, "https://site.example");
  expect(weeklySummaryText(week, { ...summary, sections: [] }, "https://site.example")).toBe(original);
  expect(capConcern([])).toBe(false);
  expect(capConcern([{ charged_usd: 0, cap_usd: 0, remaining_usd: 0 } as any])).toBe(false);
  const limit = { charged_usd: 0.79, cap_usd: 1, remaining_usd: 0.21 } as any;
  expect(capConcern([limit])).toBe(false);
  expect(capConcern([{ ...limit, charged_usd: 0.8 }])).toBe(true);
  expect(capConcern([{ ...limit, charged_usd: null }])).toBe(false);
});
test("each section is present when supported, absent when its records are removed, and keeps links and twelve-line limit", async () => {
  const owner = await h.fundedKey(), key = await caller(owner);
  await policy(owner); await calls(owner, 100); await watches(owner); await expiry(owner);
  await h.ctx.db.insert(ledger).values({ id: `summary-ledger-${++sequence}`, ref: `summary-ref-${sequence}`, accountId: key.accountId, keyHash: key.keyHash, kind: "usage", amount: -800000000000n, createdAt: during });
  const sections = await readSummarySections(h.ctx, key, week);
  const text = texts(sections);
  expect(text).toContain("97% of your calls succeeded");
  expect(text).toContain("Savings estimate: try");
  expect(text).toContain("is unavailable right now"); expect(text).toContain("is back"); expect(text).not.toContain("excluded-end");
  expect(text).toContain("Agent caps:"); expect(text).toContain("2 approvals expired without a decision");
  expect(sections.every(s => ["/dashboard/#insights", "/models/", "/agents/"].includes(s.href))).toBe(true);
  expect(text).not.toContain("checkup");
  const summary = await readWeeklySummary(h.ctx.db, key, week);
  summary.topKeys = Array.from({ length: 5 }, () => ({ name: "agent\n" + "x".repeat(300), spent: 1n }));
  const message = weeklySummaryText(week, { ...summary, sections }, "https://site.example");
  expect(message.split("\n").length).toBeLessThanOrEqual(12); expect(message.length).toBeLessThan(4096);
  await h.ctx.db.delete(generations).where(eq(generations.keyHash, key.keyHash));
  const withoutCalls = texts(await readSummarySections(h.ctx, key, week));
  expect(withoutCalls).not.toContain("calls succeeded"); expect(withoutCalls).not.toContain("Savings estimate");
  await h.ctx.db.delete(modelWatches).where(eq(modelWatches.accountId, key.accountId));
  expect(texts(await readSummarySections(h.ctx, key, week))).not.toContain("Models you watch");
  await h.ctx.db.update(agentPolicies).set({ spec: { version: 1, models: {}, caps: { per_week_usd: 10 }, on_breach: "deny", alerts: {} } }).where(eq(agentPolicies.keyHash, key.keyHash));
  expect(texts(await readSummarySections(h.ctx, key, week))).not.toContain("Agent caps");
  await h.ctx.db.delete(agentApprovals).where(eq(agentApprovals.keyHash, key.keyHash));
  expect(await readSummarySections(h.ctx, key, week)).toEqual([]);
});
test("a retained earlier cap refusal contributes even after rolling usage resets", async () => {
  const owner = await h.fundedKey(); await policy(owner);
  await h.ctx.db.insert(agentPolicyEvents).values({ keyHash: owner.hash, ts: week.start, kind: "decision", decision: "deny", policySha256: "summary-policy", prevHash: "summary-prev", hash: "summary-hash", reasons: [{ code: "over_per_day" }], intent: {} });
  expect(texts(await readSummarySections(h.ctx, await caller(owner), week))).toContain("Agent caps:");
});
test("team summaries never include another team's reliability, savings, caps, expiry or account model watches", async () => {
  const owner = await h.fundedKey(); await policy(owner); await calls(owner); await watches(owner); await expiry(owner);
  const child = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "summary-team" } });
  expect(child.status).toBe(201); const data = await child.json();
  await h.ctx.db.update(keys).set({ teamId: "summary-team" }).where(eq(keys.keyHash, data.data.hash));
  await h.ctx.db.insert(teamMembers).values({ keyHash: data.data.hash, teamId: "summary-team", role: "admin" }).onConflictDoNothing();
  const key = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, data.data.hash)))[0]!;
  expect(await readSummarySections(h.ctx, key, week)).toEqual([]);
});
test("Inbox route keeps auth and settings; enriched Telegram delivery uses opt-in and quiet hours", async () => {
  const owner = await h.fundedKey(), key = await caller(owner); await policy(owner); await calls(owner); await expiry(owner);
  expect((await h.request("/api/v1/inbox")).status).toBe(401);
  const inbox = async () => (await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data.find((i: any) => i.kind === "weekly_summary");
  expect(await inbox()).toBeUndefined();
  const prefs = await readPreferences(h.ctx.db, key.accountId); prefs.channels.weekly_summary.inbox = true;
  await savePreferences(h.ctx.db, key.accountId, prefs);
  const item = await inbox(); expect(item.sections.some((s: any) => s.text.includes("calls succeeded") && s.href === "/dashboard/#insights")).toBe(true);
  expect(item.sections.some((s: any) => s.text.includes("expired") && s.href === "/agents/")).toBe(true);
  const off = { ...h.ctx, cfg: { ...h.ctx.cfg, weeklySummaryEnabled: false } };
  expect(await runWeeklySummaries(off, { now: monday })).toMatchObject({ sent: 0, skipped: "disabled" });
  const linkRes = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth });
  const link = await consumeCode(h.ctx, 184001, (await linkRes.json()).data.code);
  expect((await h.request("/api/v1/telegram/weekly-summary", { method: "PUT", headers: owner.auth, json: { opted_in: true } })).status).toBe(200);
  const now = new Date(), clock = (date: Date) => date.toISOString().slice(11, 16);
  const linkedPrefs = await readPreferences(h.ctx.db, key.accountId);
  linkedPrefs.quiet_hours = { from_utc: clock(new Date(now.getTime() - 60000)), to_utc: clock(new Date(now.getTime() + 3600000)) };
  await savePreferences(h.ctx.db, key.accountId, linkedPrefs);
  let sends = 0;
  const transport = (async () => { sends++; return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  expect(await runWeeklySummaries(h.ctx, { now: monday, telegramFetch: transport })).toMatchObject({ sent: 1 });
  expect(sends).toBe(0);
  const queued = await h.ctx.db.select().from(kv);
  expect(queued.filter(row => row.key.startsWith("notification-quiet:")).some(row => decrypt(h.ctx.cfg.appSecret, (row.value as { sealed: string }).sealed).includes("approvals expired without a decision"))).toBe(true);
  expect((await h.ctx.db.select().from(accounts).where(eq(accounts.id, link.account)))[0]!.lastSentWeek).toBe(week.id);
});
