// U103: starter setups. A setup is a named bundle that fills the spending limits editor with values composed from the
// starters that already exist (agent-starters.js, agent-guard.js) and the default route (route-default.js). This file is
// pure mapping: it builds editor values and a plain-English summary. Nothing here saves; the editor's own Save writes the
// key's rulebook (PUT /api/v1/agents/:key_hash/policy) exactly as before. No new rulebook fields.
import { rulebookParts } from './rulebook-words.js'; // B124
import { STARTER_RULEBOOKS } from './agent-starters.js';
import { GUARD_STARTERS } from './agent-guard.js';
import { ROUTE_DEFAULT_OPTIONS } from './route-default.js';
import { LIMIT_CAPS, guardForm, limitsFromRulebook } from './spending-limits.js';

const starter = id => structuredClone(STARTER_RULEBOOKS.find(item => item.id === id).policy);
const guardStarter = id => structuredClone(GUARD_STARTERS.find(item => item.id === id).policy);
const without = (policy, ...keys) => Object.fromEntries(Object.entries(policy).filter(([k]) => !keys.includes(k)));
// The trading action rulebook's hours apply to the whole rulebook, model calls included.
const tradingActions = guard => {
  if (!guard) return {};
  const { windows, actions } = guardStarter('guard-trading');
  return { windows, actions };
};
export const MARKET_HOURS_NOTE = 'UTC hours cover the whole rulebook, model calls included: 13:30–20:00 covers US market hours during daylight time; from Nov 1 use 14:30–21:00.';
export const TARGETS_NOTE = 'Allowed targets STOCK_A, STOCK_B, STOCK_C, INDEX_FUND_A and INDEX_FUND_B stand for the symbols your agent trades; put your own there before saving.';

/**
 * The setups. `from` names the starters whose numbers each one reuses; `build` composes the rulebook, with Agent Guard's
 * action rules only where `guard` is on. `chat` marks the ones offered in chat, whose editor shows caps and ask me first.
 */
export const STARTER_SETUPS = [
  { id: 'careful-chatbot', name: 'Careful chatbot', from: ['support'], chat: true,
    blurb: 'Small caps and short replies for a chatbot. Proven hardware when the model has it, otherwise a standard provider.',
    // The support bot's caps, ask-first amount and breakers; both lanes, so Proven hardware first can pick attested.
    build: () => ({ ...without(starter('support'), 'alerts'), lanes: ['public', 'attested'], route_default: 'proven_first' }) },
  { id: 'trading-agent', name: 'Trading agent', from: ['trading-ask-first', 'guard-trading'],
    blurb: 'The trading starter: ask first above an amount and after a number of calls an hour, on proven hardware when the model has it. Order rules and market hours where Agent Guard is on.',
    build: ({ guard }) => ({ ...starter('trading-ask-first'), route_default: 'proven_first', ...tradingActions(guard) }),
    note: ({ guard }) => guard ? `${MARKET_HOURS_NOTE} ${TARGETS_NOTE}` : '' },
  { id: 'batch-jobs', name: 'Batch jobs', from: ['trading-budget'],
    blurb: 'Higher caps for long runs on standard providers. The daily cap and a denials breaker stop a runaway loop.',
    // No requests-a-minute breaker: a normal batch would trip it and stop the key.
    build: () => { const { breakers: { max_requests_per_minute, ...breakers } = {}, ...rest } = starter('trading-budget'); return { ...rest, breakers }; } },
  { id: 'proven-hardware', name: 'Proven hardware by default', from: ['private'],
    blurb: 'Small caps. Every request goes to proven hardware, or is refused and not charged.',
    build: () => starter('private') },
];

// The earlier single starters, folded into the same entry point on Agents. They fill the editor the same way.
const GUARD_NOTE = 'Action rules only: model spending and declared tools stay unrestricted.';
export const MORE_STARTERS = [
  ...STARTER_RULEBOOKS.map(item => ({ id: item.id, name: item.name, from: [item.id], blurb: item.description, build: () => starter(item.id) })),
  ...GUARD_STARTERS.map(item => ({ id: item.id, name: item.name, from: [item.id], guardOnly: true, build: () => guardStarter(item.id),
    blurb: item.policy.windows ? `${GUARD_NOTE} ${MARKET_HOURS_NOTE} ${TARGETS_NOTE}` : GUARD_NOTE })),
];

/** A fresh copy of the rulebook a setup stands for. */
export const setupPolicy = (setup, { guard = false } = {}) => structuredClone(setup.build({ guard }));

// Which editor shows which values. Chat: caps and ask me first. API keys: plus models, lanes, default route, tools and
// actions. Agents: everything the rulebook editor there shows. Other values in the editor are left exactly as they are.
const CAPS = LIMIT_CAPS.map(([k]) => k);
const SCOPE = ['modelAllow', 'modelDeny', 'restrictLanes', 'lanes', 'routeDefault', 'restrictTools', 'toolAllow', 'toolDeny'];
const VIEWS = {
  chat: { caps: CAPS, fields: ['approval'], parts: ['caps', 'ask'] },
  key: { caps: CAPS, fields: ['approval', ...SCOPE], parts: ['caps', 'ask', 'models', 'tools', 'lanes', 'route', 'actions'] },
  agents: { caps: [...CAPS, 'max_output_tokens'], fields: ['approval', 'approvalCalls', 'onBreach', ...SCOPE, 'restrictWindows', 'windows', 'breakers'],
    parts: ['caps', 'ask', 'models', 'tools', 'lanes', 'route', 'actions', 'tokens', 'calls', 'breach', 'hours', 'breakers', 'alerts'] },
};
export const SETUP_VIEWS = Object.keys(VIEWS);
const view = name => { if (!VIEWS[name]) throw new Error(`Unknown editor: ${name}`); return VIEWS[name]; };

