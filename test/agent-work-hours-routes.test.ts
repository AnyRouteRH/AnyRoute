import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { startRouter, MODELS, type Harness } from './helpers.ts';
import { agentPolicies } from '../src/agents/schema.ts';
import { agentApprovals } from '../src/agents/approval-schema.ts';
import { accounts, holds, keys } from '../src/db/schema.ts';
import { enforceAgentTool } from '../src/agents/enforce.ts';
import { approvalRequest } from '../src/agents/approvals.ts';
import { agentPolicySha256, type AgentPolicy } from '../src/agents/policy.ts';
let h: Harness;
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: 'deny' };
// Tomorrow's UTC day makes these hours closed at any current time, without mocking clocks.
const closed = (outside: 'refuse' | 'ask_first'): AgentPolicy => ({ ...base, work_hours: { days: [(new Date().getUTCDay() + 1) % 7], start: '09:00', end: '18:00', time_zone: 'UTC', outside } });
type Key = { hash: string; auth: Record<string, string> };
const path = (key: Key) => `/api/v1/agents/${key.hash}/policy`;
const put = (owner: Key, agent: Key, policy: AgentPolicy) => h.request(path(agent), { method: 'PUT', headers: owner.auth, json: policy });
const call = (key: Key, approval?: string) => h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...key.auth, ...(approval ? { 'x-agent-approval': approval } : {}) }, json: { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'sample work hours request' }], max_tokens: 32 } });
const balance = async (key: Key) => {
  const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  return (await h.ctx.db.select().from(accounts).where(eq(accounts.id, row.accountId)))[0].balance;
};
const held = async (key: Key) => h.ctx.db.select().from(holds).where(eq(holds.keyHash, key.hash));
async function child(owner: Key) {
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Work hours agent' } });
  expect(response.status).toBe(201); const made = await response.json();
  return { hash: made.data.hash, auth: { authorization: `Bearer ${made.key}` } };
}
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: 'true', AGENT_GUARD_ENABLED: 'true', INFERENCE_KEYS_ENABLED: 'true' } }); });
afterAll(async () => { await h?.close(); });

