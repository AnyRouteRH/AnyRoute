import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MODELS, startRouter, type Harness } from './helpers.ts';
import { ApiError } from '../src/lib/errors.ts';
import { identifyRefusal, refusalHelp } from '../src/why/help.ts';
import { routerErrorInfo, errorBody } from '../src/anthropic/convert.ts';
import { agentPolicySha256, type AgentPolicy } from '../src/agents/policy.ts';
import { agentPolicies } from '../src/agents/schema.ts';
import { refusalTarget } from '../src/why/details.ts';

const types = ['agent_policy_denied', 'agent_killed', 'agent_approval_required', 'agent_approval_invalid', 'model_not_allowed', 'key_budget_exceeded', 'project_budget_exceeded', 'ip_not_allowed', 'read_only_key'];
for (const type of types) test(`${type} adds only a stable help_url and adapters preserve it`, () => {
  const error = new ApiError(403, 'A rule refused this request.', type, { amount: 2 });
  const body = error.toJSON()! as any;
  const { help_url, ...unchanged } = body.error;
  expect(unchanged).toEqual({ code: 403, message: error.message, type, metadata: { amount: 2 } });
  const link = new URL(help_url, 'https://anyroute.invalid');
  expect(link.pathname).toBe('/why/'); expect(link.searchParams.get('type')).toBe(type);
  expect(link.searchParams.get('id')).toBeTruthy(); expect(error.toJSON()).toEqual(body);
  const info = routerErrorInfo(body.error);
  expect(info.help_url).toBe(help_url);
  expect((errorBody(403, error.message, 'request-id', info).error as any).help_url).toBe(help_url);
});
test('unrelated errors and external links stay unchanged; recorded identifiers replace ephemeral ones', () => {
  expect(new ApiError(401, 'Missing key.', 'missing_key').toJSON()).toEqual({ error: { code: 401, message: 'Missing key.', type: 'missing_key' } });
  const error = new ApiError(403, 'Refused.', 'agent_policy_denied'); identifyRefusal(error, '123');
  expect(refusalHelp(error)).toEqual({ help_url: '/why/?type=agent_policy_denied&id=123' });
  expect(refusalHelp({ type: 'agent_policy_denied', help_url: 'https://other.invalid/why/' }).help_url).toStartWith('/why/');
});
let h: Harness;
type Key = Awaited<ReturnType<Harness['fundedKey']>>;
let owner: Key;
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: 'deny' };
const body = { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'private request text should never appear in the refusal page' }], max_tokens: 16 };
const call = (key: { auth: Record<string, string> }) => h.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: body });
async function child(spec: Record<string, unknown> = {}) {
  const { allowed_ips, ...createSpec } = spec;
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Sample agent', ...createSpec } });
  expect(response.status).toBe(201); const made = await response.json();
  if (allowed_ips) expect((await h.request('/api/v1/keys/' + made.data.hash, { method: 'PATCH', headers: owner.auth, json: { allowed_ips } })).status).toBe(200);
  return { hash: made.data.hash, auth: { authorization: 'Bearer ' + made.key } };
}
async function policy(key: { hash: string }, spec: AgentPolicy) {
  expect((await h.request(`/api/v1/agents/${key.hash}/policy`, { method: 'PUT', headers: owner.auth, json: spec })).status).toBe(200);
}
function detailsPath(error: any) {
  const link = new URL(error.help_url, 'https://anyroute.invalid');
  return '/api/v1/refusals/' + link.searchParams.get('id') + '?type=' + link.searchParams.get('type');
}
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: 'true', INFERENCE_KEYS_ENABLED: 'true' } }); owner = await h.fundedKey(); });
afterAll(async () => { await h?.close(); });

