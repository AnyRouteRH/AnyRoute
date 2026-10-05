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

// U113: auto top-up, a row under the total budget. "When this key has less than $X left, add $Y from your account credits, at
// most $Z per week": the key's `topup` rule, saved with the same PATCH /api/v1/keys/:hash as the budget. The router applies it
// (src/ledger/topup.ts); nothing here estimates spend. Blank amounts turn it off.
export const TOPUP = { below: 1_000, add: 1_000, perWeek: 5_000 };
export const TOPUP_FIELDS = [['below', 'When less than ($) is left', TOPUP.below], ['add', 'Add ($)', TOPUP.add], ['perWeek', 'At most per week ($)', TOPUP.perWeek]];
export const TOPUP_WORDS = {
  title: 'Auto top-up',
  help: 'Optional. No money moves: the total budget is an allowance on your account’s credits, and a top-up never takes it above what the account holds. Weeks run Monday to Sunday, UTC. Caps still apply. Each top-up shows in Activity and your inbox.',
  off: 'Off. Fill in all three amounts to keep this key going from your credits when its budget runs low.',
  incomplete: 'Auto top-up: fill in all three amounts, or clear them to turn it off.',
  range: 'Auto top-up: enter USD from 0.01 up to 1,000 for the threshold and the amount added, and up to 5,000 per week.',
  order: 'Auto top-up: the amount added cannot be more than the most per week.',
  needsBudget: 'Auto top-up raises the total budget, so set a total budget too.',
  resets: 'Auto top-up works with a total budget that does not reset each period.',
};
const dollars = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 6 });
const sameTopup = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The key's `topup` rule (or null) -> the three amounts as text. */
export const topupText = rule => rule ? { below: String(rule.below_usd), add: String(rule.add_usd), perWeek: String(rule.max_per_week_usd) } : { below: '', add: '', perWeek: '' };

/** The three amounts -> the `topup` rule (null when all are blank), with readable errors. */
export function topupFrom(value) {
  const v = value || {};
  const filled = TOPUP_FIELDS.filter(([k]) => !blank(v[k]));
  if (!filled.length) return { topup: null, errors: [] };
  if (filled.length < TOPUP_FIELDS.length) return { topup: null, errors: [TOPUP_WORDS.incomplete] };
  const [below, add, perWeek] = TOPUP_FIELDS.map(([k]) => Number(v[k]));
  if (TOPUP_FIELDS.some(([k, , max]) => { const n = Number(v[k]); return !Number.isFinite(n) || n < 0.01 || n > max; })) return { topup: null, errors: [TOPUP_WORDS.range] };
  if (add > perWeek) return { topup: null, errors: [TOPUP_WORDS.order] };
  return { topup: { below_usd: below, add_usd: add, max_per_week_usd: perWeek }, errors: [] };
}

/** The one-line summary under the amounts. `week` is what was added this week (topups_this_week_usd), when known. */
export function topupSummary(value, { week = null, reset = null } = {}) {
  const { topup, errors } = topupFrom(value);
  if (errors.length) return errors[0];
  if (!topup) return TOPUP_WORDS.off;
  if (reset) return `${TOPUP_WORDS.resets} ${budgetResetText(reset)}`;
  const line = `When this key has less than ${dollars(topup.below_usd)} left, add ${dollars(topup.add_usd)} from your account credits, at most ${dollars(topup.max_per_week_usd)} per week.`;
  return week == null ? line : `${line} Added this week: ${dollars(week)}.`;
}

/** A short line for the key's card in API keys, or '' when off. */
export const topupCardText = rule => rule ? `Auto top-up: adds ${dollars(rule.add_usd)} below ${dollars(rule.below_usd)} left, up to ${dollars(rule.max_per_week_usd)} a week.` : '';

/** What Save writes for a key: a body for PATCH /api/v1/keys/:hash with `limit` when the total budget changed and `topup` when
 *  the auto top-up changed, and the rulebook body for PUT /api/v1/agents/:key_hash/policy unless only the key changed. Without a
 *  readable rulebook (form null), only the key. Leaving `topup` out leaves the auto top-up as it is. */
export function keySavePlan({ form, loaded, budget, savedBudget, topup, savedTopup = null, reset = null }) {
  const next = keyBudgetFrom(budget);
  const auto = topup === undefined ? null : topupFrom(topup);
  const built = form ? rulebookFromLimits(form) : null;
  const errors = [...next.errors, ...(auto?.errors || []), ...(built?.errors || [])];
  if (auto?.topup && !next.errors.length && next.limit == null) errors.push(TOPUP_WORDS.needsBudget);
  if (auto?.topup && reset) errors.push(TOPUP_WORDS.resets);
  const budgetChanged = !next.errors.length && next.limit !== (savedBudget == null ? null : Number(savedBudget));
  const topupChanged = !!auto && !auto.errors.length && !sameTopup(auto.topup, savedTopup);
  const body = { ...(budgetChanged ? { limit: next.limit } : {}), ...(topupChanged ? { topup: auto.topup } : {}) };
  const keyChanged = budgetChanged || topupChanged;
  const rulebookChanged = !!built && (!loaded || JSON.stringify(built.policy) !== JSON.stringify(rulebookFromLimits(loaded).policy));
  return { budget: keyChanged ? body : null, policy: built && (rulebookChanged || !keyChanged) ? built.policy : null, errors };
}

/** What a saved key body is called in notices: the total budget, the auto top-up, or both. */
const keyWords = body => body && 'topup' in body ? ('limit' in body ? 'Total budget and auto top-up' : 'Auto top-up') : 'Total budget';
export const keySaveNotice = plan => plan.budget && plan.policy ? (keyWords(plan.budget) === 'Total budget' ? KEY_BUDGET_WORDS.saved.both : `${keyWords(plan.budget)} and spending limits saved.`)
  : plan.budget ? (keyWords(plan.budget) === 'Total budget' ? KEY_BUDGET_WORDS.saved.budget : `${keyWords(plan.budget)} saved.`) : KEY_BUDGET_WORDS.saved.policy;

/** Runs a keySavePlan through the existing calls, the key first. `request` is api() with the signed-in key; `onBudget`
 *  hears the saved limit (undefined when unchanged) and the saved body, also when the rulebook then fails, so the error
 *  can say what was saved. */
export async function saveKeyLimits(request, keyHash, plan, onBudget) {
  const hash = encodeURIComponent(keyHash);
  if (plan.budget) { await request('/api/v1/keys/' + hash, { method: 'PATCH', body: plan.budget }); onBudget?.(plan.budget.limit, plan.budget); }
  if (!plan.policy) return;
  try { await request('/api/v1/agents/' + hash + '/policy', { method: 'PUT', body: plan.policy }); }
  catch (error) {
    if (!plan.budget) throw error;
    const partial = keyWords(plan.budget) === 'Total budget' ? KEY_BUDGET_WORDS.partial : `${keyWords(plan.budget)} saved. The spending limits were not saved:`;
    throw new Error(`${partial} ${error?.message || 'the request could not be completed.'}`);
  }
}
