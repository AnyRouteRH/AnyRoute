import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { agentPolicyEvents, generations, keys, teamMembers } from "../src/db/schema.ts";
import { reliabilityQuery } from "../src/reliability/query.ts";
import { reliabilityPercent } from "../src/reliability/read.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
type Key = { hash: string; auth: Record<string, string> };
const at = () => new Date(Date.now() - 86400000);
async function child(owner: Key) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Report key' } });
  expect(r.status).toBe(201); const j = await r.json(); return { hash: j.data.hash, auth: { authorization: 'Bearer ' + j.key } };
}
async function call(key: Key, id: string, extra: Partial<typeof generations.$inferInsert> = {}) {
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.insert(generations).values({ id, keyHash: key.hash, accountId: k.accountId, modelId: MODELS.llama.slug, providerId: 'alpha', mode: 'prepaid', ts: at(), finishReason: 'stop', ...extra });
}
async function deny(key: Key, codes: string[], extra: Partial<typeof agentPolicyEvents.$inferInsert> = {}) {
  await h.ctx.db.insert(agentPolicyEvents).values({ keyHash: key.hash, ts: at(), kind: 'decision', decision: 'deny', reasons: codes.map(code => ({ code, message: 'Private reason text' })), intent: { kind: 'inference', model: MODELS.llama.slug }, policySha256: 'fixture', prevHash: 'fixture', hash: 'fixture', ...extra });
}
async function read(key: Key, query = '') {
  const response = await h.request('/api/v1/account/reliability' + query, { headers: key.auth });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); return response.json();
}
test('rolling range is bounded, defaults to seven days, and ratio math rounds with empty denominators', () => {
  expect(reliabilityQuery({}, new Date('2026-10-10T12:34:56Z'))).toEqual({ days: 7, from: '2026-10-03T12:34:56.000Z', to: '2026-10-10T12:34:56.000Z' });
  expect(reliabilityQuery({ days: '1' }, new Date('2026-10-10T12:34:56Z')).from).toBe('2026-10-09T12:34:56.000Z');
  for (const days of ['0', '8', '-1', '1.5', '07', '', 'x']) expect(() => reliabilityQuery({ days })).toThrow();
  expect(reliabilityPercent('79', '80')).toBe(98.8); expect(reliabilityPercent('1', '3')).toBe(33.3); expect(reliabilityPercent('0', '0')).toBeNull();
  expect(reliabilityPercent('900719925474099300', '900719925474099300')).toBe(100);
});
test('aggregates every model, recorded success, fallback coverage and interpolated median/p95', async () => {
  const owner = await h.fundedKey(), agent = await child(owner);
  for (let i = 1; i <= 4; i++) await call(i === 4 ? agent : owner, 'reliability-math-' + i, {
    streamed: true, latencyMs: i * 100, generationTimeMs: i * 1000, finishReason: i === 4 ? 'error' : 'stop',
    ...(i <= 2 ? { receipt: { route: { reason: i === 1 ? 'fallback' : 'only_eligible', fallback: i === 1 ? { timeout: 2 } : undefined } } } : i === 3 ? { receiptV2: { route: { reason: 'lowest_price' } } } : {}),
  });
  await call(owner, 'reliability-second-model', { modelId: MODELS.qwen.slug, cancelled: true, latencyMs: 999, generationTimeMs: -1 });
  await call(owner, 'reliability-old', { ts: new Date(Date.now() - 8 * 86400000) });
  await call(owner, 'reliability-future', { ts: new Date(Date.now() + 86400000) });
  const r = await read(owner); expect(r.scope).toBe('account'); expect(r.days).toBe(7);
  expect(r.totals).toMatchObject({ calls: '5', succeeded: '3', success_rate: 60, fallback_calls: '1', route_recorded_calls: '3', fallback_rate: 33.3 });
  expect(r.models.find((row: any) => row.model === MODELS.llama.slug)).toMatchObject({ calls: '4', succeeded: '3', success_rate: 75,
    time_to_first_token_ms: { samples: '4', median: 250 }, total_latency_ms: { samples: '4', median: 2500 } });
  const model = r.models.find((row: any) => row.model === MODELS.llama.slug);
  expect(model.time_to_first_token_ms.p95).toBeCloseTo(385, 8); expect(model.total_latency_ms.p95).toBeCloseTo(3850, 8);
  expect(r.models.find((row: any) => row.model === MODELS.qwen.slug)).not.toHaveProperty('time_to_first_token_ms');
  expect(r.models.find((row: any) => row.model === MODELS.qwen.slug)).not.toHaveProperty('total_latency_ms');
  expect((await read(agent)).totals.calls).toBe('1');
});
test('denials count categories once per decision, separately from calls, without reading messages or approval/tool decisions', async () => {
  const owner = await h.fundedKey();
  await deny(owner, ['lane_not_allowed', 'over_per_day', 'over_per_day', 'model_not_allowed']);
  await deny(owner, ['breaker:max_spend_usd_per_minute']);
  await deny(owner, ['approval_required'], { decision: 'approval_required' });
  await deny(owner, ['model_not_allowed'], { intent: { kind: 'mcp_tool', name: 'private-tool' } });
  await deny(owner, ['killed'], { kind: 'killed' });
  await deny(owner, ['killed'], { ts: new Date(Date.now() - 8 * 86400000) });
  const r = await read(owner);
  expect(r.totals).toMatchObject({ calls: '0', succeeded: '0', success_rate: null, fallback_rate: null, refusals: { decisions: '2', lane: '1', budget: '2', rulebook: '1' } });
  expect(r.models).toHaveLength(1); expect(r.totals).not.toHaveProperty('time_to_first_token_ms');
  for (const secret of [owner.hash, 'Private reason text', 'private-tool', 'policySha256']) expect(JSON.stringify(r)).not.toContain(secret);
});
test('account/key scope excludes other accounts and mismatched stamps; removed-key account records remain visible', async () => {
  const owner = await h.fundedKey(), agent = await child(owner), other = await h.fundedKey();
  const [own] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  const [foreign] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, other.hash));
  await call(owner, 'reliability-scope-owner'); await call(agent, 'reliability-scope-agent'); await call(other, 'reliability-scope-other');
  await call(agent, 'reliability-wrong-stamp', { accountId: foreign.accountId });
  await call(owner, 'reliability-removed-key', { keyHash: 'sample-removed-key', accountId: own.accountId });
  await call(agent, 'reliability-legacy-stamp', { accountId: null });
  await deny(other, ['lane_not_allowed']);
  expect((await read(owner)).totals).toMatchObject({ calls: '4', refusals: { decisions: '0' } });
  expect((await read(agent)).totals.calls).toBe('2'); expect((await read(other)).totals.calls).toBe('2');
  expect(JSON.stringify(await read(owner))).not.toContain(other.hash);
});
test('non-management administrators keep the agent team boundary; session keys cannot gain account scope', async () => {
  const owner = await h.fundedKey(), admin = await child(owner), sameTeam = await child(owner), otherTeam = await child(owner);
  for (const key of [admin, sameTeam]) await h.ctx.db.update(keys).set({ teamId: 'reliability-team' }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.update(keys).set({ teamId: 'reliability-other-team' }).where(eq(keys.keyHash, otherTeam.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: 'reliability-team', keyHash: admin.hash, role: 'admin' });
  await call(owner, 'reliability-admin-account-call'); await deny(sameTeam, ['lane_not_allowed']); await deny(otherTeam, ['over_per_day']);
  expect((await read(admin))).toMatchObject({ scope: 'account', totals: { calls: '1', refusals: { decisions: '1', lane: '1', budget: '0' } } });
  expect((await read(owner)).totals.refusals.decisions).toBe('2');
  const response = await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } });
  const session = (await response.json()).data;
  await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, session.key_hash));
  expect(await read({ hash: session.key_hash, auth: { authorization: 'Bearer ' + session.key } })).toMatchObject({ scope: 'key', totals: { calls: '0' }, models: [] });
});
test('auth, invalid days, and empty state; default router offers only the opt-in reader and omits policy decisions when off', async () => {
  expect((await h.request('/api/v1/account/reliability')).status).toBe(401);
  expect((await h.request('/api/v1/account/reliability', { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
  const key = await h.fundedKey(); const empty = await read(key);
  expect(empty.models).toEqual([]); expect(empty.totals).toMatchObject({ calls: '0', success_rate: null, route_recorded_calls: '0', fallback_rate: null, refusals: { decisions: '0', lane: '0', budget: '0', rulebook: '0' } });
  expect(empty.totals).not.toHaveProperty('total_latency_ms');
  for (const days of ['0', '8', 'bad']) expect((await h.request('/api/v1/account/reliability?days=' + days, { headers: key.auth })).status).toBe(400);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, key.hash));
  expect((await h.request('/api/v1/account/reliability', { headers: key.auth })).status).toBe(401);
  const expired = await h.fundedKey();
  await h.ctx.db.update(keys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(keys.keyHash, expired.hash));
  expect((await h.request('/api/v1/account/reliability', { headers: expired.auth })).status).toBe(401);
  const off = await startRouter();
  try {
    const k = await off.fundedKey();
    await off.ctx.db.insert(agentPolicyEvents).values({ keyHash: k.hash, kind: 'decision', decision: 'deny', reasons: [{ code: 'lane_not_allowed' }], intent: { kind: 'inference', model: MODELS.llama.slug }, policySha256: 'fixture', prevHash: 'fixture', hash: 'fixture' });
    const r = await off.request('/api/v1/account/reliability', { headers: k.auth }); expect(r.status).toBe(200);
    expect((await r.json()).totals.refusals.decisions).toBe('0');
  } finally { await off.close(); }
});
test('first token uses only stream latency; null/missing timings stay absent and stored answers never supply TTFT', async () => {
  const key = await h.fundedKey();
  await call(key, 'reliability-stream-no-time', { streamed: true });
  await call(key, 'reliability-stored', { mode: 'cache', streamed: true, latencyMs: 20, generationTimeMs: 0 });
  await call(key, 'reliability-negative', { streamed: true, latencyMs: -1, generationTimeMs: -1 });
  const r = await read(key); expect(r.totals).not.toHaveProperty('time_to_first_token_ms');
  expect(r.totals.total_latency_ms).toEqual({ samples: '1', median: 0, p95: 0 });
});
