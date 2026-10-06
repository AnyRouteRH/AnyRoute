import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { accounts, generations, keys, teamMembers } from "../src/db/schema.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { consumeCode } from "../src/telegram/linking.ts";
import { readWeeklySummary } from "../src/telegram/weekly-summary-read.ts";
import { runWeeklySummaries, registerWeeklySummaryJob } from "../src/telegram/weekly-summary.ts";
import { previousIsoWeek, summaryDue, weeklySummaryText } from "../src/telegram/weekly-summary-text.ts";
import { loadConfig } from "../src/config.ts";

const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const env = { TELEGRAM_LINKING_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN, WEEKLY_SUMMARY_ENABLED: "true", SITE_URL: "https://site.example" };
const MONDAY = new Date("2026-10-05T09:00:00Z"), WEEK = previousIsoWeek(MONDAY);
const DURING = new Date("2026-10-01T12:00:00Z");
let h: Harness, uid = 92000, id = 0;
type Key = { hash: string; auth: Record<string, string> };
const PATH = "/api/v1/telegram/weekly-summary";
beforeAll(async () => { h = await startRouter({ env }); });
afterAll(async () => { await h?.close(); });
async function linked(key: Key) {
  const issued = await h.request("/api/v1/telegram/link", { method: "POST", headers: key.auth });
  expect(issued.status).toBe(200);
  return consumeCode(h.ctx, ++uid, (await issued.json()).data.code);
}
async function opt(key: Key, opted_in: boolean) {
  const response = await h.request(PATH, { method: "PUT", headers: key.auth, json: { opted_in } });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}
function telegram(ok = true) {
  const calls: { chat_id: number; text: string }[] = [];
  const fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return Response.json(ok ? { ok: true, result: { message_id: calls.length } } : { ok: false, error_code: 429, parameters: { retry_after: 60 } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
async function child(owner: Key, name: string, extra = {}) {
  const res = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name, ...extra } });
  expect(res.status).toBe(201);
  const data = await res.json();
  return { hash: data.data.hash, auth: { authorization: `Bearer ${data.key}` } };
}
async function active(key: Key, cost = 2100000000000n, ts = DURING, model = MODELS.llama.slug) {
  const response = await h.request(`/api/v1/agents/${key.hash}/policy`, { method: 'PUT', headers: key.auth, json: { version: 1, models: {}, caps: {}, on_breach: 'deny', alerts: {} } });
  expect(response.status).toBe(200);
  const [keyRow] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.insert(generations).values({ id: `weekly-call-${++id}`, keyHash: key.hash, accountId: keyRow!.accountId, modelId: model, providerId: 'alpha', mode: 'prepaid', cost, ts });
  return keyRow!;
}
async function seed(owner: Key) {
  const agentKeys = await Promise.all(['shop-agent', 'research-agent', 'notes-agent'].map(name => child(owner, name)));
  for (const [index, key] of agentKeys.entries()) {
    // Owner authenticates rule editing; use the child's auth only to identify the seeded charge.
    const response = await h.request(`/api/v1/agents/${key.hash}/policy`, { method: 'PUT', headers: owner.auth, json: { version: 1, models: {}, caps: {}, on_breach: 'deny', alerts: {} } });
    expect(response.status).toBe(200);
    const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
    await h.ctx.db.insert(generations).values({ id: `weekly-call-${++id}`, keyHash: key.hash, accountId: row!.accountId, modelId: MODELS.llama.slug, providerId: 'alpha', mode: 'prepaid', cost: [2100000000000n, 1800000000000n, 310000000000n][index]!, ts: DURING });
  }
  for (const status of ['approved', 'used', 'approved', 'denied'] as const) await h.ctx.db.insert(agentApprovals).values({ id: `weekly-approval-${++id}`, keyHash: agentKeys[0]!.hash, intent: {}, intentHash: 'weekly-intent', maxCostPico: 1n, status, requestedAt: DURING, decidedAt: DURING, expiresAt: WEEK.end });
  expect((await h.request(`/api/v1/agents/${agentKeys[0]!.hash}/kill`, { method: 'POST', headers: owner.auth, json: {} })).status).toBe(200);
  await h.ctx.db.update(agentPolicyEvents).set({ ts: DURING }).where(and(eq(agentPolicyEvents.keyHash, agentKeys[0]!.hash), eq(agentPolicyEvents.kind, 'killed')));
  return agentKeys;
}