test('refuse before any hold, charge or provider call; dry run explains the next opening', async () => {
  const owner = await h.fundedKey(), agent = await child(owner);
  expect((await put(owner, agent, closed('refuse'))).status).toBe(200);
  const before = await balance(agent), requests = h.mocks.alpha.stats.requests;
  const response = await call(agent); expect(response.status).toBe(403);
  const error = (await response.json()).error;
  expect(error.type).toBe('agent_policy_denied'); expect(error.metadata.reasons[0].code).toBe('outside_work_hours');
  expect(error.message).toContain('Next work hours begin'); expect(error.message).toContain('UTC');
  expect(await balance(agent)).toBe(before); expect(await held(agent)).toHaveLength(0); expect(h.mocks.alpha.stats.requests).toBe(requests);
  const check = await h.request('/api/v1/agents/check', { method: 'POST', headers: agent.auth, json: { kind: 'inference', model: MODELS.llama.slug, lane: 'public', est_cost_pico: '1', tools: [] } });
  expect(check.status).toBe(200); expect((await check.json()).data.decision).toBe('deny');
});
test('ask first reuses pending approvals, requires owner approval, consumes once and rechecks changed rules', async () => {
  const owner = await h.fundedKey(), agent = await child(owner);
  await put(owner, agent, closed('ask_first'));
  const before = await balance(agent), requests = h.mocks.alpha.stats.requests;
  const pending = await call(agent); expect(pending.status).toBe(403);
  const error = (await pending.json()).error;
  expect(error.type).toBe('agent_approval_required'); expect(error.metadata.reasons[0].code).toBe('approval_work_hours');
  const id = error.metadata.approval_id;
  expect((await (await call(agent)).json()).error.metadata.approval_id).toBe(id);
  expect(await balance(agent)).toBe(before); expect(await held(agent)).toHaveLength(0); expect(h.mocks.alpha.stats.requests).toBe(requests);
  expect((await h.request(`/api/v1/agents/approvals/${id}/approve`, { method: 'POST', headers: owner.auth })).status).toBe(200);
  expect((await call(agent, id)).status).toBe(200);
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0].status).toBe('used');
  expect((await call(agent, id)).status).toBe(403);
  const next = (await (await call(agent)).json()).error.metadata.approval_id;
  expect((await h.request(`/api/v1/agents/approvals/${next}/approve`, { method: 'POST', headers: owner.auth })).status).toBe(200);
  await put(owner, agent, closed('refuse'));
  const denied = await call(agent, next); expect(denied.status).toBe(403); expect((await denied.json()).error.type).toBe('agent_policy_denied');
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, next)))[0].status).toBe('approved');
});
test('declared MCP tools reuse existing approvals and Guard actions use their own approved retry', async () => {
  const owner = await h.fundedKey(), agent = await child(owner);
  const policy = { ...closed('ask_first'), actions: { allow: ['payment.send'] } };
  await put(owner, agent, policy);
  let id = '';
  try { await enforceAgentTool(h.ctx, agent.auth.authorization, 'read'); throw new Error('Expected approval'); }
  catch (error: any) { expect(error.type).toBe('agent_approval_required'); id = error.metadata.approval_id; }
  expect((await h.request(`/api/v1/agents/approvals/${id}/approve`, { method: 'POST', headers: owner.auth })).status).toBe(200);
  await approvalRequest.run(id, () => enforceAgentTool(h.ctx, agent.auth.authorization, 'read'));
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0].status).toBe('used');
  const decide = (approval_id?: string) => h.request('/api/v1/guard/decide', { method: 'POST', headers: agent.auth, json: { action: 'payment.send', amount_usd: '1', ...(approval_id ? { approval_id } : {}) } });
  const result = await decide(); expect(result.status).toBe(200); const pending = (await result.json()).data;
  expect(pending.decision).toBe('approval_required');
  expect((await h.request(`/api/v1/agents/approvals/${pending.approval_id}/approve`, { method: 'POST', headers: owner.auth })).status).toBe(200);
  expect((await (await decide(pending.approval_id)).json()).data.decision).toBe('allow');
});
test('history retains, describes and restores hours; replay route accepts the field', async () => {
  const owner = await h.fundedKey(), agent = await child(owner), policy = closed('refuse');
  await put(owner, agent, policy); await put(owner, agent, base);
  const versions = await h.request(path(agent) + '/versions', { headers: owner.auth }); expect(versions.status).toBe(200);
  const history = (await versions.json()).data;
  expect(history[1].spec.work_hours).toEqual(policy.work_hours); expect(history[0].diff.removed.join(' ')).toContain('Works');
  const restored = await h.request(path(agent) + '/restore', { method: 'POST', headers: owner.auth, json: { sha256: agentPolicySha256(policy) } });
  expect(restored.status).toBe(200); expect((await restored.json()).data.policy).toEqual(policy);
  const replay = await h.request(`/api/v1/agents/${agent.hash}/replay`, { method: 'POST', headers: owner.auth, json: { policy, days: 1 } });
  expect(replay.status).toBe(200);
});
test('auth and management guards remain: missing, foreign, inference-only and read-only callers', async () => {
  const owner = await h.fundedKey(), stranger = await h.fundedKey(), agent = await child(owner);
  expect((await h.request(path(agent), { method: 'PUT', json: closed('refuse') })).status).toBe(401);
  expect((await put(stranger, agent, closed('refuse'))).status).toBe(404);
  for (const scope of ['inference', 'read']) {
    const made = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { scope } })).json();
    const auth = { authorization: `Bearer ${made.key}` };
    expect((await h.request(path(agent), { method: 'PUT', headers: auth, json: closed('refuse') })).status).toBe(403);
  }
  const invalid = { ...closed('refuse'), work_hours: { ...closed('refuse').work_hours, time_zone: 'Mars/Nowhere' } };
  expect((await h.request(path(agent), { method: 'PUT', headers: owner.auth, json: invalid })).status).toBe(400);
});
test('default-off config ignores stored work hours and keeps routes off', async () => {
  const off = await startRouter();
  try {
    expect(off.ctx.cfg.agentPolicyEnabled).toBe(false);
    const key = await off.fundedKey(), policy = closed('refuse');
    await off.ctx.db.insert(agentPolicies).values({ keyHash: key.hash, version: 1, spec: policy, sha256: agentPolicySha256(policy), updatedBy: key.hash });
    expect((await off.request(path(key), { method: 'PUT', headers: key.auth, json: policy })).status).toBe(404);
    const result = await off.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'sample hours off request' }], max_tokens: 32 } });
    expect(result.status).toBe(200);
  } finally { await off.close(); }
});
