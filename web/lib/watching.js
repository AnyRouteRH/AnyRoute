// J180: compose existing GET readers; their account, team and feature guards stay authoritative.
import { readNotifications } from './notifications.js';
import { quietAlertPath, quietSetting } from './quiet-agent-alerts.js';

const notifications = '/dashboard/#notifications';
const definitions = [
  ['model_watch', 'Model watch', '/models/', 'No models watched.', 'Choose a model to watch'],
  ['quiet_agents', 'Quiet-agent alerts', '/agents/', 'No quiet-agent alerts set.', 'Set a quiet-agent alert'],
  ['project_budgets', 'Project budgets', '/dashboard/#insights', 'No project budgets set.', 'Set a project budget'],
  ['low_balance', 'Low balance', '/dashboard/#payments', 'No low-balance threshold set.', 'Set a low-balance threshold'],
  ['agent_alerts', 'Agent alerts', '/agents/', 'No agent alert rules set.', 'Set agent alert rules'],
  ['approval_reminders', 'Approval reminders', notifications, '', 'Change approval reminders'],
  ['status_incidents', 'Service incident alerts', notifications, '', 'Change service incident alerts'],
  ['price_notices', 'Model rate changes', notifications, '', 'Change model rate notices'],
  ['weekly_summary', 'Weekly summary', notifications, '', 'Change weekly summary'],
  ['scheduled_results', 'Scheduled prompts', '/dashboard/#schedules', 'No active scheduled prompts.', 'Schedule a prompt'],
];
const dollars = value => '$' + Number(value).toLocaleString('en-US', { maximumFractionDigits: 12 });
const agentHref = hash => '/agents/?agent=' + encodeURIComponent(hash);
export function watchingChannels(channels, linked) {
  return `Inbox ${channels.inbox ? 'on' : 'off'} · Telegram ${channels.telegram ? (linked ? 'on' : 'on, link needed') : 'off'}`;
}
const failure = error => ({ items: [], state: error.status === 404 ? 'unavailable' : 'error' });
async function readGroup(read) {
  try { return { items: await read(), state: 'ready' }; }
  catch (error) { if (error.name === 'AbortError') throw error; return failure(error); }
}
const item = (id, title, setting, href) => ({ id, title, setting, href });

// Cap percentages apply to every alert-bearing policy; denial/Stop/approval alerts use the own rule first.
export function watchingAgentRules(agent) {
  const rules = (agent.policies ?? []).filter(row => row.policy?.alerts !== undefined);
  const eventRule = rules.find(row => !row.inherited) ?? rules[0];
  return rules.map((row, index) => {
    const alerts = row.policy.alerts, parts = [];
    const percentages = [...new Set(alerts.at_percent ?? [80, 100])];
    const periods = ['hour', 'day', 'week'].filter(period => row.policy.caps?.['per_' + period + '_usd'] !== undefined);
    if (periods.length && percentages.length) parts.push(`${percentages.join('% and ')}% of ${periods.map(period => `${dollars(row.policy.caps['per_' + period + '_usd'])} per ${period}`).join(', ')}`);
    if (row === eventRule) parts.push(`${alerts.denials_in_10min ?? 5} refusals in 10 minutes`, 'Stop and approval requests');
    if (!parts.length) return null;
    const channels = alerts.channels ?? ['webhook', 'telegram'];
    parts.push(channels.length ? channels.map(channel => ({ webhook: 'Webhook', telegram: 'Telegram', email: 'Email has no destination' })[channel]).join(', ') : 'Feed only');
    return item(`${agent.key_hash}:${index}`, `${agent.name || 'Unnamed agent'}${row.inherited ? ' · inherited rulebook' : ''}`, parts.join(' · '), agentHref(agent.key_hash));
  }).filter(Boolean);
}

export async function readWatching(request, options) {
  // The same management-owner check as Notifications runs first. No partial account view on auth failure.
  const prefs = await readNotifications(request, options);
  const get = path => request(path, options);
  const groups = definitions.map(([id, title, href, empty, action]) => ({ id, title, href, empty, action, items: [], state: 'ready', channels: watchingChannels(prefs.channels[id], prefs.telegram_linked) }));
  const group = id => groups.find(value => value.id === id);
  const assign = async (id, read) => Object.assign(group(id), await readGroup(read));
  await Promise.all([
    assign('model_watch', async () => (await get('/api/v1/account/model-watch')).data.map(row => item(row.model, row.name, 'Watching availability', '/models/model/?id=' + encodeURIComponent(row.model)))),
    assign('project_budgets', async () => (await get('/api/v1/projects')).data.filter(row => row.budget_usd !== null).map(row => item(row.name, row.name, `${dollars(row.budget_usd)} per month · Notice at 80%`, '/dashboard/#insights'))),
    assign('low_balance', async () => {
      const value = await get('/api/v1/account/low-balance');
      if (!value.enabled) group('low_balance').note = 'Balance alert checks are switched off for this service.';
      return value.low_balance_usd === null ? [] : [item('threshold', 'Balance threshold', `Below ${dollars(value.low_balance_usd)}`, '/dashboard/#payments')];
    }),
    assign('scheduled_results', async () => (await get('/api/v1/schedules')).data.filter(row => !row.paused).map(row => item(row.id, row.name, `${({ hourly: 'Every hour', daily: 'Daily', monday: 'Every Monday' })[row.cadence]}${row.time_utc ? ' at ' + row.time_utc + ' UTC' : ''} · Maximum ${dollars(row.max_cost_usd)} per run`, '/dashboard/#schedules'))),
    (async () => {
      let agents;
      try { agents = (await get('/api/v1/agents')).data; }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        for (const id of ['quiet_agents', 'agent_alerts']) Object.assign(group(id), failure(error));
        return;
      }
      group('agent_alerts').items = agents.flatMap(watchingAgentRules);
      // Bound concurrent per-agent reads, including keys without a rulebook (quiet alerts support them).
      for (let start = 0; start < agents.length; start += 4) {
        const results = await Promise.all(agents.slice(start, start + 4).map(agent => readGroup(async () => {
          const hours = quietSetting(await get(quietAlertPath(agent.key_hash)));
          return hours === null ? [] : [item(agent.key_hash, agent.name || 'Unnamed agent', `No calls for ${hours} ${hours === 1 ? 'hour' : 'hours'}`, agentHref(agent.key_hash))];
        })));
        for (const result of results) {
          group('quiet_agents').items.push(...result.items);
          if (result.state !== 'ready') group('quiet_agents').state = result.state;
        }
      }
    })(),
  ]);
  for (const [id, title] of [['approval_reminders', 'Approval reminders'], ['status_incidents', 'Public service incidents'], ['price_notices', 'Models used in the last 30 days'], ['weekly_summary', 'Weekly summary']]) {
    const channels = prefs.channels[id];
    group(id).items = [item(id, title, channels.inbox || channels.telegram ? 'On in Notifications' : 'Off in Notifications', notifications)];
  }
  return groups;
}