for (const scenario of [
  { name: 'caps', spec: { ...base, caps: { per_request_usd: .000000001 } }, code: 'over_per_request', type: 'agent_policy_denied' },
  { name: 'models', spec: { ...base, models: { allow: [] } }, code: 'model_not_allowed', type: 'agent_policy_denied' },
  { name: 'work hours', spec: { ...base, work_hours: { days: [(new Date().getUTCDay() + 1) % 7], start: '09:00', end: '18:00', time_zone: 'UTC', outside: 'refuse' as const } }, code: 'outside_work_hours', type: 'agent_policy_denied' },
  { name: 'approval', spec: { ...base, approval: { above_usd: .000000001 } }, code: 'approval_required', type: 'agent_approval_required' },
  { name: 'stopped', spec: base, code: 'killed', type: 'agent_killed' },
]) test(`actual ${scenario.name} refusal links to its saved event and rules`, async () => {
  const agent = await child(); await policy(agent, scenario.spec);
  if (scenario.name === 'stopped') expect((await h.request(`/api/v1/agents/${agent.hash}/kill`, { method: 'POST', headers: owner.auth, json: {} })).status).toBe(200);
  const result = await call(agent); expect(result.status).toBe(403);
  const error = (await result.json()).error; expect(error.type).toBe(scenario.type);
  expect(error.metadata.reasons.some((r: any) => r.code === scenario.code)).toBe(true);
  expect(new URL(error.help_url, 'https://anyroute.invalid').searchParams.get('id')).toMatch(/^\d+$/);
  const response = await h.request(detailsPath(error), { headers: owner.auth });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const data = (await response.json()).data;
  expect(data.reasons[0].href).toContain(agent.hash);
  expect(data.reasons[0].href).toBe(refusalTarget(scenario.code, agent.hash).href);
  expect(JSON.stringify(data)).not.toContain(body.messages[0].content);
  expect(data.facts.some((fact: string) => fact.startsWith('Estimated request cost: $'))).toBe(true);
  if (scenario.name !== 'stopped') expect(data.rules.length).toBeGreaterThan(0);
  if (scenario.name === 'stopped') expect(data.reasons[0].text).toBe('This agent was stopped.');
  // Editing the rulebook must not relabel the old decision with current numbers.
  if (scenario.name === 'caps') {
    expect(data.rules.join(' ')).toContain('$0.000000001');
    await policy(agent, { ...base, caps: { per_request_usd: 500 } });
    const saved = (await (await h.request(detailsPath(error), { headers: owner.auth })).json()).data;
    expect(saved.rules).toEqual(data.rules);
  }
});

test('missing, foreign, mismatched and allowed events never disclose account data; key scopes stay guarded', async () => {
  const agent = await child(); await policy(agent, { ...base, models: { allow: [] } });
  const error = (await (await call(agent)).json()).error, path = detailsPath(error);
  expect((await h.request(path)).status).toBe(401);
  const stranger = await h.fundedKey();
  for (const url of [path, '/api/v1/refusals/99999999999999?type=agent_policy_denied']) {
    const response = await h.request(url, { headers: stranger.auth }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: null });
  }
  expect(await (await h.request(path.replace('agent_policy_denied', 'agent_killed'), { headers: owner.auth })).json()).toEqual({ data: null });
  for (const spec of [{}, { scope: 'read' }, { scope: 'inference' }]) {
    const restricted = await child(spec);
    expect((await h.request(path, { headers: restricted.auth })).status).toBe(403);
  }
});

test('key budget, project budget, key model, IP and read-only guards add help without storing a refusal', async () => {
  const cases = [
    { spec: { limit: 0 }, type: 'key_budget_exceeded' },
    { spec: { allowed_models: [MODELS.qwen.slug] }, type: 'model_not_allowed' },
    { spec: { allowed_ips: ['203.0.113.9'] }, type: 'ip_not_allowed' },
    { spec: { scope: 'read' }, type: 'read_only_key' },
  ];
  for (const item of cases) {
    const key = await child(item.spec), response = await call(key);
    expect(response.status).toBe(item.type === 'key_budget_exceeded' ? 402 : 403);
    const error = (await response.json()).error; expect(error.type).toBe(item.type); expect(error.help_url).toContain('type=' + item.type);
    expect(await (await h.request(detailsPath(error), { headers: owner.auth })).json()).toEqual({ data: null });
  }
  expect((await h.request('/api/v1/projects/sample-project/budget', { method: 'PUT', headers: owner.auth, json: { budget_usd: 0 } })).status).toBe(200);
  const response = await h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...owner.auth, 'x-anyroute-project': 'sample-project' }, json: body });
  expect(response.status).toBe(402); const error = (await response.json()).error;
  expect(error.type).toBe('project_budget_exceeded'); expect(error.help_url).toContain('type=project_budget_exceeded'); expect(error.metadata.budget_usd).toBe('0');
  expect(await (await h.request(detailsPath(error), { headers: owner.auth })).json()).toEqual({ data: null });
});
test('default-off agent policies do not enforce saved rules or expose saved events; success is unchanged', async () => {
  const off = await startRouter();
  try {
    expect(off.ctx.cfg.agentPolicyEnabled).toBe(false); const key = await off.fundedKey();
    const spec = { ...base, models: { allow: [] } };
    await off.ctx.db.insert(agentPolicies).values({ keyHash: key.hash, version: 1, spec, sha256: agentPolicySha256(spec), updatedBy: key.hash });
    const result = await off.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: body });
    expect(result.status).toBe(200); expect(JSON.stringify(await result.json())).not.toContain('help_url');
    const response = await off.request('/api/v1/refusals/1?type=agent_policy_denied', { headers: key.auth });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: null });
  } finally { await off.close(); }
});
