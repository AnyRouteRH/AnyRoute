// J176
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readAgentStatus } from "../src/agents/status.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { keys, kv, ledger, teamMembers } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { startRouter, type Harness } from "./helpers.ts";
let h: Harness, off: Harness, seq = 0;
const now = new Date("2026-10-16T12:00:00Z"), USD = 1_000_000_000_000n;
const path = (hash: string) => `/api/v1/agents/${hash}/status`;
const row = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0];
async function status(hash: string, options = { quiet: true, guard: true }, at = now) {
  const key = await row(hash);
  return h.ctx.db.transaction(tx => readAgentStatus(tx, key, options, at), { isolationLevel: "repeatable read", accessMode: "read only" });
}
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", QUIET_AGENT_ALERTS_ENABLED: "true" } }); off = await startRouter(); });
afterAll(async () => { await h?.close(); await off?.close(); });
async function policy(owner: { auth: Record<string, string> }, hash: string, extra = {}) {
  expect((await h.request(`/api/v1/agents/${hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, on_breach: "deny", ...extra } })).status).toBe(200);
}
async function child(owner: { auth: Record<string, string> }) {
  const r = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: {} })).json();
  return { hash: r.data.hash, auth: { authorization: "Bearer " + r.key } };
}
async function approval(hash: string, state: "pending" | "denied", expiresAt: Date) {
  await h.ctx.db.insert(agentApprovals).values({ id: 'status-approval-' + ++seq, keyHash: hash, intent: {}, intentHash: 'status-intent', maxCostPico: 0n, status: state, requestedAt: new Date(now.getTime() - 60_000), expiresAt });
}
async function charge(hash: string, at: Date, amount = USD) {
  const key = await row(hash), id = 'status-charge-' + ++seq;
  await h.ctx.db.insert(ledger).values({ id, ref: id, keyHash: hash, accountId: key.accountId, amount: -amount, kind: 'usage', createdAt: at });
}
test("empty status reads without a rulebook and leaves existing responses and storage unchanged", async () => {
  const owner = await h.newKey();
  expect(await status(owner.hash)).toMatchObject({ stopped: false, work_hours: [], pending_approvals: 0, quiet: null, guard_paused: false, runway: { today_charged_usd: 0, limits: [] } });
  await policy(owner, owner.hash);
  const before = await (await h.request(`/api/v1/agents/${owner.hash}/policy`, { headers: owner.auth })).text();
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, owner.hash));
  const response = await h.request(path(owner.hash), { headers: owner.auth });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await (await h.request(`/api/v1/agents/${owner.hash}/policy`, { headers: owner.auth })).text()).toBe(before);
  expect(await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, owner.hash))).toEqual(events);
});
test("timed, indefinite, expired and inherited stops use the existing visible-stop rules without resuming storage", async () => {
  const owner = await h.newKey(); await policy(owner, owner.hash);
  const until = new Date(now.getTime() + 3_600_000);
  await h.ctx.db.update(agentPolicies).set({ killed: true, killUntil: until }).where(eq(agentPolicies.keyHash, owner.hash));
  expect(await status(owner.hash)).toMatchObject({ stopped: true, stopped_until: until.toISOString() });
  expect(await status(owner.hash, undefined, until)).toMatchObject({ stopped: false });
  expect((await status(owner.hash, undefined, until)).stopped_until).toBeUndefined();
  expect((await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, owner.hash)))[0].killed).toBe(true);
  await h.ctx.db.update(agentPolicies).set({ killUntil: null }).where(eq(agentPolicies.keyHash, owner.hash));
  expect((await status(owner.hash)).stopped_until).toBeUndefined();
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect(await status(session.key_hash)).toMatchObject({ stopped: true });
});
test("work hours report inside, outside, next opening and time zone using the existing reader", async () => {
  const owner = await h.newKey();
  await policy(owner, owner.hash, { work_hours: { days: [5], start: '09:00', end: '17:00', time_zone: 'America/Toronto', outside: 'ask_first' } });
  expect((await status(owner.hash)).work_hours).toMatchObject([{ inside: false, outside: 'ask_first', next_at: '2026-10-16T13:00:00.000Z', time_zone: 'America/Toronto' }]);
  expect((await status(owner.hash, undefined, new Date('2026-10-16T13:00:00Z'))).work_hours).toMatchObject([{ inside: true, next_at: null }]);
});
test("approval counts are per agent, exclude expired and decided rows, and perform no expiry writes", async () => {
  const owner = await h.newKey(), other = await child(owner);
  await approval(owner.hash, 'pending', new Date(now.getTime() + 1));
  await approval(owner.hash, 'pending', now);
  await approval(owner.hash, 'denied', new Date(now.getTime() + 60_000));
  await approval(other.hash, 'pending', new Date(now.getTime() + 60_000));
  expect((await status(owner.hash)).pending_approvals).toBe(1);
  const rows = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.keyHash, owner.hash));
  expect(rows.filter(r => r.status === 'pending')).toHaveLength(2);
});
test("runway is the existing calendar-today and rolling cap view, including pace and per-key isolation", async () => {
  const owner = await h.newKey(), other = await child(owner);
  await policy(owner, owner.hash, { caps: { per_day_usd: 5 } });
  await charge(owner.hash, new Date('2026-10-16T10:00:00Z'), 12n * USD / 10n);
  await charge(owner.hash, new Date('2026-10-15T22:00:00Z'), USD);
  await charge(other.hash, now, 10n * USD);
  expect((await status(owner.hash)).runway).toMatchObject({ today_charged_usd: 1.2, limits: [{ period: 'day', cap_usd: 5, charged_usd: 2.2 }] });
  expect((await status(owner.hash)).runway.limits[0].estimated_days_left).toBeCloseTo(2.8 / 2.4);
});
test("quiet state uses the saved threshold and session activity, including while stopped; off omits it", async () => {
  const owner = await h.newKey(); await policy(owner, owner.hash);
  const setting = { hours: 6, enabled_at: '2026-10-16T04:00:00Z', notified_for: '2026-10-16T04:00:00Z', notices: [] };
  await h.ctx.db.insert(kv).values({ key: 'quiet-agent-alert:' + owner.hash, value: setting });
  expect((await status(owner.hash)).quiet).toMatchObject({ hours: 8, last_call_at: null });
  await h.ctx.db.update(agentPolicies).set({ killed: true }).where(eq(agentPolicies.keyHash, owner.hash));
  expect((await status(owner.hash)).quiet?.hours).toBe(8);
  expect((await status(owner.hash, { quiet: false, guard: false })).quiet).toBeNull();
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  await charge(session.key_hash, new Date('2026-10-16T11:00:00Z'));
  expect((await status(owner.hash)).quiet).toBeNull();
});
test("Guard stop reasons are distinguished from manual Stops and obey the existing Guard switch", async () => {
  const owner = await h.newKey(); await policy(owner, owner.hash);
  for (const [reason, expected] of [['over_action_per_day', true], ['action_not_allowed,target_not_allowed', true], ['manual break', false], ['over_per_day', false], ['breaker:max_requests_per_minute', false]] as const) {
    await h.ctx.db.update(agentPolicies).set({ killed: true, killedReason: reason }).where(eq(agentPolicies.keyHash, owner.hash));
    expect((await status(owner.hash)).guard_paused).toBe(expected);
    expect((await status(owner.hash, { quiet: true, guard: false })).guard_paused).toBe(false);
  }
});
test("authentication and target visibility match policy GET; read-only keys stay refused", async () => {
  const owner = await h.newKey(), foreign = await h.newKey(), admin = await child(owner), peer = await child(owner), hidden = await child(owner);
  for (const key of [admin, peer]) await h.ctx.db.update(keys).set({ teamId: 'status-team-a' }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.update(keys).set({ teamId: 'status-team-b' }).where(eq(keys.keyHash, hidden.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: 'status-team-a', keyHash: admin.hash, role: 'admin' });
  for (const key of [owner, admin, peer, hidden]) await policy(owner, key.hash);
  for (const headers of [{}, { authorization: 'Bearer invalid' }]) expect((await h.request(path(owner.hash), { headers })).status).toBe(401);
  for (const role of ['admin', 'owner', 'viewer']) {
    await h.ctx.db.update(teamMembers).set({ role }).where(eq(teamMembers.keyHash, admin.hash));
    for (const target of [owner, admin, peer, hidden, foreign]) expect((await h.request(path(target.hash), { headers: admin.auth })).status).toBe((await h.request(`/api/v1/agents/${target.hash}/policy`, { headers: admin.auth })).status);
  }
  expect((await h.request(path(hidden.hash), { headers: owner.auth })).status).toBe(200);
  expect((await h.request(path(foreign.hash), { headers: owner.auth })).status).toBe(404);
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request(path(owner.hash), { headers: { authorization: 'Bearer ' + session.key } })).status).toBe(403);
  for (const scope of ['inference', 'read']) {
    await h.ctx.db.update(keys).set({ scope, management: false }).where(eq(keys.keyHash, owner.hash));
    expect((await h.request(path(owner.hash), { headers: owner.auth })).status).toBe(403);
  }
  await h.ctx.db.update(keys).set({ scope: null, management: true, disabled: true }).where(eq(keys.keyHash, owner.hash));
  expect((await h.request(path(owner.hash), { headers: owner.auth })).status).toBe(401);
  await h.ctx.db.update(keys).set({ disabled: false, expiresAt: new Date(Date.now() - 1000) }).where(eq(keys.keyHash, owner.hash));
  expect((await h.request(path(owner.hash), { headers: owner.auth })).status).toBe(401);
});
test("existing feature defaults off and rejects status with and without authentication", async () => {
  expect(loadConfig({ ANYROUTE_ENV: 'test' }).agentPolicyEnabled).toBe(false);
  const owner = await off.newKey();
  for (const headers of [{}, owner.auth]) expect((await off.request(path(owner.hash), { headers })).status).toBe(404);
});
