// B124: pure display text. No enforcement, storage or request readers.
import type { AgentPolicy } from './policy.ts';

// ==== shared formatter (begin) ====
export const exactUsd = (amount: number): string => {
  const [mantissa, exp] = String(amount).split('e');
  if (exp === undefined) return '$' + mantissa;
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction, point = whole.length + Number(exp);
  return '$' + (point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point));
};
const modelNames: Record<string, string> = {
  'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',
  'qwen/qwen-2.5-72b-instruct': 'Qwen 2.5 72B',
};
const joined = (values: string[]) => values.join(', ');
const usdCaps = (caps: Record<string, number | undefined>, units: Record<string, string>) => Object.entries(units).filter(([key]) => caps[key] !== undefined).map(([key, unit]) => `${exactUsd(caps[key]!)} ${unit}`);
export function rulebookParts(policy: AgentPolicy | null | undefined): { part: string; text: string }[] {
  if (!policy) return [{ part: 'missing', text: 'No rulebook set' }];
  const lines: { part: string; text: string }[] = [];
  const add = (part: string, text: string) => lines.push({ part, text });
  const names = (part: string, rules: { allow?: string[]; deny?: string[] } | undefined, noun: string, denied: string, display = (value: string) => value) => {
    if (rules?.allow !== undefined) add(part, rules.allow.length ? `Only these ${noun}: ${joined(rules.allow.map(display))}` : `No ${noun} allowed`);
    if (rules?.deny?.length) add(part, `${denied} ${joined(rules.deny.map(display))}`);
  };
  // B124: only rules that restrict something are listed; the format version and defaults are left out.
  const caps = usdCaps(policy.caps, { per_request_usd: 'a request', per_hour_usd: 'in any hour', per_day_usd: 'in any 24 hours', per_week_usd: 'in any 7 days' });
  add('caps', caps.length ? `${policy.autonomy ? 'Base caps: up to' : 'Up to'} ${caps.join(' and ')}` : 'No spending caps for model or paid tool calls');
  if (policy.caps.max_output_tokens !== undefined) add('tokens', `Replies up to ${policy.caps.max_output_tokens} tokens`);
  names('models', policy.models, 'models', 'Never uses these models:', value => Object.hasOwn(modelNames, value) ? modelNames[value] : value);
  if (policy.lanes !== undefined) add('lanes', policy.lanes.length ? `Only these lanes: ${joined(policy.lanes.map(l => ({ public: 'standard', attested: 'proven hardware', unlinkable: 'unlinkable' })[l]))}` : 'No lanes allowed');
  if (policy.route_default && policy.route_default !== 'standard') add('route', `Requests that name no lane: ${{ proven_first: 'Proven hardware first', proven_only: 'Proven hardware only' }[policy.route_default]}`);
  names('tools', policy.tools, 'declared or paid tools', 'Never uses these tools:');
  if (policy.tools?.max_price_per_call !== undefined) add('tools', `Paid tools up to ${exactUsd(policy.tools.max_price_per_call)} a call`);
  if (policy.tools?.daily_budget !== undefined) add('tools', `Paid tools up to ${exactUsd(policy.tools.daily_budget)} in any 24 hours`);
  if (policy.tools?.pass_to_models !== undefined) add('tools', policy.tools.pass_to_models ? 'May pass purchased tool results to models' : 'Does not pass purchased tool results to models');
  if (policy.approval) {
    add('ask', `Asks you above ${exactUsd(policy.approval.above_usd)} for a model or paid tool call`);
    if (policy.approval.above_calls_per_hour !== undefined) add('calls', `Asks you after ${policy.approval.above_calls_per_hour} model calls in any hour`);
  }
  if (policy.windows === undefined) { /* no hours rule */ } else if (!policy.windows.length) add('hours', 'No allowed hours');
  else for (const window of policy.windows) {
    const days = [...new Set(window.days)].sort((a, b) => a - b);
    const label = joined(days.map(day => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]));
    const schedule = days.join() === '1,2,3,4,5' ? 'Weekdays' : days.length === 7 ? 'Every day' : label;
    add('hours', !days.length || window.start === window.end ? 'This window allows no requests' : `${schedule} ${window.start}–${window.end} UTC (start included, end excluded${window.start > window.end ? '; ends the following day' : ''})`);
  }
  if (policy.actions) {
    const a = policy.actions;
    names('actions', a, 'actions', 'Never sends');
    if (a.targets) names('actions', a.targets, 'action targets', 'Never uses these action targets:');
    const payments = a.allow?.length === 1 && a.allow[0] === 'payment.send';
    if (a.per_action_usd !== undefined) add('actions', `${payments ? 'Payments' : 'Actions'} up to ${exactUsd(a.per_action_usd)} each${a.approval_above_usd === undefined ? '' : `; asks you above ${exactUsd(a.approval_above_usd)}`}`);
    else if (a.approval_above_usd !== undefined) add('actions', `Asks you above ${exactUsd(a.approval_above_usd)} an action`);
    if (a.per_day_usd !== undefined) add('actions', `Actions up to ${exactUsd(a.per_day_usd)} in any 24 hours`);
    if (a.max_per_hour !== undefined) add('actions', `Up to ${a.max_per_hour} actions in any hour`);
  }
  const breakers: Record<string, string> = { max_spend_usd_per_minute: 'spent in any minute', max_requests_per_minute: 'requests in any minute', max_denials_per_10min: 'denials in any 10 minutes', max_distinct_models_per_hour: 'different models in any hour' };
  for (const [key, value] of Object.entries(policy.breakers ?? {})) add('breakers', `Stop at ${key === 'max_spend_usd_per_minute' ? exactUsd(value) : value} ${breakers[key]}; resume to run again`);
  if (policy.alerts) {
    const a = policy.alerts, at = a.at_percent ?? [80, 100];
    add('alerts', at.length ? `Alerts at ${at.join('%, ')}% of hourly, daily and weekly caps` : 'No cap percentage alerts');
    add('alerts', `Alerts after ${a.denials_in_10min ?? 5} denials in ten minutes`);
    if (a.channels !== undefined) add('alerts', a.channels.length ? `Alert channels: ${joined(a.channels.map(c => ({ webhook: 'webhook', email: 'email (not switched on yet)', telegram: 'Telegram' })[c]))}` : 'Alerts in the agent feed only');
  }
  if (policy.agreements?.max_escrow_usd !== undefined) add('agreements', `Agreement escrow up to ${exactUsd(policy.agreements.max_escrow_usd)} each`);
  if (policy.agreements?.counterparties_allow !== undefined) add('agreements', policy.agreements.counterparties_allow.length ? `Agreements only with: ${joined(policy.agreements.counterparties_allow)}` : 'No agreement counterparties allowed');
  if (policy.autonomy) {
    policy.autonomy.rungs.forEach((rung, index) => add('autonomy', `Step ${index + 1}: spending caps become ${rung.caps_multiplier} times the base caps after ${rung.after_days} days and ${rung.clean_requests} clean requests at the previous step`));
    add('autonomy', policy.autonomy.demote_on.length ? `Reset to base caps after: ${joined(policy.autonomy.demote_on.map(d => ({ deny: 'a refusal', kill: 'Stop', breaker: 'a circuit breaker trip' })[d]))}` : 'No automatic reset to base caps');
  }
  add('breach', policy.on_breach === 'kill' ? 'If a rule is broken: Stop until you resume' : 'If a rule is broken: Refuse that request');
  return lines;
}
export const rulebookWords = (policy: AgentPolicy | null | undefined): string[] => rulebookParts(policy).map(line => line.text);
export function rulebookApprovalLine(policy: AgentPolicy | null | undefined, action = false): string {
  if (!policy) return 'Rulebook: unavailable';
  if (action && !policy.actions) return 'Rulebook: no action rules; checked actions are refused';
  const rules = action ? policy.actions : undefined;
  const cap = action ? rules?.per_action_usd : policy.caps.per_request_usd;
  const ask = action ? rules?.approval_above_usd : policy.approval?.above_usd;
  const payment = rules?.allow?.length === 1 && rules.allow[0] === 'payment.send';
  const scope = action ? payment ? 'a payment' : 'an action' : 'a model call';
  return 'Rulebook: ' + [cap === undefined ? `no amount cap for ${scope}` : `${!action && policy.autonomy ? 'base cap up to' : 'up to'} ${exactUsd(cap)} ${scope}${!action && policy.autonomy ? ' (autonomy can increase it)' : ''}`, ask === undefined ? 'no amount-based ask-first rule' : `asks above ${exactUsd(ask)}`].join('; ');
}
// ==== shared formatter (end) ====