/** The setups an editor offers, and on Agents the earlier single starters (action rulebooks only where Guard is on). */
export function setupsFor(name, { guard = false } = {}) {
  view(name);
  return { setups: STARTER_SETUPS.filter(s => name !== 'chat' || s.chat), more: name === 'agents' ? MORE_STARTERS.filter(s => guard || !s.guardOnly) : [] };
}

/**
 * Editor values with a setup filled in: the values that editor shows come from the setup; everything else (the chat key's
 * total and expiry, autonomy, agreements, paid tool prices, rules shown only on Agents) stays as it was in `form`.
 * Alerts and Agent Guard's actions are set only by a setup that carries them, and actions only where that section shows.
 */
export function withSetup(form, setup, { view: name = 'agents', guard = false } = {}) {
  const v = view(name);
  const policy = setupPolicy(setup, { guard });
  const next = limitsFromRulebook(policy);
  const out = { ...form, caps: { ...form.caps } };
  for (const k of v.caps) out.caps[k] = next.caps[k];
  for (const k of v.fields) out[k] = structuredClone(next[k]);
  if (name === 'agents' && policy.alerts !== undefined) out.alerts = structuredClone(policy.alerts);
  if (name !== 'chat' && guard && policy.actions !== undefined) out.guard = guardForm(policy.actions);
  return out;
}

// Plain-English lines. `open` names what a line leaves unrestricted (shown together as one short line); `neutral` marks
// a line that adds no restriction, so it is not repeated as "set on Agents" for an editor that does not show it.
const and = (items, word = 'and') => items.join(` ${word} `);
/** The one short line for everything a setup leaves unrestricted in an editor, or '' when it leaves nothing open. */
export const openLine = open => open.length ? `No limit on ${and(open, 'or')}` : '';

/** Every value a rulebook sets, in the editor's order, as plain English. */
export function describeRulebook(policy, { guard = false } = {}) {
  const parts = rulebookParts(policy);
  const open = {
    caps: !CAPS.some(k => policy.caps?.[k] !== undefined) && 'model spending',
    models: policy.models.allow === undefined && !policy.models.deny?.length && 'models',
    tools: policy.tools?.allow === undefined && !policy.tools?.deny?.length && 'declared tools',
    lanes: policy.lanes === undefined && 'lanes', hours: policy.windows === undefined && 'hours',
    tokens: policy.caps.max_output_tokens === undefined && 'reply length',
    breakers: !Object.keys(policy.breakers ?? {}).length && 'circuit breakers',
  };
  const order = ['caps', 'ask', 'models', 'tools', 'lanes', 'route', ...(guard && policy.actions ? ['actions'] : []), 'tokens', 'calls', 'breach', 'hours', 'breakers', 'alerts'];
  // B124: the shared formatter leaves defaults out, so the editor summary supplies its own words for open parts.
  const fallback = { ask: 'No ask-first amount', tokens: 'Any reply length', breakers: 'No circuit breakers', models: 'Any model', tools: 'Any declared tool', lanes: 'Any lane', hours: 'Any time', route: 'Requests that name no lane: Standard provider' };
  return order.flatMap(part => {
    const texts = parts.filter(line => line.part === part).map(line => line.text);
    if (!texts.length && !fallback[part]) return [];
    return [{ part, text: texts.join('; ') || fallback[part], open: open[part] || null,
      neutral: !!open[part] || (part === 'ask' && !policy.approval) || (part === 'route' && (policy.route_default ?? 'standard') === 'standard') || (part === 'breach' && policy.on_breach !== 'kill') }];
  });
}

/**
 * What picking a setup does in one editor: `lines` it fills there; `open`, what it leaves unrestricted there; `elsewhere`,
 * restrictions it carries that this editor does not show (set on Agents); `proven`, whether it uses proven hardware;
 * `note`, any caveat to show with it.
 */
export function setupSummary(setup, { view: name = 'agents', guard = false } = {}) {
  const v = view(name);
  const policy = setupPolicy(setup, { guard });
  const all = describeRulebook(policy, { guard: guard && name !== 'chat' });
  const here = all.filter(l => v.parts.includes(l.part));
  return {
    lines: here.filter(l => !l.open),
    open: here.filter(l => l.open).map(l => l.open),
    elsewhere: all.filter(l => !v.parts.includes(l.part) && !l.neutral),
    proven: ['proven_first', 'proven_only'].includes(policy.route_default) || (policy.lanes?.length === 1 && policy.lanes[0] === 'attested'),
    note: setup.note?.({ guard }) ?? '',
  };
}
