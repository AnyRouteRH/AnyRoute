import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTICE_ROWS, NOTIFICATION_PATH } from '../lib/notifications.js';
import { readWatching, watchingAgentRules, watchingChannels } from '../lib/watching.js';
import { TASKS } from '../lib/site-map.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hash = 'a'.repeat(64);
function reader(overrides = {}) {
  const channels = Object.fromEntries(NOTICE_ROWS.map(([id]) => [id, { inbox: false, telegram: false }]));
  const responses = {
    [NOTIFICATION_PATH]: { data: { channels, telegram_linked: false } },
    '/api/v1/account/model-watch': { data: [] }, '/api/v1/agents': { data: [] },
    '/api/v1/projects': { data: [] }, '/api/v1/account/low-balance': { low_balance_usd: null, enabled: true },
    '/api/v1/schedules': { data: [] }, ...overrides,
  };
  const calls = [];
  return { calls, channels, request: async (path, options) => {
    calls.push([path, options]);
    assert.ok(Object.hasOwn(responses, path), path);
    const value = responses[path]; if (value instanceof Error) throw value;
    return value;
  } };
}
const find = (groups, id) => groups.find(group => group.id === id);
test('each empty group has setup and each notice preference has an explicit off state', async () => {
  const r = reader(), groups = await readWatching(r.request, { key: 'sample-key' });
  for (const id of ['model_watch', 'quiet_agents', 'project_budgets', 'low_balance', 'agent_alerts', 'scheduled_results']) {
    const group = find(groups, id);
    assert.equal(group.items.length, 0); assert.ok(group.empty); assert.ok(group.action); assert.ok(group.href.startsWith('/'));
  }
  for (const id of ['approval_reminders', 'status_incidents', 'price_notices', 'weekly_summary']) {
    const group = find(groups, id);
    assert.equal(group.items[0].setting, 'Off in Notifications'); assert.equal(group.items[0].href, '/dashboard/#notifications');
  }
  assert.ok(r.calls.every(([, options]) => options.key === 'sample-key' && options.method === undefined));
});
test('compose every feature, retain zero thresholds, omit paused schedules and prompt text, and link existing editors', async () => {
  const r = reader({
    '/api/v1/account/model-watch': { data: [{ model: 'org/model + one', name: 'Watched model' }] },
    '/api/v1/agents': { data: [{ key_hash: hash, name: 'Research agent', policies: [{ policy: { caps: { per_day_usd: 10 }, alerts: { at_percent: [70, 95], denials_in_10min: 2, channels: [] } } }] }] },
    [`/api/v1/agents/${hash}/quiet-alert`]: { data: { hours: 6 } },
    '/api/v1/projects': { data: [{ name: 'research', budget_usd: '0' }, { name: 'uncapped', budget_usd: null }] },
    '/api/v1/account/low-balance': { low_balance_usd: 0, enabled: true },
    '/api/v1/schedules': { data: [{ id: 'daily', name: 'Daily reading', cadence: 'daily', time_utc: '08:00', max_cost_usd: '0.25', paused: false, prompt: 'Private scheduled content' }, { id: 'paused', paused: true }] },
  });
  for (const id of ['approval_reminders', 'status_incidents', 'price_notices', 'weekly_summary']) r.channels[id].inbox = true;
  const groups = await readWatching(r.request, {});
  assert.equal(find(groups, 'model_watch').items[0].href, '/models/model/?id=org%2Fmodel%20%2B%20one');
  assert.match(find(groups, 'quiet_agents').items[0].setting, /6 hours/);
  assert.equal(find(groups, 'quiet_agents').items[0].href, '/agents/?agent=' + hash);
  assert.match(find(groups, 'agent_alerts').items[0].setting, /70% and 95% of \$10 per day.*2 refusals.*Feed only/);
  assert.equal(find(groups, 'project_budgets').items.length, 1);
  assert.equal(find(groups, 'project_budgets').items[0].setting, '$0 per month · Notice at 80%');
  assert.equal(find(groups, 'project_budgets').items[0].href, '/dashboard/#insights');
  assert.equal(find(groups, 'low_balance').items[0].href, '/dashboard/#payments');
  assert.match(find(groups, 'low_balance').items[0].setting, /Below \$0/);
  assert.equal(find(groups, 'scheduled_results').items.length, 1);
  assert.match(find(groups, 'scheduled_results').items[0].setting, /Daily at 08:00 UTC.*\$0.25/);
  assert.equal(find(groups, 'scheduled_results').items[0].href, '/dashboard/#schedules');
  assert.ok(!JSON.stringify(groups).includes('Private scheduled content'));
  for (const id of ['approval_reminders', 'status_incidents', 'price_notices', 'weekly_summary']) assert.equal(find(groups, id).items[0].setting, 'On in Notifications');
});
test('default and inherited agent rules match cap and event sources without inventing cap alerts', () => {
  const rows = watchingAgentRules({ key_hash: hash, policies: [
    { inherited: false, policy: { caps: {}, alerts: {} } },
    { inherited: true, policy: { caps: { per_hour_usd: 2 }, alerts: {} } },
    { inherited: true, policy: { caps: {}, alerts: {} } },
  ] });
  assert.equal(rows.length, 2);
  assert.match(rows[0].setting, /5 refusals in 10 minutes.*Stop and approval requests.*Webhook, Telegram/);
  assert.doesNotMatch(rows[0].setting, /80%/);
  assert.match(rows[1].title, /inherited rulebook/);
  assert.match(rows[1].setting, /80% and 100% of \$2 per hour/);
  assert.doesNotMatch(rows[1].setting, /refusals|approval/);
});
test('unavailable and failing readers never turn into empty success; other groups remain visible', async () => {
  const r = reader({ '/api/v1/account/model-watch': Object.assign(new Error(), { status: 404 }), '/api/v1/projects': Object.assign(new Error(), { status: 503 }), '/api/v1/account/low-balance': { low_balance_usd: 10, enabled: false } });
  const groups = await readWatching(r.request, {});
  assert.equal(find(groups, 'model_watch').state, 'unavailable');
  assert.equal(find(groups, 'project_budgets').state, 'error');
  assert.match(find(groups, 'low_balance').note, /switched off/);
  assert.equal(find(groups, 'weekly_summary').state, 'ready');
});
test('authentication failure stops composition before reading other features; abort propagates', async () => {
  for (const status of [401, 403]) {
    const r = reader({ [NOTIFICATION_PATH]: Object.assign(new Error('Denied'), { status }) });
    await assert.rejects(readWatching(r.request, {}), /Denied/); assert.equal(r.calls.length, 1);
  }
  const r = reader({ '/api/v1/projects': Object.assign(new Error('Aborted'), { name: 'AbortError' }) });
  await assert.rejects(readWatching(r.request, {}), { name: 'AbortError' });
});
test('a failed quiet-agent read keeps other active settings and requests without rulebooks', async () => {
  const r = reader({ '/api/v1/agents': { data: [{ key_hash: hash, name: 'No rulebook' }, { key_hash: 'b'.repeat(64) }] },
    [`/api/v1/agents/${hash}/quiet-alert`]: { data: { hours: 1 } },
    [`/api/v1/agents/${'b'.repeat(64)}/quiet-alert`]: Object.assign(new Error(), { status: 503 }),
  });
  const groups = await readWatching(r.request, {}), quiet = find(groups, 'quiet_agents');
  assert.equal(quiet.state, 'error'); assert.equal(quiet.items[0].setting, 'No calls for 1 hour');
  assert.equal(quiet.items[0].title, 'No rulebook');
});
test('channel wording distinguishes link state and preserves the weekly opt-in source', () => {
  assert.equal(watchingChannels({ inbox: true, telegram: true }, false), 'Inbox on · Telegram on, link needed');
  assert.equal(watchingChannels({ inbox: false, telegram: true }, true), 'Inbox off · Telegram on');
});
test('account integration, docs, refresh, accessibility and narrow-screen tokens are present', () => {
  const dashboard = source('../components/Dashboard.jsx'), ui = source('../components/watching/AccountWatching.jsx');
  assert.ok(dashboard.indexOf('<AccountWatching ') > dashboard.indexOf('<AccountNotifications '));
  assert.match(ui, /aria-labelledby="watching-title"/); assert.match(ui, /role="status"/); assert.match(ui, /role="alert"/);
  assert.match(ui, /aria-label=\{'Change ' \+ row.title\}/); assert.match(ui, /controller.abort\(\)/);
  assert.match(ui, /state\?\.key === apiKey/); assert.match(ui, /anyroute:notifications-saved/);
  assert.match(source('../components/notifications/AccountNotifications.jsx'), /dispatchEvent\(new Event\('anyroute:notifications-saved'\)\)/);
  const css = source('../components/watching/Watching.module.css');
  assert.match(css, /minmax\(0,1fr\)/); assert.match(css, /max-width:600px/); assert.match(css, /focus-visible/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i);
  assert.match(source('../app/docs/page.jsx'), /<WatchingDocs \/>/);
  assert.match(source('../components/watching/WatchingDocs.jsx'), /id="watching"/);
  assert.match(source('../components/DocsFeatureIndex.jsx'), /\["watching", "What you’re watching"\]/);
  assert.ok(TASKS.some(task => task.id === 'watching' && task.href === '/dashboard/#notifications'));
});
