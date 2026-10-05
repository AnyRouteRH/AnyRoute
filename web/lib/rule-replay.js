// Replay your rules: run the rules in the spending limits editor against a key's recorded calls and Agent Guard checks
// from the last 7 days, with POST /api/v1/agents/:key_hash/replay. The router reads the record and evaluates; this file
// only sends the draft and turns the answer into words. Nothing is saved, charged or changed.
import { breakerReasonText } from './agent-breakers.js';
import { formatUsd, utcTime } from './agents.js';

export const REPLAY_DAYS = 7;
export const REPLAY_WORDS = {
  button: 'Replay last 7 days', busy: 'Replaying…', title: 'Replay',
  help: 'Runs the rules as they are in this editor against this key’s recorded calls from the last 7 days. Nothing is saved, charged or changed.',
  done: 'Replayed against your last 7 days. Nothing was saved.',
  stale: 'The rules changed after this replay. Replay again to see them.',
  empty: 'No calls or actions were recorded in the last 7 days, so there was nothing to replay.',
  setup: 'Replay it first', setupHelp: 'See what this setup would have done with the last 7 days before you save it.',
  examples: 'Example calls', reasons: 'Why', notes: 'About this replay',
  fix: 'Fix the fields above before replaying:',
};
export const REPLAY_OUTCOMES = [
  { key: 'allowed', decision: 'allow', label: 'Allowed' },
  { key: 'asked', decision: 'approval_required', label: 'Ask me first' },
  { key: 'denied', decision: 'deny', label: 'Refused' },
];
const LABEL = Object.fromEntries(REPLAY_OUTCOMES.map(o => [o.decision, o.label]));
const REASONS = {
  killed: 'Stopped earlier in this replay, so it is refused.',
  model_not_allowed: 'The model is outside the rules.', lane_not_allowed: 'The lane is outside the rules.',
  over_per_request: 'Over the cap per request.', over_per_hour: 'Over the cap per hour.', over_per_day: 'Over the cap per day.', over_per_week: 'Over the cap per week.',
  max_tokens: 'Over the output token cap.', tool_not_allowed: 'A tool is outside the rules.',
  tool_over_max_price: 'Over the price cap for a paid tool.', tool_over_daily_budget: 'Over the daily budget for paid tools.',
  outside_window: 'Outside the allowed UTC times.', approval_required: 'Above the ask me first amount.',
  approval_calls_per_hour: 'Past the calls per hour before asking first.',
  actions_not_configured: 'No action rules, so every action is refused.', action_not_allowed: 'The action is outside the rules.',
  target_not_allowed: 'The target is outside the rules.', over_action_per_request: 'Over the cap per action.',
  over_action_per_day: 'Over the action cap per day.', over_action_per_hour: 'Over the actions per hour.',
  approval_action_amount: 'The action is above its ask me first amount.',
};
const count = (n, one, many = one + 's') => `${Number(n || 0).toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A reason (or its code) in the editor's words. Circuit breakers use their field names. */
export function replayReasonText(reason) {
  const code = typeof reason === 'string' ? reason : reason?.code;
  if (REASONS[code]) return REASONS[code];
  const breaker = breakerReasonText(code);
  if (breaker) return `${breaker} breaker reached; the key stops.`;
  return (typeof reason === 'object' && reason?.message) || code || 'No reason given.';
}

/** POST the draft; `request` is api() with the signed-in key. Refuses a reply it cannot read rather than showing half of it. */
export async function runReplay(request, keyHash, policy, { days = REPLAY_DAYS, signal } = {}) {
  if (!keyHash) throw new Error('Choose a key to replay.');
  const json = await request('/api/v1/agents/' + encodeURIComponent(keyHash) + '/replay', { method: 'POST', body: { policy, days }, signal });
  const data = json?.data;
  if (!data || !['evaluated', 'allowed', 'denied', 'asked'].every(k => Number.isInteger(data[k])) || !Array.isArray(data.examples) || !Array.isArray(data.notes)) throw new Error('The replay could not be read.');
  return data;
}

/** Bar segments for allowed, ask me first and refused. Percents are whole numbers that add up to 100 (largest remainder). */
export function replayBar(data) {
  const total = REPLAY_OUTCOMES.reduce((sum, o) => sum + (data?.[o.key] || 0), 0);
  const raw = REPLAY_OUTCOMES.map(o => ({ ...o, count: data?.[o.key] || 0, exact: total ? (data?.[o.key] || 0) * 100 / total : 0 }));
  const segments = raw.map(s => ({ key: s.key, label: s.label, count: s.count, percent: Math.floor(s.exact) }));
  let left = total ? 100 - segments.reduce((sum, s) => sum + s.percent, 0) : 0;
  for (const i of raw.map((s, i) => i).sort((a, b) => (raw[b].exact - Math.floor(raw[b].exact)) - (raw[a].exact - Math.floor(raw[a].exact)) || a - b)) {
    if (left <= 0) break;
    if (raw[i].count) { segments[i].percent++; left--; }
  }
  return segments;
}

/** One sentence for the counts. */
export function replayHeadline(data) {
  if (!data?.evaluated) return REPLAY_WORDS.empty;
  return `Of ${count(data.evaluated, 'recorded call or action', 'recorded calls and actions')}, ${data.allowed.toLocaleString('en-US')} would have been allowed, ${data.asked.toLocaleString('en-US')} sent to ask me first and ${data.denied.toLocaleString('en-US')} refused.`;
}

/** When the draft would have stopped the key, and why. */
export function replayStopText(data) {
  if (!data?.stopped_at) return '';
  const first = String(data.stopped_reason || '').split(',')[0];
  return `These rules would have stopped this key at ${utcTime(data.stopped_at)}: ${replayReasonText(first)} Every later call is refused until you press Resume.`;
}

/** What actually happened, beside the replay. */
export function replayCompareText(data) {
  if (!data?.evaluated) return '';
  const recorded = data.evaluated - (data.actual?.not_recorded || 0);
  const parts = [recorded ? (data.changed ? `${count(data.changed, 'call or action', 'calls and actions')} would have gone differently from what happened.` : 'Every call and action with a recorded decision would have gone the same way.') : ''];
  if (data.actual?.not_recorded) parts.push(`${count(data.actual.not_recorded, 'call')} ran with no rulebook decision recorded.`);
  return parts.filter(Boolean).join(' ');
}

/** Reasons by how often they came up. */
export function replayReasons(data) {
  return Object.entries(data?.by_reason || {}).map(([code, n]) => ({ code, count: n, text: replayReasonText(code) })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** What happened at the time, in words. A call that ran after an approval is recorded as asked first. */
export function replayActualText(example) {
  const a = example?.actual;
  if (a === 'allow') return 'Allowed at the time';
  if (a === 'deny') return 'Refused at the time';
  if (a === 'approval_required') return example.kind === 'call' ? 'Ran after an approval' : 'Sent to ask me first at the time';
  return 'No rulebook decision recorded';
}

/** Example rows for display: time, what, lane, cost, the replay's decision and reason, and what happened at the time. */
export function replayExamples(data) {
  return (data?.examples || []).map((e, i) => ({
    id: `${e.time}-${i}`, time: utcTime(e.time), what: e.kind === 'action' ? `Action ${e.action || 'not recorded'}` : e.model || 'Model not recorded',
    lane: e.kind === 'action' ? '' : e.lane || 'Lane not recorded', cost: formatUsd(e.cost_usd), decision: LABEL[e.decision] || e.decision,
    tone: REPLAY_OUTCOMES.find(o => o.decision === e.decision)?.key || '', reason: e.reason ? replayReasonText(e.reason) : '', actual: replayActualText(e),
    changed: e.actual != null && e.actual !== e.decision,
  }));
}

/** True when the editor's rules are no longer the ones replayed. */
export const replayStale = (replayed, current) => !!replayed && JSON.stringify(replayed) !== JSON.stringify(current);
