// J176: one ordering and the existing Stop and runway wording for both views.
import { stoppedLabel } from './stop-until.js';
import { agentRunwayLines } from './agent-runway.js';
const dollars = value => '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
export function agentStatusParts(data, policies = []) {
  const activeStops = policies.filter(row => row.killed && (!row.stopped_until || Date.parse(row.stopped_until) > Date.parse(data.as_of)));
  const stopSource = activeStops.find(row => data.stopped_until ? row.stopped_until === data.stopped_until : !row.stopped_until);
  const hoursSource = data.work_hours.find(row => !row.inside) ?? data.work_hours[0];
  const guardSource = activeStops.find(row => row.killed_reason?.split(',').some(reason => /^(?:actions_|action_|target_|over_action_)/.test(reason)));
  const source = kind => (kind === 'stop' && data.stopped ? stopSource?.key_hash : kind === 'hours' ? hoursSource?.key_hash : kind === 'guard' ? guardSource?.key_hash : null) ?? data.key_hash;
  const part = (kind, text, target) => ({ kind, text, href: '/agents/?agent=' + encodeURIComponent(source(kind)) + '#' + target });
  const parts = [part('stop', data.stopped ? stoppedLabel(data.stopped_until) : 'Working', 'agent-status-stop')];
  if (data.work_hours.length) {
    const outside = data.work_hours.some(hours => !hours.inside);
    parts.push(part('hours', outside ? 'outside work hours' : 'inside work hours', 'agent-status-hours'));
  }
  if (data.pending_approvals > 0) parts.push(part('approvals', `${data.pending_approvals} ${data.pending_approvals === 1 ? 'approval' : 'approvals'} waiting`, 'approvals'));
  const runway = data.runway;
  // Today is calendar spending; rulebook daily caps are rolling. Keep that distinction explicit.
  const cap = runway.limits.find(limit => limit.source === 'rulebook' && limit.period === 'day');
  const budget = runway.limits.find(limit => limit.source === 'key_budget' && limit.period === 'day');
  const today = dollars(runway.today_charged_usd) + ' today';
  const spending = cap ? `${today} · ${dollars(cap.charged_usd)} of ${dollars(cap.cap_usd)} rolling day cap`
    : budget ? `${today} · ${dollars(budget.charged_usd)} of ${dollars(budget.cap_usd)} daily key budget (UTC)` : today;
  const forecast = runway.limits.find(limit => limit.period === 'day' && limit.estimated_days_left !== null);
  const title = forecast ? agentRunwayLines({ ...runway, limits: [forecast] }).at(-1) : 'No spending pace yet to estimate how long it lasts.';
  const pace = !forecast ? '' : forecast.remaining_usd === 0 ? ' · cap reached' : forecast.resets_at && forecast.reaches_before_reset === false ? ' · estimate: lasts until reset' : ` · estimate: ${Math.max(1, Math.round(forecast.estimated_days_left * 24))} hours left at this pace`;
  if (runway.today_charged_usd > 0 || runway.limits.length) parts.push({ ...part('runway', spending + pace, 'agent-status-runway'), title });
  if (data.quiet) parts.push(part('quiet', `quiet for ${data.quiet.hours} ${data.quiet.hours === 1 ? 'hour' : 'hours'}`, 'agent-status-quiet-' + data.key_hash));
  if (data.guard_paused) parts.push(part('guard', 'Agent Guard stopped this agent', 'agent-status-guard'));
  for (const window of data.approval_windows ?? []) parts.push(part('approval-hour-' + window.id, window.text, 'approval-hours')); // K194
  return parts;
}
