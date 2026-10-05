// U102: one set of spending limits wherever a key's spending is controlled (chat, /agents, the dashboard's API keys).
// Pure mapping to and from the existing payloads: the rulebook (PUT /api/v1/agents/:key_hash/policy) and chat limits
// (POST /api/v1/sessions plus the chat key's rulebook). The router evaluates and enforces; nothing here estimates spend.
import { LIMITS, policyForm, buildPolicy } from './agents.js';

export const LIMIT_CAPS = [['per_request_usd', 'Cap per request ($)'], ['per_hour_usd', 'Cap per hour ($)'], ['per_day_usd', 'Cap per day ($)'], ['per_week_usd', 'Cap per week ($)']];
export const GUARD_CAPS = [['per_action_usd', 'Cap per action ($)'], ['per_day_usd', 'Cap per day ($)'], ['max_per_hour', 'Actions per hour']];
export const CHAT_KEY = { name: 'Chat in this browser', total: 1000, minutes: 1440 };
export const LIMIT_WORDS = {
  title: 'Spending limits', caps: 'Caps', ask: 'Ask me first above ($)', stop: 'Stop', resume: 'Resume', stopTitle: 'Stop and resume',
  scope: 'Models, lanes and tools', guard: 'Actions (Agent Guard)', save: 'Save spending limits', remove: 'Remove spending limits',
  capsHelp: 'Optional; a blank cap adds no cap. Per request uses the router’s estimated cost. Hour, day and week are rolling windows that include requests still running.',
  askHelp: 'Optional. Above this estimated cost, the router pauses the request until you approve or deny it. Each approval is single use and expires.',
  stopHelp: 'Stop refuses the next request through Anyroute until you resume. A request already running may finish and is still billed.',
  stopFirst: 'Save spending limits first. Stop and Resume act on saved limits.',
  scopeHelp: 'One entry per line or comma. Model identifiers and author/* patterns are accepted. Deny wins. Blank lists add no restriction unless you choose to deny tools below.',
  lanesHelp: 'With restrictions on, no checked lanes means every lane is denied. Selecting a lane does not establish its availability.',
  scopeOnly: 'Spending limits cover requests through Anyroute only; they do not control calls sent elsewhere.',
};

const entries = value => String(value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
const text = value => value == null ? '' : String(value);
const blank = value => String(value ?? '').trim() === '';
const TOOL_PRICES = ['max_price_per_call', 'daily_budget', 'pass_to_models'];

export function guardForm(actions) {
  const a = actions || {};
  return { allow: (a.allow || []).join('\n'), deny: (a.deny || []).join('\n'), restrictActions: a.allow !== undefined,
    targetAllow: (a.targets?.allow || []).join('\n'), targetDeny: (a.targets?.deny || []).join('\n'), restrictTargets: a.targets?.allow !== undefined,
    ...Object.fromEntries([...GUARD_CAPS.map(([k]) => k), 'approval_above_usd'].map(k => [k, text(a[k])])) };
}

export function buildGuard(form, errors) {
  const actions = {};
  const list = (value, label) => {
    const items = entries(value);
    if (items.length > LIMITS.entries || items.some(s => s.length > LIMITS.string)) errors.push(`${label}: at most 64 entries, each up to 160 characters.`);
    return items;
  };
  const allow = list(form.allow, 'Allowed actions'), deny = list(form.deny, 'Denied actions');
  if (allow.length || form.restrictActions) actions.allow = allow; // A blank restricted list denies every action.
  if (deny.length) actions.deny = deny;
  const targetAllow = list(form.targetAllow, 'Allowed targets'), targetDeny = list(form.targetDeny, 'Denied targets');
  if (targetAllow.length || form.restrictTargets) (actions.targets ||= {}).allow = targetAllow;
  if (targetDeny.length) (actions.targets ||= {}).deny = targetDeny;
  for (const [k, label] of [...GUARD_CAPS, ['approval_above_usd', LIMIT_WORDS.ask]]) {
    if (blank(form[k])) continue;
    const n = Number(form[k]), name = label.replace(' ($)', '');
    if (k === 'max_per_hour') { if (!Number.isInteger(n) || n <= 0 || n > 100_000) errors.push(`${name}: enter a whole number from 1 to 100,000.`); }
    else if (!Number.isFinite(n) || n <= 0 || n > LIMITS.usd) errors.push(`${name}${k === 'per_action_usd' ? '' : ' (actions)'}: enter USD greater than 0 and up to 1,000,000.`);
    actions[k] = n;
  }
  return actions;
}

/** Rulebook (or null) -> editor values. Settings the editor does not show are kept and written back unchanged. */
export function limitsFromRulebook(policy) {
  const { actions: _actions, ...form } = policyForm(policy);
  const prices = Object.fromEntries(TOOL_PRICES.filter(k => policy?.tools?.[k] !== undefined).map(k => [k, policy.tools[k]]));
  return { ...form, guard: policy?.actions === undefined ? null : guardForm(policy.actions), ...(Object.keys(prices).length ? { toolPrices: prices } : {}) };
}

/** Editor values -> the strict v1 rulebook body for PUT /api/v1/agents/:key_hash/policy, with readable errors. */
export function rulebookFromLimits(form) {
  const { guard, toolPrices, ...rest } = form;
  const { policy, errors } = buildPolicy(rest);
  if (toolPrices) policy.tools = { ...policy.tools, ...structuredClone(toolPrices) }; // v6 T paid tool prices stay as saved.
  if (guard) policy.actions = buildGuard(guard, errors);
  return { policy, errors: [...new Set(errors)] };
}

/** Overlay only the shared fields an editor shows onto the saved rulebook, so other saved rules stay as they are. */
export function withLimits(saved, form, { scope = false, guard = false } = {}) {
  const base = limitsFromRulebook(saved);
  const next = { ...base, caps: { ...base.caps, ...Object.fromEntries(LIMIT_CAPS.map(([k]) => [k, form.caps?.[k] ?? ''])) }, approval: form.approval ?? '' };
  if (scope) for (const k of ['modelAllow', 'modelDeny', 'restrictLanes', 'lanes', 'routeDefault', 'restrictTools', 'toolAllow', 'toolDeny']) next[k] = form[k]; // U101: routeDefault sits with the lanes
  if (guard) next.guard = form.guard ?? null;
  return next;
}

/** Chat limits: a stored chat key (or none) -> editor values, including the chat key's total and expiry. */
export function limitsFromChat(session) {
  return { ...limitsFromRulebook(session?.policy || null), total: session?.budget_usd == null ? '5' : String(session.budget_usd), minutes: '60' };
}

/** Editor values -> POST /api/v1/sessions body and the chat key's rulebook body. */
export function chatFromLimits(form) {
  const errors = [];
  const total = Number(form.total), minutes = Number(form.minutes);
  if (!Number.isFinite(total) || total <= 0 || total > CHAT_KEY.total) errors.push('Total for this chat key: enter USD greater than 0 and up to 1,000.');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > CHAT_KEY.minutes) errors.push('Expire after: enter whole minutes from 1 to 1,440.');
  const built = rulebookFromLimits({ ...form, guard: null });
  return { session: { name: CHAT_KEY.name, budget_usd: total, ttl_minutes: minutes }, policy: built.policy, errors: [...errors, ...built.errors] };
}


