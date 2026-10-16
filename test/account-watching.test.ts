import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readWatching } from '../web/lib/watching.js';
import { ApiError } from '../web/lib/api.js';
import { MODELS, startRouter, type Harness } from './helpers.ts';

let h: Harness;
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: 'true', QUIET_AGENT_ALERTS_ENABLED: 'true', MODEL_WATCH_ENABLED: 'true', LOW_BALANCE_ALERTS_ENABLED: 'true', SCHEDULED_PROMPTS_ENABLED: 'true', INFERENCE_KEYS_ENABLED: 'true' } });
});
afterAll(async () => { await h?.close(); });
function reader(router: Harness, auth: Record<string, string> = {}, calls: string[] = []) {
  return async (path: string) => {
    calls.push(path);
    const response = await router.request(path, { headers: auth }), body = await response.json();
    if (!response.ok) throw new ApiError(response.status, body.error.message, body.error.type);
    return body;
  };
}
const find = (groups: any[], id: string) => groups.find(group => group.id === id);
test('existing readers compose active settings from every feature and preserve account isolation', async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey();
  const put = async (path: string, method: string, json: unknown) => {
    const response = await h.request(path, { headers: owner.auth, method, json });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json();
  };
  await put('/api/v1/account/model-watch', 'PUT', { model: MODELS.llama.slug });
  await put(`/api/v1/agents/${owner.hash}/quiet-alert`, 'PUT', { hours: 12 });
  await put('/api/v1/projects/research/budget', 'PUT', { budget_usd: 40 });
  await put('/api/v1/account/low-balance', 'PATCH', { low_balance_usd: 5 });
  await put(`/api/v1/agents/${owner.hash}/policy`, 'PUT', { version: 1, models: {}, caps: { per_day_usd: 20 }, on_breach: 'deny', alerts: { at_percent: [75], denials_in_10min: 3, channels: [] } });
  const schedule = { name: 'Daily reading', prompt: 'Private schedule instructions', model: MODELS.llama.slug, key_hash: owner.hash, cadence: 'daily', time_utc: '08:00', max_cost_usd: 1 };
  await put('/api/v1/schedules', 'POST', schedule);
  await put('/api/v1/schedules', 'POST', { ...schedule, name: 'Paused reading', paused: true });
  const prefs = (await (await h.request('/api/v1/account/notifications', { headers: owner.auth })).json()).data;
  for (const type of ['approval_reminders', 'status_incidents', 'price_notices', 'weekly_summary']) prefs.channels[type] = { inbox: true, telegram: false };
  await put('/api/v1/account/notifications', 'PUT', { channels: prefs.channels, quiet_hours: null });
  const groups = await readWatching(reader(h, owner.auth), {});
  for (const id of ['model_watch', 'quiet_agents', 'project_budgets', 'low_balance', 'agent_alerts', 'approval_reminders', 'status_incidents', 'price_notices', 'weekly_summary', 'scheduled_results']) {
    expect(find(groups, id).state, id).toBe('ready'); expect(find(groups, id).items.length, id).toBeGreaterThan(0);
  }
  expect(find(groups, 'project_budgets').items[0].setting).toBe('$40 per month · Notice at 80%');
  expect(find(groups, 'agent_alerts').items[0].setting).toContain('75% of $20 per day');
  expect(find(groups, 'agent_alerts').items[0].setting).toContain('3 refusals in 10 minutes');
  expect(find(groups, 'scheduled_results').items.map((row: any) => row.title)).toEqual(['Daily reading']);
  expect(JSON.stringify(groups)).not.toContain(schedule.prompt);
  const isolated = await readWatching(reader(h, other.auth), {});
  for (const id of ['model_watch', 'quiet_agents', 'project_budgets', 'low_balance', 'agent_alerts', 'scheduled_results']) expect(find(isolated, id).items).toEqual([]);
  expect(find(isolated, 'weekly_summary').items[0].setting).toBe('Off in Notifications');
  expect(find(isolated, 'status_incidents').items[0].setting).toBe('Off in Notifications');
});
test('default feature guards stay off and failed readers are distinct from empty lists', async () => {
  const owner = await h.fundedKey(), saved = h.ctx.cfg;
  h.ctx.cfg = { ...saved, agentPolicyEnabled: false, quietAgentAlertsEnabled: false, modelWatchEnabled: false, lowBalanceAlertsEnabled: false, scheduledPromptsEnabled: false };
  try {
    const groups = await readWatching(reader(h, owner.auth), {});
    for (const id of ['model_watch', 'quiet_agents', 'agent_alerts', 'scheduled_results']) expect(find(groups, id).state, id).toBe('unavailable');
    expect(find(groups, 'project_budgets').state).toBe('ready'); expect(find(groups, 'project_budgets').items).toEqual([]);
    expect(find(groups, 'low_balance').note).toContain('switched off');
  } finally { h.ctx.cfg = saved; }
});
test('auth, ordinary, inference, session and read-only keys are refused before composing features', async () => {
  const owner = await h.fundedKey();
  const calls: string[] = [];
  await expect(readWatching(reader(h, {}, calls), {})).rejects.toMatchObject({ status: 401 });
  expect(calls).toEqual(['/api/v1/account/notifications']);
  for (const scope of [undefined, 'inference', 'read']) {
    const response = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Watching reader', ...(scope ? { scope } : {}) } });
    expect(response.status).toBe(201); const body = await response.json(), attempted: string[] = [];
    await expect(readWatching(reader(h, { authorization: `Bearer ${body.key}` }, attempted), {})).rejects.toMatchObject({ status: 403, ...(scope === 'read' ? { type: 'read_only_key' } : {}) });
    expect(attempted).toEqual(['/api/v1/account/notifications']);
  }
  const response = await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { name: 'Watching session', budget_usd: 1, ttl_minutes: 5 } });
  expect(response.status).toBe(201); const session = await response.json();
  await expect(readWatching(reader(h, { authorization: `Bearer ${session.data.key}` }), {})).rejects.toMatchObject({ status: 403 });
});
