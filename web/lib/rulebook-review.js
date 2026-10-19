// K189: review uses the same sentences as rulebook history, with compact cap changes.
import { exactUsd, rulebookParts } from './rulebook-words.js';
import { APPROVER_MODES, approversBody } from './agent-approvers.js';
import { replayStale, REPLAY_WORDS } from './rule-replay.js';

const CAPS = [
  ['per_request_usd', 'Cap per request'],
  ['per_hour_usd', 'Hourly cap'],
  ['per_day_usd', 'Daily cap'],
  ['per_week_usd', 'Weekly cap'],
  ['max_output_tokens', 'Maximum output tokens'],
];
const GROUPS = [
  ['models', 'Models', ['models']], ['lanes', 'Lanes', ['lanes']],
  ['route', 'Default route', ['route']], ['tools', 'Tools', ['tools']],
  ['ask', 'Ask me first amount', ['ask']], ['calls', 'Ask me first after calls per hour', ['calls']],
  ['work_hours', 'work hours', ['hours']], ['windows', 'UTC windows', ['hours']],
  ['actions', 'Actions (Agent Guard)', ['actions']], ['breakers', 'Circuit breakers', ['breakers']],
  ['alerts', 'Alerts', ['alerts']], ['agreements', 'Agreements', ['agreements']],
  ['autonomy', 'Progressive autonomy', ['autonomy']], ['on_breach', 'If a rule is broken', ['breach']],
];

// Object key order never makes an edit; ordered rules (such as autonomy steps) retain their order.
export function reviewSignature(value) {
  return JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function sentences(policy, key, parts) {
  if (!policy) return [];
  // Work hours and UTC windows share a formatter part, but are separate rules in the editor.
  const scoped = key === 'work_hours' ? { ...policy, windows: undefined }
    : key === 'windows' ? { ...policy, work_hours: undefined } : policy;
  const lines = rulebookParts(scoped).filter(line => parts.includes(line.part)).map(line => line.text);
  // An empty action rule still permits checked actions, unlike an absent action rule.
  if (key === 'actions' && policy.actions && !lines.length) lines.push('Action rules set with no action limits');
  return lines;
}

export function rulebookReviewLines(before, after) {
  if (!after) return [];
  const lines = before ? [] : ['Adds a rulebook'];
  for (const [key, label] of CAPS) {
    const old = before?.caps?.[key], next = after.caps?.[key];
    if (old === next) continue;
    const display = value => value === undefined ? (key === 'max_output_tokens' ? 'No limit' : 'No cap')
      : key === 'max_output_tokens' ? `${value} tokens` : exactUsd(value);
    lines.push(`${label}: ${display(old)} → ${display(next)}`);
  }
  for (const [key, label, parts] of GROUPS) {
    const old = sentences(before, key, parts), next = sentences(after, key, parts);
    const removed = old.filter(line => !next.includes(line)), added = next.filter(line => !old.includes(line));
    if (removed.length === 1 && added.length === 1) lines.push(`${label}: ${removed[0]} → ${added[0]}`);
    else {
      for (const line of removed) lines.push(`Removes ${label}: ${line}`);
      for (const line of added) lines.push(`Adds ${label}: ${line}`);
    }
  }
  return lines;
}

export function approverReviewLines(before, after, members = []) {
  const old = approversBody(before.mode, before.member_ids), next = approversBody(after.mode, after.member_ids);
  const lines = [];
  const label = mode => APPROVER_MODES.find(([value]) => value === mode)?.[1];
  const name = id => members.find(member => member.id === id)?.name || 'A previously selected teammate';
  if (old.mode !== next.mode) lines.push(`Who can approve: ${label(old.mode)} → ${label(next.mode)}`);
  for (const id of old.member_ids.filter(id => !next.member_ids.includes(id))) lines.push(`Removes approver: ${name(id)}`);
  for (const id of next.member_ids.filter(id => !old.member_ids.includes(id))) lines.push(`Adds approver: ${name(id)}`);
  return lines;
}

export function reviewState(lines, errors = [], busy = false) {
  const changed = lines.length > 0;
  return { changed, disabled: busy || !changed, label: changed ? 'Review changes' : 'Save',
    notice: changed ? '' : 'Nothing to save', canReview: changed && !busy && errors.length === 0 };
}

export const currentReviewReplay = (replay, policy) => !!replay?.data && !replayStale(replay.policy, policy);
export function reviewReplaySummary(data) {
  if (!data) return 'Replay is unavailable. You can still review and save these changes.';
  if (!data.evaluated) return REPLAY_WORDS.empty;
  const refused = data.denied.toLocaleString('en-US'), asked = data.asked.toLocaleString('en-US');
  return `Would have refused ${refused} recorded calls and actions in the last 7 days and asked first for ${asked}.${data.truncated ? ' Only part of the recorded activity was replayed.' : ''}`;
}
