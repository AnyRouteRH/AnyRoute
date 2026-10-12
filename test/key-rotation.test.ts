// G158: same cases with PGlite and Postgres; every transaction uses its own connection.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { accounts, agentSessions, chainEvents, keys, kv, paywithSessions, spendAlerts, teamMembers, teams } from "../src/db/schema.ts";
import { agentPolicies } from "../src/agents/schema.ts";
import { policyVersions } from "../src/agents/policy-versions-schema.ts";
import { agentPolicySchema, agentPolicySha256 } from "../src/agents/policy.ts";
import { approversKey } from "../src/agents/approvers.ts";
import { QUIET_PREFIX } from "../src/agents/quiet-alerts.ts";
import { GRACE_MS, graceDeadline, readRotation, rotationKey } from "../src/key-rotation/store.ts";
import { runSecurityAlerts, securityInbox } from "../src/security-alerts/worker.ts";
import { preferenceKey } from "../src/security-alerts/records.ts";
import { uid } from "../src/lib/util.ts";
let h: Harness;
let owner: Awaited<ReturnType<Harness['fundedKey']>>;
beforeAll(async () => {
  h = await startRouter({ env: { INFERENCE_KEYS_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TRUST_PROXY: "true" } });
  owner = await h.fundedKey();
  // A bounded, explicit chain response; unindexed deposits and unavailable checks tested below.
  h.chain.client.readContract = (async () => 0n) as typeof h.chain.client.readContract;
});
afterAll(async () => { await h?.close(); });
type Key = { hash: string; auth: Record<string, string> };
async function child(spec = {}) {
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Workload', ...spec } });
  expect(response.status).toBe(201);
  const result = await response.json();
  return { hash: result.data.hash as string, auth: { authorization: `Bearer ${result.key}` } };
}
const rotate = (key: Key, grace: string = '24h', caller = owner) => h.request(`/api/v1/keys/${key.hash}/rotate`, { method: 'POST', headers: caller.auth, json: { grace } });
const row = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0];
const metadata = (key: Key, caller = owner) => h.request(`/api/v1/keys/${key.hash}/rotation`, { headers: caller.auth });