// U104: a key's total budget sits in its spending limits editor, beside the caps. It is the key's own `limit` (USD; blank
// means none), saved with PATCH /api/v1/keys/:hash as before; the caps and rules stay the key's rulebook. Save writes each
// through its own existing call, and only the budget when only the budget changed.
export const KEY_BUDGET = { max: 100_000 };
export const KEY_BUDGET_WORDS = {
  label: 'Total budget ($)', title: 'Total budget', save: 'Save total budget',
  help: 'Optional; blank means no total budget. The most this key can spend, saved on the key itself. Caps apply within it.',
  error: 'Total budget: enter USD greater than 0 and up to 100,000, or leave it blank for no total budget.',
  saved: { both: 'Total budget and spending limits saved.', budget: 'Total budget saved.', policy: 'Spending limits saved.' },
  partial: 'Total budget saved. The spending limits were not saved:',
};
export const keyBudgetText = limit => limit == null ? '' : String(limit);
export const budgetResetText = reset => ({ daily: 'It resets each day.', weekly: 'It resets each week.', monthly: 'It resets each month.' })[reset] || '';

/** Total budget text -> the key's `limit` (null for none), with a readable error. */
export function keyBudgetFrom(value) {
  if (blank(value)) return { limit: null, errors: [] };
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= KEY_BUDGET.max ? { limit: n, errors: [] } : { limit: null, errors: [KEY_BUDGET_WORDS.error] };
}

/** What Save writes for a key: { limit } for PATCH /api/v1/keys/:hash when the total budget changed, and the rulebook body for
 *  PUT /api/v1/agents/:key_hash/policy unless only the budget changed. Without a readable rulebook (form null), only the budget. */
export function keySavePlan({ form, loaded, budget, savedBudget }) {
  const next = keyBudgetFrom(budget);
  const built = form ? rulebookFromLimits(form) : null;
  const errors = [...next.errors, ...(built?.errors || [])];
  const budgetChanged = !next.errors.length && next.limit !== (savedBudget == null ? null : Number(savedBudget));
  const rulebookChanged = !!built && (!loaded || JSON.stringify(built.policy) !== JSON.stringify(rulebookFromLimits(loaded).policy));
  return { budget: budgetChanged ? { limit: next.limit } : null, policy: built && (rulebookChanged || !budgetChanged) ? built.policy : null, errors };
}

export const keySaveNotice = plan => plan.budget && plan.policy ? KEY_BUDGET_WORDS.saved.both : plan.budget ? KEY_BUDGET_WORDS.saved.budget : KEY_BUDGET_WORDS.saved.policy;

/** Runs a keySavePlan through the existing calls, the budget first. `request` is api() with the signed-in key; `onBudget`
 *  hears the saved limit, also when the rulebook then fails, so the error can say the budget was saved. */
export async function saveKeyLimits(request, keyHash, plan, onBudget) {
  const hash = encodeURIComponent(keyHash);
  if (plan.budget) { await request('/api/v1/keys/' + hash, { method: 'PATCH', body: plan.budget }); onBudget?.(plan.budget.limit); }
  if (!plan.policy) return;
  try { await request('/api/v1/agents/' + hash + '/policy', { method: 'PUT', body: plan.policy }); }
  catch (error) { if (plan.budget) throw new Error(`${KEY_BUDGET_WORDS.partial} ${error?.message || 'the request could not be completed.'}`); throw error; }
}
