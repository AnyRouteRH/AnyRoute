import { breakerForm, buildBreakers, breakerReasonText } from "./agent-breakers.js";
import { autonomyForm, autonomyPolicy } from "./agent-autonomy.js";
import { alertSettingsErrors } from './agent-alerts.js';
// Rulebook forms and REST view models. No credentials or prompt text are stored here.
export const LANES = ['public', 'attested', 'unlinkable'];
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const CAP_FIELDS = ['per_request_usd', 'per_hour_usd', 'per_day_usd', 'per_week_usd', 'max_output_tokens'];
export const LIMITS = { entries: 64, string: 160, usd: 1_000_000, tokens: 10_000_000 };
export const FEATURE_OFF = "Agent rulebooks aren't switched on yet.";

export const reasonText = reason => reason?.message || ({
  killed: 'This agent is killed.', model_not_allowed: 'The model is outside the rulebook.',
  lane_not_allowed: 'The lane is outside the rulebook.', over_per_request: 'The request exceeds its cost cap.',
  over_per_hour: 'The rolling hour cap would be exceeded.', over_per_day: 'The rolling day cap would be exceeded.',
  over_per_week: 'The rolling week cap would be exceeded.', max_tokens: 'The output token cap would be exceeded.',
  tool_not_allowed: 'A tool is outside the rulebook.', outside_window: 'The current UTC time is outside the allowed windows.',
  approval_required: 'This request needs approval.',
}[reason?.code] || breakerReasonText(reason?.code) || reason?.code || 'No reason supplied.');
export const decisionText = value => ({ allow: 'Allow', deny: 'Deny', approval_required: 'Approval required', policy_set: 'Rulebook saved', killed: 'Killed', resumed: 'Resumed' }[value] || value || 'Decision not recorded');
export const errorState = error => error?.status === 404 && error?.type === 'not_found'
  ? { off: true, message: FEATURE_OFF } : { off: false, message: error?.message || 'The request could not be completed.' };
export const formatUsd = value => value != null && Number.isFinite(Number(value)) ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 12 }) : 'Not recorded';
export const picoUsd = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value) / 1e12;
export const utcTime = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not recorded';

export function capBars(agent) {
  return ['hour', 'day', 'week'].map(period => {
    // The API reports spend in USD (src/api/agents.ts picoToUsd); only intents carry pico.
    const raw = agent?.spent?.[period];
    const spent = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
    const cap = agent?.caps?.[`per_${period}_usd`] ?? null;
    return { period, spent, cap, percent: cap > 0 && spent != null ? Math.min(100, Math.max(0, spent / cap * 100)) : 0,
      label: `${spent == null ? 'Spend not recorded' : formatUsd(spent)} / ${cap == null ? 'No cap' : formatUsd(cap)}` };
  });
}

export function intentSummary(intent) {
  if (Array.isArray(intent?.intents)) return intent.intents.map(intentSummary).join(' / ');
  if (intent?.kind === 'mcp_tool') return `Tool: ${intent.name || 'Not recorded'}`;
  if (intent?.kind !== 'inference') return 'No intent recorded';
  return `Model: ${intent.model || 'Not recorded'} · Lane: ${intent.lane || 'Not recorded'} · Estimated cost: ${formatUsd(picoUsd(intent.est_cost_pico))} · Tools: ${(intent.tools || []).join(', ') || 'None'}`;
}

export function pendingApprovals(json, now = Date.now()) {
  if (!Array.isArray(json?.data)) throw new Error('The approvals response could not be read.');
  return json.data.filter(row => row.status === 'pending' && Date.parse(row.expires_at) > now)
    .sort((a,b) => Date.parse(a.requested_at) - Date.parse(b.requested_at));
}
export async function decideAgentApproval(request, id, action) {
  if (!['approve','deny'].includes(action)) throw new Error('Choose Approve or Deny.');
  return request('/api/v1/agents/approvals/'+encodeURIComponent(id)+'/'+action,{ method:'POST' });
}

export function eventsPage(json) {
  const data = json?.data;
  const rows = Array.isArray(data) ? data : data?.events || [];
  return { events: [...rows].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || (BigInt(b.id || 0) > BigInt(a.id || 0) ? 1 : BigInt(b.id || 0) < BigInt(a.id || 0) ? -1 : 0)),
    next: json?.next_cursor ?? json?.next ?? data?.next_cursor ?? data?.next ?? null };
}