test('all grace choices cap the previous expiry without extending it', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  for (const grace of ['1h', '24h', '7d'] as const) {
    expect(graceDeadline(null, grace, now).getTime()).toBe(now.getTime() + GRACE_MS[grace]);
    const early = new Date(now.getTime() + 30_000);
    expect(graceDeadline(early, grace, now)).toEqual(early);
    expect(graceDeadline(new Date(now.getTime() + GRACE_MS[grace] * 2), grace, now).getTime()).toBe(now.getTime() + GRACE_MS[grace]);
  }
});
test('default case leaves unrelated reads identical and records no security alert while off', async () => {
  const key = await child();
  const before = await (await h.request(`/api/v1/keys/${key.hash}`, { headers: owner.auth })).text();
  const result = await metadata(key); expect(result.status).toBe(200); expect(await result.json()).toEqual({ data: null });
  expect(await (await h.request(`/api/v1/keys/${key.hash}`, { headers: owner.auth })).text()).toBe(before);
  const response = await rotate(key); expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:rotation:${key.hash}`))).toEqual([]);
});
test('copies every key setting, role, policy, history, approvers and alert rule without copying spend', async () => {
  const team = uid('rotation-team-');
  const [account] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, (await row(owner.hash)).accountId));
  await h.ctx.db.insert(teams).values({ id: team, name: 'Rotation team', ownerAccount: account.id });
  const key = await child({ team, role: 'admin', management: true, limit: 50, limit_reset: 'weekly', rpm: 23, tpm: 1234, allowed_models: ['rotation-model'], include_byok_in_limit: true });
  const now = new Date(), expires = new Date(now.getTime() + 10 * 86_400_000);
  await h.ctx.db.update(keys).set({ project: 'rotation-project', allowedIps: ['192.0.2.0/24'], routing: { provider: { lane: 'attested' } }, guardrails: { pii: 'redact' }, tracing: { sealed: 'sealed-settings' }, topup: { below_usd: 2, add_usd: 3, max_per_week_usd: 6 }, payWithDefault: 'NVDA', periodStart: now, expiresAt: expires, spent: 3n, spentTotal: 8n, lastUsed: now }).where(eq(keys.keyHash, key.hash));
  const policy = agentPolicySchema.parse({ version: 1, models: { allow: ['rotation-model'] }, caps: { per_day_usd: 5 }, alerts: { channels: ['telegram'], at_percent: [80] }, on_breach: 'deny' });
  await h.ctx.db.insert(agentPolicies).values({ keyHash: key.hash, version: 1, spec: policy, sha256: agentPolicySha256(policy), killed: true, killedAt: now, killedReason: 'Owner stopped', killUntil: expires, updatedBy: owner.hash });
  await h.ctx.db.insert(policyVersions).values({ keyHash: key.hash, spec: policy, sha256: agentPolicySha256(policy), source: 'save', savedBy: owner.hash, savedAt: now });
  await h.ctx.db.insert(kv).values([{ key: approversKey(key.hash), value: { mode: 'owners_and_admins', member_ids: [] } }, { key: QUIET_PREFIX + key.hash, value: { hours: 6, enabled_at: now.toISOString(), notified_for: now.toISOString(), notices: [{ id: 'old-notice' }] } }]);
  await h.ctx.db.insert(spendAlerts).values({ id: uid('sa_'), accountId: account.id, keyHash: key.hash, kind: 'threshold', thresholdUsd: 300n, window: 'week', webhookUrlEnc: 'sealed-webhook', enabled: false, lastFiredAt: now, lastPeriod: 'prior', state: { v: 1, history: [{ id: 'old' }] }, createdBy: owner.hash });
  const old = await row(key.hash);
  const response = await rotate(key, '7d'); expect(response.status).toBe(201);
  const result = await response.json(), next = await row(result.data.hash);
  const omitted = new Set(['keyHash', 'chainKeyHash', 'keyAddress', 'label', 'createdAt', 'lastUsed', 'spentTotal']);
  for (const field of Object.keys(old) as (keyof typeof old)[]) if (!omitted.has(field)) expect(next[field], field).toEqual(old[field]);
  expect(next.keyHash).not.toBe(old.keyHash); expect(next.name).toBe(old.name); expect(next.spent).toBe(3n); expect(next.spentTotal).toBe(0n); // the period's spend carries the budget over expect(next.lastUsed).toBeNull();
  expect((await row(old.keyHash)).spentTotal).toBe(8n);
  expect((await h.ctx.db.select().from(teamMembers).where(eq(teamMembers.keyHash, next.keyHash)))[0].role).toBe('admin');
  const [copiedPolicy] = await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, next.keyHash));
  expect(copiedPolicy).toEqual({ ...(await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, old.keyHash)))[0], keyHash: next.keyHash });
  const [revision] = await h.ctx.db.select().from(policyVersions).where(eq(policyVersions.keyHash, next.keyHash));
  expect(revision.spec).toEqual(policy); expect(revision.savedBy).toBe(owner.hash); expect(revision.savedAt).toEqual(now);
  expect((await h.ctx.db.select().from(kv).where(eq(kv.key, approversKey(next.keyHash))))[0].value).toEqual({ mode: 'owners_and_admins', member_ids: [] });
  expect((await h.ctx.db.select().from(kv).where(eq(kv.key, QUIET_PREFIX + next.keyHash)))[0].value).toMatchObject({ hours: 6, notices: [], notified_for: null });
  const [alert] = await h.ctx.db.select().from(spendAlerts).where(eq(spendAlerts.keyHash, next.keyHash));
  expect(alert).toMatchObject({ kind: 'threshold', thresholdUsd: 300n, window: 'week', webhookUrlEnc: 'sealed-webhook', enabled: false, state: { v: 1, history: [] }, lastFiredAt: null, lastPeriod: null });
  expect(result.rotation).toMatchObject({ from: key.hash, to: null, history_key_hash: key.hash });
  expect(await readRotation(h.ctx.db, key.hash)).toMatchObject({ to: next.keyHash });
  expect((await h.request('/api/v1/key', { headers: { authorization: `Bearer ${result.key}`, "x-forwarded-for": "192.0.2.10" } })).status).toBe(200);
  expect(JSON.stringify(await h.ctx.db.select().from(kv))).not.toContain(result.key);
});
test('old and new secrets work during grace, earlier expiry survives, and old fails through key_expired', async () => {
  const key = await child(); const early = new Date(Date.now() + 60_000);
  await h.ctx.db.update(keys).set({ expiresAt: early }).where(eq(keys.keyHash, key.hash));
  const response = await rotate(key, '24h'); expect(response.status).toBe(201); const result = await response.json();
  expect(result.data.expires_at).toBe(early.toISOString()); expect(result.rotation.grace_ends_at).toBe(early.toISOString());
  expect((await h.request('/api/v1/key', { headers: key.auth })).status).toBe(200);
  const rejected = await h.request(`/api/v1/keys/${key.hash}`, { method: 'PATCH', headers: owner.auth, json: { expires_at: null } }); expect(rejected.status).toBe(409);
  // Advance just the retirement deadline; leave the replacement's original expiry alone.
  const link = await readRotation(h.ctx.db, key.hash);
  await h.ctx.db.update(kv).set({ value: { ...link, grace_ends_at: new Date(Date.now() - 1000).toISOString() } }).where(eq(kv.key, rotationKey(key.hash)));
  const expired = await h.request('/api/v1/key', { headers: key.auth }); expect(expired.status).toBe(401); expect((await expired.json()).error.type).toBe('key_expired');
  expect((await h.request('/api/v1/key', { headers: { authorization: `Bearer ${result.key}` } })).status).toBe(200);
});
test('refuses repeated rotations, disabled and expired keys and invalid grace', async () => {
  const key = await child(); expect((await rotate(key)).status).toBe(201); expect((await rotate(key)).status).toBe(409);
  for (const patch of [{ disabled: true }, { expiresAt: new Date(0) }]) { const inactive = await child(); await h.ctx.db.update(keys).set(patch).where(eq(keys.keyHash, inactive.hash)); expect((await rotate(inactive)).status).toBe(409); }
  expect((await rotate(await child(), 'forever')).status).toBe(400);
  const strict = await h.request(`/api/v1/keys/${(await child()).hash}/rotate`, { method: 'POST', headers: owner.auth, json: { grace: '1h', management: true } }); expect(strict.status).toBe(400);
});
test('refuses deposit-first roots, funded subkeys, pending chain events and Stock Token sessions', async () => {
  expect((await rotate(owner)).status).toBe(409);
  const emptyRoot = await h.newKey(); expect((await rotate(emptyRoot, '1h', emptyRoot)).status).toBe(409);
  const funded = await child(); await h.chain.deposit(h.ctx, (await row(funded.hash)).chainKeyHash, 1_000_000n); expect((await rotate(funded)).status).toBe(409);
  const pending = await child(); await h.ctx.db.insert(chainEvents).values({ txHash: uid('tx_'), logIndex: 0, contract: 'credits', event: 'Deposited', blockNumber: 1n, args: { keyHash: (await row(pending.hash)).chainKeyHash, amount: '1000000' } }); expect((await rotate(pending)).status).toBe(409);
  const stock = await child(); await h.ctx.db.insert(paywithSessions).values({ keyHash: (await row(stock.hash)).chainKeyHash, wallet: '0x' + '12'.repeat(20), token: 'NVDA', symbol: 'NVDA', capRawDay: 1n }); expect((await rotate(stock)).status).toBe(409);
});
test('refuses unindexed chain deposits and fails closed when funding cannot be checked', async () => {
  const key = await child(), read = h.chain.client.readContract;
  try {
    h.chain.client.readContract = (async () => 1n) as typeof read; expect((await rotate(key)).status).toBe(409);
    h.chain.client.readContract = (async () => { throw new Error('unavailable'); }) as typeof read; expect((await rotate(key)).status).toBe(503);
    expect(await readRotation(h.ctx.db, key.hash)).toBeNull();
  } finally { h.chain.client.readContract = read; }
});
test('refuses session targets and session callers', async () => {
  const session = await child({ management: true }); const source = await row(session.hash);
  await h.ctx.db.insert(agentSessions).values({ id: uid('session_'), accountId: source.accountId, parentKeyHash: owner.hash, keyHash: source.keyHash, name: 'Run', expiresAt: new Date(Date.now() + 60_000) });
  expect((await rotate(session)).status).toBe(409); expect((await rotate(await child(), '1h', session)).status).toBe(409);
});
test('auth requires a management key for others, rejects read/inference callers and cross-account keys', async () => {
  const key = await child();
  expect((await h.request(`/api/v1/keys/${key.hash}/rotate`, { method: 'POST', json: { grace: '1h' } })).status).toBe(401);
  for (const scope of ['read', 'inference'] as const) {
    const caller = await child({ scope }); expect((await rotate(key, '1h', caller)).status).toBe(403); expect((await metadata(key, caller)).status).toBe(403);
    // A management caller can replace a restricted target without widening its scope.
    const replaced = await rotate(caller); expect(replaced.status).toBe(201); expect((await replaced.json()).data.scope).toBe(scope);
  }
  expect((await rotate(key, '1h', key)).status).toBe(403);
  const foreign = await h.newKey(); expect((await rotate(key, '1h', foreign)).status).toBe(404); expect((await metadata(key, foreign)).status).toBe(404);
});
test('team admins rotate themselves only and the org budget protects the overlap', async () => {
  const team = uid('self-team-'), accountId = (await row(owner.hash)).accountId;
  await h.ctx.db.insert(teams).values({ id: team, name: 'Self team', ownerAccount: accountId, budget: 40n * 10n ** 12n });
  const admin = await child({ team, role: 'admin', limit: 10 }); const peer = await child({ team, role: 'member', limit: 10 });
  expect((await rotate(peer, '1h', admin)).status).toBe(403);
  expect((await rotate(admin, '1h', admin)).status).toBe(201);
  await h.ctx.db.update(teams).set({ budget: 30n * 10n ** 12n }).where(eq(teams.id, team));
  expect((await rotate(peer)).status).toBe(409); expect(await readRotation(h.ctx.db, peer.hash)).toBeNull();
});
test('wallet account management keys can rotate themselves and retain management', async () => {
  const key = await h.newKey(); await h.ctx.db.update(accounts).set({ kind: 'wallet' }).where(eq(accounts.id, (await row(key.hash)).accountId));
  const response = await rotate(key, '1h', key); expect(response.status).toBe(201); expect((await response.json()).data.management).toBe(true);
});
test('replacement can later rotate with both directional links retained', async () => {
  const first = await child(); const result = await (await rotate(first)).json(); const second = { hash: result.data.hash, auth: { authorization: `Bearer ${result.key}` } };
  const response = await rotate(second); expect(response.status).toBe(201);
  const link = await readRotation(h.ctx.db, second.hash); expect(link?.from).toBe(first.hash); expect(link?.to).toBe((await response.json()).data.hash);
});
test('concurrent rotations create exactly one replacement', async () => {
  const key = await child(); const responses = await Promise.all([rotate(key), rotate(key)]);
  expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
});
test('Key rotated uses the existing security notice and respects disabled channels', async () => {
  h.ctx.cfg.securityAlertsEnabled = true;
  try {
    const key = await child(); expect((await rotate(key)).status).toBe(201);
    const event = (await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:rotation:${key.hash}`)))[0]; expect(event.value).toMatchObject({ title: "Key rotated for key 'Workload' by key 'test'", state: 'pending' });
    await runSecurityAlerts(h.ctx);
    const notices = await securityInbox(h.ctx, await row(owner.hash), true); expect(notices.some(n => n.title.startsWith('Key rotated'))).toBe(true);
    await h.ctx.db.insert(kv).values({ key: preferenceKey((await row(owner.hash)).accountId), value: { enabled: false, inbox: false, telegram: false } });
    const muted = await child(); expect((await rotate(muted)).status).toBe(201);
    const mutedEvent = (await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:rotation:${muted.hash}`)))[0]; expect((mutedEvent.value as { state: string }).state).toBe('muted');
  } finally { h.ctx.cfg.securityAlertsEnabled = false; }
});