test('UTC ISO weeks cover leap day, year rollover, exclusive Monday and Monday 09:00 scheduling', () => {
  expect(WEEK).toEqual({ start: new Date('2026-09-28T00:00:00Z'), end: new Date('2026-10-05T00:00:00Z'), id: '2026-W40' });
  expect(previousIsoWeek(new Date('2021-01-04T09:00:00Z')).id).toBe('2020-W53');
  expect(previousIsoWeek(new Date('2020-03-02T09:00:00Z')).start.toISOString()).toBe('2020-02-24T00:00:00.000Z');
  expect(previousIsoWeek(new Date('2026-10-05T01:00:00-08:00'))).toEqual(WEEK);
  for (const instant of ['2026-10-05T08:59:59Z', '2026-10-04T09:00:00Z', '2026-10-06T09:00:00Z']) expect(summaryDue(new Date(instant))).toBe(false);
  expect(summaryDue(MONDAY)).toBe(true); expect(summaryDue(new Date('2026-10-05T23:59:59Z'))).toBe(true);
});
test('message snapshot, exact cents, top-five labels and plain readable lines', () => {
  const week = previousIsoWeek(new Date('2025-10-06T09:00:00Z'));
  expect(weeklySummaryText(week, { activity: 8, spent: 4210000000000n, agents: 3, topKeys: [{ name: 'shop-agent', spent: 2100000000000n }, { name: 'research-agent', spent: 1800000000000n }, { name: 'notes-agent', spent: 310000000000n }], approvals: 4, approved: 3, denied: 1, stops: 1, topModel: 'Llama' }, 'https://site.example/')).toBe('Anyroute: your week (Sep 29 – Oct 5)\nSpent: $4.21 across 3 agents\nshop-agent $2.10 · research-agent $1.80 · notes-agent $0.31\nApprovals: 4 (3 approved, 1 denied) · Stops: 1\nTop model: Llama\nActivity: https://site.example/dashboard/#activity');
  const text = weeklySummaryText(WEEK, { activity: 1, spent: 900719925474099100000000n, agents: 6, topKeys: Array.from({ length: 6 }, (_, i) => ({ name: `agent-${i}\n${'x'.repeat(300)}`, spent: 1n })), approvals: 0, approved: 0, denied: 0, stops: 0, topModel: null }, 'https://site.example');
  expect(text).not.toContain('agent-5'); expect(text.split('\n')).toHaveLength(6); expect(text.length).toBeLessThan(4096);
  expect(text).toContain('$900719925474.10');
});
test('default off, dependency guards, API role can omit token and selected worker job is valid', () => {
  expect(loadConfig({}).weeklySummaryEnabled).toBe(false);
  expect(() => loadConfig({ WEEKLY_SUMMARY_ENABLED: 'true' })).toThrow(/TELEGRAM_LINKING_ENABLED/);
  expect(() => loadConfig({ ...env, TELEGRAM_BOT_TOKEN: undefined as any, RUNTIME_ROLE: 'worker' })).toThrow(/TELEGRAM_BOT_TOKEN/);
  expect(loadConfig({ ...env, TELEGRAM_BOT_TOKEN: undefined as any, RUNTIME_ROLE: 'api' }).weeklySummaryEnabled).toBe(true);
  expect(loadConfig({ ...env, RUNTIME_ROLE: 'worker', WORKER_JOBS: 'weekly-summary' }).workerJobs).toEqual(['weekly-summary']);
});
test('new preference defaults off, strict body, no-store, missing link and unauthenticated cases', async () => {
  const key = await h.fundedKey();
  for (const method of ['GET', 'PUT']) expect((await h.request(PATH, { method, json: method === 'PUT' ? { opted_in: true } : undefined })).status).toBe(401);
  expect((await h.request(PATH, { headers: key.auth })).status).toBe(409);
  await linked(key);
  const res = await h.request(PATH, { headers: key.auth });
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect((await res.json()).data).toEqual({ opted_in: false, last_sent_week: null });
  for (const json of [{ opted_in: 'yes' }, { opted_in: true, extra: 1 }, {}]) expect((await h.request(PATH, { method: 'PUT', headers: key.auth, json })).status).toBe(400);
  expect(await opt(key, true)).toEqual({ opted_in: true, last_sent_week: null });
  expect((await h.request(PATH, { headers: (await h.fundedKey()).auth })).status).toBe(409);
});
test('summary aggregates existing records, includes start and excludes end, uses model name; concurrent jobs and relink do not resend', async () => {
  const owner = await h.fundedKey(), link = await linked(owner), agents = await seed(owner);
  const [caller] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  const data = await readWeeklySummary(h.ctx.db, caller!, WEEK);
  expect(data).toMatchObject({ spent: 4210000000000n, agents: 3, approvals: 4, approved: 3, denied: 1, stops: 1, topModel: MODELS.llama.slug });
  expect(data.topKeys.map(k => k.name)).toEqual(['shop-agent', 'research-agent', 'notes-agent']);
  await h.ctx.db.insert(generations).values([{ id: `weekly-call-${++id}`, keyHash: agents[0]!.hash, modelId: MODELS.llama.slug, providerId: 'alpha', mode: 'prepaid', cost: 100n, ts: WEEK.start }, { id: `weekly-call-${++id}`, keyHash: agents[0]!.hash, modelId: MODELS.qwen.slug, providerId: 'alpha', mode: 'prepaid', cost: 90000000000000n, ts: WEEK.end }]);
  expect((await readWeeklySummary(h.ctx.db, caller!, WEEK)).spent).toBe(data.spent + 100n);
  await opt(owner, true);
  const tg = telegram();
  const results = await Promise.all([runWeeklySummaries(h.ctx, { now: MONDAY, telegramFetch: tg.fetch }), runWeeklySummaries(h.ctx, { now: MONDAY, telegramFetch: tg.fetch })]);
  expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
  expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(1);
  const text = tg.calls.find(c => c.chat_id === link.uid)!.text;
  expect(text).toContain('Spent: $4.21 across 3 agents'); expect(text).toContain(`Top model: ${h.ctx.catalog.models.get(MODELS.llama.slug)!.name}`);
  expect((await h.request('/api/v1/telegram/link', { method: 'DELETE', headers: owner.auth })).status).toBe(200);
  await linked(owner); expect(await opt(owner, true)).toEqual({ opted_in: true, last_sent_week: WEEK.id });
  await runWeeklySummaries(h.ctx, { now: MONDAY, telegramFetch: tg.fetch }); expect(tg.calls.filter(c => c.text === text)).toHaveLength(1);
  await opt(owner, false);
});
test('opt-out, zero activity, revoked authority and unlink skip; failed send leaves marker unchanged', async () => {
  const tg = telegram();
  for (const mode of ['opt-out', 'empty', 'revoked', 'unlink', 'failure']) {
    const key = await h.fundedKey(), link = await linked(key);
    if (mode !== 'empty') await active(key);
    await opt(key, mode !== 'opt-out');
    if (mode === 'revoked') await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, key.hash));
    if (mode === 'unlink') await h.request('/api/v1/telegram/link', { method: 'DELETE', headers: key.auth });
    const transport = mode === 'failure' ? telegram(false) : tg;
    await runWeeklySummaries(h.ctx, { now: MONDAY, telegramFetch: transport.fetch });
    expect(tg.calls.filter(c => c.chat_id === link.uid)).toHaveLength(0);
    const [account] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, link.account));
    expect(account!.lastSentWeek).toBeNull();
    if (mode === 'failure') { expect(transport.calls.filter(c => c.chat_id === link.uid)).toHaveLength(1); await opt(key, false); }
  }
});
test('scope remains within the linked team; viewers, sessions and demoted admins cannot manage preferences', async () => {
  const owner = await h.fundedKey();
  const team = (await (await h.request('/api/v1/teams', { method: 'POST', headers: owner.auth, json: { name: 'Summary team' } })).json()).data;
  const admin = await child(owner, 'summary-admin', { team: team.id, role: 'admin' });
  const viewer = await child(owner, 'summary-viewer', { team: team.id, role: 'viewer' });
  expect((await h.request(PATH, { headers: viewer.auth })).status).toBe(403);
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request(PATH, { headers: { authorization: `Bearer ${session.key}` } })).status).toBe(403);
  await active(owner, 8000000000000n);
  await active(admin, 1000000000000n);
  const link = await linked(admin); await opt(admin, true);
  const tg = telegram(); await runWeeklySummaries(h.ctx, { now: MONDAY, telegramFetch: tg.fetch });
  expect(tg.calls.find(c => c.chat_id === link.uid)!.text).toContain('Spent: $1.00 across 1 agent');
  expect(tg.calls.find(c => c.chat_id === link.uid)!.text).not.toContain('$8.00');
  await h.ctx.db.update(teamMembers).set({ role: 'viewer' }).where(eq(teamMembers.keyHash, admin.hash));
  expect((await h.request(PATH, { headers: admin.auth })).status).toBe(403);
  const before = tg.calls.length; await runWeeklySummaries(h.ctx, { now: new Date('2026-10-12T09:00:00Z'), telegramFetch: tg.fetch }); expect(tg.calls).toHaveLength(before);
});
test('flag off hides endpoints, registers no job and never sends; scheduling guards return before reads', async () => {
  const off = await startRouter({ env: { ...env, WEEKLY_SUMMARY_ENABLED: 'false' } });
  try {
    const key = await off.fundedKey();
    for (const method of ['GET', 'PUT']) expect((await off.request(PATH, { method, headers: key.auth, json: method === 'PUT' ? { opted_in: true } : undefined })).status).toBe(404);
    registerWeeklySummaryJob(off.ctx);
    expect(off.ctx.jobs.status().some(j => j.name === 'weekly-summary')).toBe(false);
    const tg = telegram(); expect(await runWeeklySummaries(off.ctx, { now: MONDAY, telegramFetch: tg.fetch })).toEqual({ sent: 0, skipped: 'disabled' }); expect(tg.calls).toHaveLength(0);
    const existing = await off.request('/api/v1/telegram/link', { headers: key.auth });
    expect((await existing.json()).data).toEqual({ linked: false, telegram_user_id: null, linked_at: null });
  } finally { await off.close(); }
  expect(h.ctx.jobs.status().find(j => j.name === 'weekly-summary')!.every_ms).toBe(3600000);
  expect(await runWeeklySummaries(h.ctx, { now: new Date('2026-10-06T09:00:00Z') })).toEqual({ sent: 0, skipped: 'outside_window' });
});