const entries = value => String(value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
export function policyForm(policy) {
  const p = policy || {};
  return { ...autonomyForm(p), breakers: breakerForm(p), modelAllow: (p.models?.allow || []).join('\n'), modelDeny: (p.models?.deny || []).join('\n'),
    toolAllow: (p.tools?.allow || []).join('\n'), toolDeny: (p.tools?.deny || []).join('\n'),
    restrictLanes: p.lanes !== undefined, lanes: p.lanes || [...LANES],
    caps: Object.fromEntries(CAP_FIELDS.map(k => [k, p.caps?.[k] == null ? '' : String(p.caps[k])])),
    restrictWindows: p.windows !== undefined, windows: (p.windows || []).map(w => ({ ...w, days: [...w.days] })),
    ...(p.alerts === undefined ? {} : {alerts:structuredClone(p.alerts)}), ...(p.agreements === undefined ? {} : {agreements:structuredClone(p.agreements)}), approval: p.approval?.above_usd == null ? '' : String(p.approval.above_usd), onBreach: p.on_breach || 'deny' };
}

export function buildPolicy(form) {
  const errors = [];
  const list = (value, label) => {
    const items = entries(value);
    if (items.length > LIMITS.entries || items.some(s => s.length > LIMITS.string)) errors.push(`${label}: at most 64 entries, each up to 160 characters.`);
    return items;
  };
  const money = (value, label) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > LIMITS.usd) errors.push(`${label}: enter USD greater than 0 and up to 1,000,000.`);
    return n;
  };
  const policy = { ...autonomyPolicy(form), version: 1, models: {}, caps: {}, on_breach: form.onBreach };
  for (const [input, group, field, label] of [['modelAllow','models','allow','Allowed models'], ['modelDeny','models','deny','Denied models'], ['toolAllow','tools','allow','Allowed tools'], ['toolDeny','tools','deny','Denied tools']]) {
    const items = list(form[input], label);
    if (items.length) { policy[group] ||= {}; policy[group][field] = items; }
  }
  if (form.restrictLanes) {
    policy.lanes = [...form.lanes];
    if (policy.lanes.length > 64 || policy.lanes.some(lane => !LANES.includes(lane))) errors.push('Choose public, attested or unlinkable lanes.');
  }
  for (const k of CAP_FIELDS) {
    const value = form.caps[k];
    if (String(value).trim() === '') continue;
    if (k === 'max_output_tokens') {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > LIMITS.tokens) errors.push('Output tokens: enter a whole number from 1 to 10,000,000.');
      policy.caps[k] = n;
    } else policy.caps[k] = money(value, k.replaceAll('_', ' '));
  }
  if (String(form.approval).trim() !== '') policy.approval = { above_usd: money(form.approval, 'Approval threshold') };
  if (form.restrictWindows) {
    policy.windows = form.windows.map(w => ({ days: [...w.days], start: w.start, end: w.end }));
    if (policy.windows.length > 64) errors.push('Use at most 64 time windows.');
    for (const w of policy.windows) {
      if (w.days.length > 64 || w.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Window days must be Sunday through Saturday.');
      if (![w.start, w.end].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) errors.push('Window times must use HH:MM in UTC.');
    }
  }
  buildBreakers(form.breakers, policy, errors);
  if (form.agreements !== undefined) policy.agreements = structuredClone(form.agreements);
  if (!['deny', 'kill'].includes(form.onBreach)) errors.push('On breach, choose deny or kill.');
  if (form.alerts !== undefined) { policy.alerts = structuredClone(form.alerts); errors.push(...alertSettingsErrors(form.alerts)); }
  return { policy, errors: [...new Set(errors)] };
}

export function sampleIntent(form) {
  const errors = [];
  if (!form.model?.trim() || form.model.trim().length > 160) errors.push('Enter a model identifier up to 160 characters.');
  if (!LANES.includes(form.lane)) errors.push('Choose a valid lane.');
  const cost = String(form.cost).trim();
  if (!/^\d+(?:\.\d{1,12})?$/.test(cost) || Number(cost) > 1_000_000) errors.push('Estimated cost must be 0 to 1,000,000 USD with at most 12 decimal places.');
  const tools = entries(form.tools);
  if (tools.length > 64 || tools.some(t => t.length > 160)) errors.push('Use at most 64 tools, each up to 160 characters.');
  const intent = { kind: 'inference', model: form.model.trim(), lane: form.lane, est_cost_pico: '0', tools };
  if (form.tokens !== '') {
    const n = Number(form.tokens);
    if (!Number.isInteger(n) || n <= 0 || n > 10_000_000) errors.push('Output tokens must be a whole number from 1 to 10,000,000.');
    intent.max_output_tokens = n;
  }
  if (!errors.length) {
    const [whole, fractional = ''] = cost.split('.');
    intent.est_cost_pico = (BigInt(whole) * 1_000_000_000_000n + BigInt(fractional.padEnd(12, '0'))).toString();
  }
  return { intent, errors };
}

// The confirmation is the sole path to the kill mutation; cancellation sends nothing.
export async function confirmKill(agent, reason, confirm, request) {
  if (!confirm(`Kill ${agent.name || 'this agent'}? New requests through AnyRoute will be stopped until you resume it.`)) return false;
  await request(`/api/v1/agents/${encodeURIComponent(agent.key_hash)}/kill`, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} });
  return true;
}
