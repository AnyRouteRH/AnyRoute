import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agentDayStart, capRunway, readAgentRunway, RUNWAY_DAY } from "../src/agents/runway.ts";
import { keys, ledger, teamMembers } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { startRouter, type Harness } from "./helpers.ts";

const USD = 1_000_000_000_000n;
let h: Harness, off: Harness, sequence = 0;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); off = await startRouter(); });
afterAll(async () => { await h?.close(); await off?.close(); });
const path = (hash: string) => `/api/v1/agents/${hash}/runway`;
const row = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0];
async function charge(hash: string, amount: bigint, at: Date, kind = "usage", accountId?: string) {
  const key = await row(hash), id = `agent-runway-${++sequence}`;
  await h.ctx.db.insert(ledger).values({ id, ref: id, accountId: accountId ?? key.accountId, keyHash: hash, amount, kind, createdAt: at });
}
async function child(owner: { auth: Record<string, string> }) {
  const result = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: {} })).json();
  return { hash: result.data.hash, auth: { authorization: "Bearer " + result.key } };
}
async function policy(owner: { auth: Record<string, string> }, hash: string, extra: Record<string, unknown> = {}) {
  const response = await h.request(`/api/v1/agents/${hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: { per_day_usd: 5, per_week_usd: 20 }, on_breach: "deny", ...extra } });
  expect(response.status).toBe(200);
}

test("pace divides remaining by charged rate, including zero, reached, tiny and per-request caps", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const base = { source: "rulebook" as const, period: "day" as const, cap: 5n * USD, spent: USD, paceSpend: USD, paceMs: RUNWAY_DAY / 2 };
  expect(capRunway(base, now)).toMatchObject({ remaining_usd: 4, pace_per_day_usd: 2, estimated_days_left: 2, estimated_reaches_at: "2026-10-16T12:00:00.000Z" });
  expect(capRunway({ ...base, paceSpend: 0n }, now).estimated_days_left).toBeNull();
  expect(capRunway({ ...base, paceMs: 0 }, now).estimated_days_left).toBeNull();
  expect(capRunway({ ...base, spent: 6n * USD, paceSpend: 0n }, now)).toMatchObject({ remaining_usd: 0, estimated_days_left: 0 });
  expect(capRunway({ ...base, cap: 10n, spent: 3n, paceSpend: 7n, paceMs: RUNWAY_DAY }, now).estimated_days_left).toBe(1);
  expect(capRunway({ ...base, period: "request", spent: null, paceMs: 0 }, now)).toMatchObject({ charged_usd: null, estimated_days_left: null });
});
test("local today handles UTC, half-hour offsets, leap dates and both DST changes", () => {
  const cases = [
    ["2026-10-14T12:00:00Z", "UTC", "2026-10-14T00:00:00.000Z"],
    ["2026-10-14T02:00:00Z", "America/Toronto", "2026-10-13T04:00:00.000Z"],
    ["2026-10-14T02:00:00Z", "Asia/Kolkata", "2026-10-13T18:30:00.000Z"],
    ["2026-03-08T18:00:00Z", "America/New_York", "2026-03-08T05:00:00.000Z"],
    ["2026-11-01T18:00:00Z", "America/New_York", "2026-11-01T04:00:00.000Z"],
    ["2024-02-29T12:00:00Z", "UTC", "2024-02-29T00:00:00.000Z"],
  ];
  for (const [at, zone, expected] of cases) expect(agentDayStart(new Date(at), zone).toISOString()).toBe(expected);
});
test("no caps or zero spend returns honest null estimates; per-request-only cap is still a cap", async () => {
  const owner = await h.newKey();
  expect(await readAgentRunway(h.ctx.db, await row(owner.hash))).toMatchObject({ limits: [], today_charged_usd: 0, time_zone: "UTC", estimate: true });
  await policy(owner, owner.hash);
  expect((await readAgentRunway(h.ctx.db, await row(owner.hash))).limits.every(limit => limit.estimated_days_left === null)).toBe(true);
  await policy(owner, owner.hash, { caps: { per_request_usd: 1, max_output_tokens: 100 } });
  expect((await readAgentRunway(h.ctx.db, await row(owner.hash))).limits).toMatchObject([{ period: "request", cap_usd: 1, charged_usd: null }]);
});
test("only own posted charges count, with strict rolling edges, local day and future exclusion", async () => {
  const owner = await h.newKey(), sibling = await child(owner), foreign = await h.newKey();
  const now = new Date("2026-10-14T12:00:00Z");
  await policy(owner, owner.hash, { work_hours: { time_zone: "America/Toronto", days: [1], start: "09:00", end: "17:00", outside: "refuse" } });
  await charge(owner.hash, -USD, new Date("2026-10-14T05:00:00Z"));
  await charge(owner.hash, -USD, new Date("2026-10-14T03:59:59Z"));
  await charge(owner.hash, -USD, new Date("2026-10-12T12:00:00Z"), "tool_call");
  await charge(owner.hash, -USD, now, "data_tool");
  await charge(owner.hash, USD, now, "refund");
  await charge(owner.hash, -USD, now, "withdrawal");
  await charge(owner.hash, -USD, new Date(now.getTime() + 1));
  await charge(owner.hash, -USD, new Date(now.getTime() - 7 * RUNWAY_DAY));
  await charge(owner.hash, -USD, now, "usage", (await row(foreign.hash)).accountId);
  await charge(sibling.hash, -100n * USD, now);
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  await charge(session.key_hash, -USD, now);
  const data = await readAgentRunway(h.ctx.db, await row(owner.hash), now);
  expect(data).toMatchObject({ time_zone: "America/Toronto", today_from: "2026-10-14T04:00:00.000Z", today_charged_usd: 2, spend_7d_usd: 4 });
  expect(data.limits).toMatchObject([{ period: "day", charged_usd: 2, cap_usd: 5, estimated_days_left: 0.5 }, { period: "week", charged_usd: 3, cap_usd: 20 }]);
  expect(data.limits[1].estimated_days_left).toBeCloseTo(17 * 7 / 3);
});
test("daily, weekly, monthly and total key budgets use own charges and existing UTC resets", async () => {
  const owner = await h.newKey(), now = new Date("2026-10-14T12:00:00Z");
  await charge(owner.hash, -USD, new Date("2026-10-14T08:00:00Z"));
  await charge(owner.hash, -USD, new Date("2026-10-13T08:00:00Z"));
  await charge(owner.hash, -USD, new Date("2026-10-01T00:00:00Z"));
  await charge(owner.hash, -USD, new Date("2026-09-30T23:59:59Z"));
  for (const [reset, period, spent, next] of [
    ["daily", "day", 1, "2026-10-15T00:00:00.000Z"], ["weekly", "week", 2, "2026-10-19T00:00:00.000Z"],
    ["monthly", "month", 3, "2026-11-01T00:00:00.000Z"], [null, "total", 4, null],
  ] as const) {
    await h.ctx.db.update(keys).set({ budget: 5n * USD, budgetReset: reset, spent: 100n * USD, periodStart: new Date("2026-09-01") }).where(eq(keys.keyHash, owner.hash));
    const data = await readAgentRunway(h.ctx.db, await row(owner.hash), now);
    expect(data.limits[0]).toMatchObject({ source: "key_budget", period, charged_usd: spent, resets_at: next });
  }
  const limit = capRunway({ source: "key_budget", period: "month", cap: 5n * USD, spent: USD, paceSpend: USD, paceMs: 7 * RUNWAY_DAY, resetsAt: new Date("2026-11-01") }, now);
  expect(limit.reaches_before_reset).toBe(false);
});
test("effective caps follow current autonomy without saving a report or changing existing responses", async () => {
  const owner = await h.newKey();
  await policy(owner, owner.hash, { autonomy: { rungs: [{ after_days: 0, clean_requests: 0, caps_multiplier: 2 }], demote_on: [] } });
  const before = await (await h.request(`/api/v1/agents/${owner.hash}/policy`, { headers: owner.auth })).text();
  const entries = await h.ctx.db.select().from(ledger).where(eq(ledger.keyHash, owner.hash));
  const result = await h.request(path(owner.hash), { headers: owner.auth });
  expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
  expect((await result.json()).data.limits.map((limit: any) => limit.cap_usd)).toEqual([10, 40]);
  expect(await (await h.request(`/api/v1/agents/${owner.hash}/policy`, { headers: owner.auth })).text()).toBe(before);
  expect(await h.ctx.db.select().from(ledger).where(eq(ledger.keyHash, owner.hash))).toEqual(entries);
});
test("auth rejects missing, invalid, ordinary, session, inference, read-only, disabled and expired keys", async () => {
  const owner = await h.newKey(), ordinary = await child(owner);
  for (const headers of [{}, { authorization: "Bearer invalid" }]) expect((await h.request(path(owner.hash), { headers })).status).toBe(401);
  expect((await h.request(path(ordinary.hash), { headers: ordinary.auth })).status).toBe(403);
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request(path(owner.hash), { headers: { authorization: "Bearer " + session.key } })).status).toBe(403);
  for (const scope of ["inference", "read"]) {
    await h.ctx.db.update(keys).set({ scope, management: false }).where(eq(keys.keyHash, owner.hash));
    expect((await h.request(path(owner.hash), { headers: owner.auth })).status).toBe(403);
  }
  for (const update of [{ disabled: true }, { disabled: false, expiresAt: new Date(Date.now() - 1) }]) {
    await h.ctx.db.update(keys).set({ scope: null, management: true, ...update }).where(eq(keys.keyHash, owner.hash));
    expect((await h.request(path(owner.hash), { headers: owner.auth })).status).toBe(401);
  }
});
test("visibility matches policy GET for management, team owners/admins and unrelated keys", async () => {
  const owner = await h.newKey(), foreign = await h.newKey(), admin = await child(owner), peer = await child(owner), hidden = await child(owner);
  for (const key of [admin, peer]) await h.ctx.db.update(keys).set({ teamId: "runway-team-a" }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.update(keys).set({ teamId: "runway-team-b" }).where(eq(keys.keyHash, hidden.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "runway-team-a", keyHash: admin.hash, role: "admin" });
  for (const key of [owner, admin, peer, hidden]) await policy(owner, key.hash);
  for (const role of ["admin", "owner", "viewer"]) {
    await h.ctx.db.update(teamMembers).set({ role }).where(eq(teamMembers.keyHash, admin.hash));
    for (const target of [owner, admin, peer, hidden, foreign]) {
      const response = await h.request(path(target.hash), { headers: admin.auth });
      const policyResponse = await h.request(`/api/v1/agents/${target.hash}/policy`, { headers: admin.auth });
      expect(response.status).toBe(policyResponse.status);
    }
  }
  expect((await h.request(path(hidden.hash), { headers: owner.auth })).status).toBe(200);
  expect((await h.request(path(foreign.hash), { headers: owner.auth })).status).toBe(404);
});
test("existing agent switch defaults off and gives 404 with or without auth", async () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).agentPolicyEnabled).toBe(false);
  const owner = await off.newKey();
  for (const headers of [{}, owner.auth]) expect((await off.request(path(owner.hash), { headers })).status).toBe(404);
});
