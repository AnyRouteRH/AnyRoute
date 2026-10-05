import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STARTER_RULEBOOKS } from '../lib/agent-starters.js';
import { GUARD_STARTERS } from '../lib/agent-guard.js';
import { routeDefaultConflict } from '../lib/route-default.js';
import { LIMIT_CAPS, limitsFromRulebook, rulebookFromLimits, limitsFromChat, chatFromLimits, guardForm } from '../lib/spending-limits.js';
import { STARTER_SETUPS, MORE_STARTERS, SETUP_VIEWS, setupPolicy, setupsFor, withSetup, setupSummary, describeRulebook } from '../lib/starter-setups.js';
import { TASKS } from '../lib/site-map.js';

// U103: starter setups fill the one spending limits editor; they never save on their own.
const schema = await import('../../src/agents/policy.ts').then(m => m.agentPolicySchema).catch(() => null);
const accepts = (t, policy) => { if (schema) assert.deepEqual(schema.parse(policy), policy); else t.diagnostic('router schema not loadable here'); };
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = id => [...STARTER_RULEBOOKS, ...GUARD_STARTERS].find(s => s.id === id)?.policy;
const byId = Object.fromEntries(STARTER_SETUPS.map(s => [s.id, s]));
const GUARDS = [false, true];
const AGENTS_ONLY = ['max_output_tokens'];

const saved = {
  version: 1, models: { allow: ['author/*'] }, lanes: ['unlinkable'], route_default: 'proven_only',
  caps: { per_request_usd: 9, per_hour_usd: 9, per_day_usd: 9, per_week_usd: 9, max_output_tokens: 99 },
  tools: { allow: ['lookup'], max_price_per_call: 0.5, daily_budget: 3 }, windows: [{ days: [0], start: '01:00', end: '02:00' }],
  approval: { above_usd: 7, above_calls_per_hour: 7 }, breakers: { max_requests_per_minute: 99 },
  autonomy: { rungs: [{ after_days: 7, clean_requests: 100, caps_multiplier: 2 }], demote_on: ['deny'] },
  alerts: { at_percent: [90], denials_in_10min: 9, channels: ['webhook'] }, agreements: { max_escrow_usd: 50 },
  actions: structuredClone(GUARD_STARTERS[2].policy.actions), on_breach: 'kill',
};

test('three to five named setups, each built from existing starters with their numbers unchanged', () => {
  assert.ok(STARTER_SETUPS.length >= 3 && STARTER_SETUPS.length <= 5);
  assert.equal(new Set(STARTER_SETUPS.map(s => s.id)).size, STARTER_SETUPS.length);
  for (const setup of STARTER_SETUPS) {
    assert.ok(setup.name && setup.blurb && setup.from.length, setup.id);
    for (const id of setup.from) assert.ok(source(id), `${setup.id} names ${id}`);
    const model = source(setup.from[0]), policy = setupPolicy(setup, { guard: true });
    // Batch jobs drops only the requests-a-minute breaker; every number it keeps is the starter's.
    const breakers = setup.id === 'batch-jobs' ? (({ max_requests_per_minute, ...rest }) => rest)(model.breakers) : model.breakers;
    for (const k of ['models', 'caps', 'tools', 'approval', 'on_breach']) assert.deepEqual(policy[k], model[k], `${setup.id} ${k}`);
    assert.deepEqual(policy.breakers, breakers, `${setup.id} breakers`);
  }
  // Careful chatbot: the support bot's caps, ask-first amount and breakers, on both lanes with Proven hardware first.
  const { alerts: _alerts, ...support } = source('support');
  assert.deepEqual(setupPolicy(byId['careful-chatbot']), { ...support, lanes: ['public', 'attested'], route_default: 'proven_first' });
  // Trading agent: the ask-first trading starter, on proven hardware only, plus the trading action rulebook where Guard is on.
  const trading = setupPolicy(byId['trading-agent'], { guard: true });
  assert.equal(trading.route_default, 'proven_first'); assert.equal(trading.approval.above_calls_per_hour, 60);
  assert.deepEqual(trading.actions, source('guard-trading').actions); assert.deepEqual(trading.windows, source('guard-trading').windows);
  const noGuard = setupPolicy(byId['trading-agent'], { guard: false });
  assert.equal(noGuard.actions, undefined); assert.equal(noGuard.windows, undefined);
  // Batch jobs: higher caps, standard route, a requests-per-minute breaker. Proven hardware by default: the existing starter.
  assert.deepEqual(setupPolicy(byId['batch-jobs']).caps, source('trading-budget').caps); assert.equal(setupPolicy(byId['batch-jobs']).route_default, undefined);
  assert.ok(setupPolicy(byId['batch-jobs']).caps.per_day_usd > setupPolicy(byId['careful-chatbot']).caps.per_day_usd);
  assert.equal(setupPolicy(byId['batch-jobs']).breakers.max_requests_per_minute, undefined); assert.ok(setupPolicy(byId['batch-jobs']).breakers.max_denials_per_10min > 0);
  assert.deepEqual(setupPolicy(byId['proven-hardware']), source('private'));
  // A fresh copy every time, so filling the editor never touches the starters.
  assert.notEqual(setupPolicy(byId['batch-jobs']), setupPolicy(byId['batch-jobs']));
  setupPolicy(byId['batch-jobs']).caps.per_day_usd = 1; assert.equal(source('trading-budget').caps.per_day_usd, 5);
});

test('every setup and folded-in starter round-trips through the editor and the router schema accepts it', t => {
  for (const setup of [...STARTER_SETUPS, ...MORE_STARTERS]) for (const guard of GUARDS) {
    const policy = setupPolicy(setup, { guard });
    assert.deepEqual(rulebookFromLimits(limitsFromRulebook(policy)), { policy, errors: [] }, setup.id);
    accepts(t, policy);
    // Filled into an empty editor on Agents, Save writes exactly the setup's rulebook (action rulebooks only where Guard shows).
    if (!setup.guardOnly || guard) assert.deepEqual(rulebookFromLimits(withSetup(limitsFromRulebook(null), setup, { view: 'agents', guard })), { policy, errors: [] }, setup.id);
  }
});

test('the default route agrees with the lanes in every setup', () => {
  for (const setup of STARTER_SETUPS) {
    const form = limitsFromRulebook(setupPolicy(setup, { guard: true }));
    assert.equal(routeDefaultConflict(form.routeDefault, form.restrictLanes, form.lanes), '', setup.id);
  }
});

test('each editor fills only the values it shows and keeps everything else as it was', t => {
  const base = limitsFromRulebook(saved);
  for (const setup of STARTER_SETUPS) for (const guard of GUARDS) {
    const policy = setupPolicy(setup, { guard });
    // Agents: the setup's values; autonomy, agreements and paid tool prices stay; alerts and actions stay unless it sets them.
    const agents = rulebookFromLimits(withSetup(base, setup, { view: 'agents', guard })).policy;
    accepts(t, agents);
    for (const k of ['models', 'lanes', 'route_default', 'caps', 'approval', 'windows', 'breakers', 'on_breach']) assert.deepEqual(agents[k], policy[k], `${setup.id} agents ${k}`);
    assert.deepEqual(agents.autonomy, saved.autonomy); assert.deepEqual(agents.agreements, saved.agreements); assert.deepEqual(agents.alerts, policy.alerts ?? saved.alerts);
    assert.equal(agents.tools.max_price_per_call, 0.5); assert.deepEqual(agents.actions, guard && policy.actions ? policy.actions : saved.actions);
    // API keys: caps, ask me first, models, lanes, default route, tools and actions; output length, calls per hour, hours,
    // breakers and the breach rule are Agents-only and stay as saved.
    const key = rulebookFromLimits(withSetup(base, setup, { view: 'key', guard })).policy;
    accepts(t, key);
    for (const [k] of LIMIT_CAPS) assert.equal(key.caps[k], policy.caps[k], `${setup.id} key ${k}`);
    for (const k of AGENTS_ONLY) assert.equal(key.caps[k], saved.caps[k]);
    assert.equal(key.approval.above_usd, policy.approval.above_usd); assert.equal(key.approval.above_calls_per_hour, saved.approval.above_calls_per_hour);
    for (const k of ['models', 'lanes', 'route_default']) assert.deepEqual(key[k], policy[k], `${setup.id} key ${k}`);
    assert.deepEqual(key.tools.allow, policy.tools?.allow); assert.equal(key.tools.daily_budget, 3);
    for (const k of ['windows', 'breakers', 'on_breach', 'alerts', 'autonomy', 'agreements']) assert.deepEqual(key[k], saved[k], `${setup.id} key keeps ${k}`);
    assert.deepEqual(key.actions, guard && policy.actions ? policy.actions : saved.actions);
  }
});

test('chat offers the chatbot setup and fills only caps and ask me first; total and expiry stay', t => {
  assert.deepEqual(setupsFor('chat').setups.map(s => s.id), ['careful-chatbot']); assert.deepEqual(setupsFor('chat').more, []);
  const setup = byId['careful-chatbot'], policy = setupPolicy(setup);
  const form = { ...limitsFromChat(null), total: '12', minutes: '30' };
  const filled = withSetup(form, setup, { view: 'chat', guard: true });
  assert.equal(filled.total, '12'); assert.equal(filled.minutes, '30'); assert.equal(filled.routeDefault, 'standard'); assert.equal(filled.guard, null);
  const out = chatFromLimits(filled);
  assert.deepEqual(out.errors, []); accepts(t, out.policy);
  assert.deepEqual(out.policy, { version: 1, models: {}, caps: Object.fromEntries(LIMIT_CAPS.map(([k]) => [k, policy.caps[k]])), approval: { above_usd: policy.approval.above_usd }, on_breach: 'deny' });
  assert.deepEqual(out.session, { name: 'Chat in this browser', budget_usd: 12, ttl_minutes: 30 });
});

test('setups are offered where the editor appears; earlier starters stay reachable on Agents', () => {
  assert.deepEqual(SETUP_VIEWS, ['chat', 'key', 'agents']);
  assert.deepEqual(setupsFor('key', { guard: true }).setups, STARTER_SETUPS); assert.deepEqual(setupsFor('key', { guard: true }).more, []);
  assert.deepEqual(setupsFor('agents', { guard: true }).more.map(s => s.id), [...STARTER_RULEBOOKS, ...GUARD_STARTERS].map(s => s.id));
  assert.deepEqual(setupsFor('agents').more.map(s => s.id), STARTER_RULEBOOKS.map(s => s.id));
  assert.throws(() => setupsFor('elsewhere'));
  assert.deepEqual(rulebookFromLimits(withSetup(limitsFromRulebook(null), MORE_STARTERS.find(s => s.id === 'guard-onchain'), { guard: true })).policy, source('guard-onchain'));
  assert.deepEqual(withSetup(limitsFromRulebook(null), MORE_STARTERS.find(s => s.id === 'support')).alerts, source('support').alerts);
  assert.deepEqual(guardForm(source('guard-trading').actions), withSetup(limitsFromRulebook(null), byId['trading-agent'], { view: 'key', guard: true }).guard);
});

test('the summary says in plain English what a setup fills here and what it sets on Agents', () => {
  const lines = (id, view, guard = true) => setupSummary(byId[id], { view, guard });
  const chatbot = lines('careful-chatbot', 'agents');
  assert.deepEqual(chatbot.lines.map(l => l.text).slice(0, 2), ['Caps of $0.01 a request, $0.20 an hour, $1 a day and $5 a week', 'Ask me first above $0.005']);
  assert.ok(chatbot.lines.some(l => l.text === 'Requests that name no lane: Proven hardware first')); assert.deepEqual(chatbot.open, ['models', 'hours']);
  assert.equal(chatbot.elsewhere.length, 0); assert.equal(chatbot.proven, true);
  const chat = lines('careful-chatbot', 'chat');
  assert.deepEqual(chat.lines.map(l => l.part), ['caps', 'ask']);
  assert.ok(chat.elsewhere.some(l => l.part === 'route')); assert.ok(chat.elsewhere.some(l => l.part === 'tools'));
  const trading = lines('trading-agent', 'key');
  assert.ok(trading.lines.some(l => /^Actions: only trade.order and trade.cancel, for NVDA/.test(l.text) && /\$500 an action/.test(l.text)));
  assert.ok(trading.elsewhere.some(l => l.text === 'Model calls and actions only Monday to Friday, 13:30–20:00 UTC'));
  assert.ok(trading.elsewhere.some(l => l.text === 'Ask me first after 60 calls in a rolling hour')); assert.match(trading.note, /from Nov 1 use 14:30–21:00/);
  const tradingOff = lines('trading-agent', 'agents', false);
  assert.ok(!tradingOff.lines.some(l => ['actions', 'hours'].includes(l.part))); assert.equal(tradingOff.note, '');
  const batch = lines('batch-jobs', 'agents');
  assert.ok(batch.lines.some(l => l.text === 'Requests that name no lane: Standard provider'));
  assert.ok(batch.lines.some(l => /^Circuit breakers at 5 denials in ten minutes; a trip stops the key until you resume it$/.test(l.text)));
  assert.equal(batch.proven, false);
  assert.ok(lines('proven-hardware', 'key').lines.some(l => l.text === 'Lanes: attested only'));
  // Every line names a value the editor holds; nothing describes an endpoint or a field the rulebook does not have.
  for (const setup of [...STARTER_SETUPS, ...MORE_STARTERS]) for (const l of describeRulebook(setupPolicy(setup, { guard: true }), { guard: true })) {
    assert.ok(['caps', 'ask', 'models', 'tools', 'lanes', 'route', 'actions', 'tokens', 'calls', 'breach', 'hours', 'breakers', 'alerts'].includes(l.part));
    assert.doesNotMatch(l.text, /\bkill\b|undefined|NaN/);
  }
});

test('one Start from a setup entry point fills the editor and never saves on its own', () => {
  const picker = read('components/limits/StarterSetups.jsx');
  assert.doesNotMatch(picker, /\brequest\(|\bapi\(|fetch\(|method:/); // the hosts' existing Save is the only write
  assert.equal((picker.match(/<button /g) || []).length, 2); assert.equal((picker.match(/type="button"/g) || []).length, 2);
  assert.match(picker, /onChange\(withSetup\(base, next, \{ view, guard \}\)\)/); assert.match(picker, /onChange\(before\)/);
  assert.match(picker, /id="starter-setups"/); assert.match(picker, /<span id="rulebook-templates"\/>/);
  const editor = read('components/limits/SpendingLimits.jsx');
  assert.ok(editor.indexOf('<StarterSetups ') > 0 && editor.indexOf('<StarterSetups ') < editor.indexOf('{W.caps}'));
  assert.match(read('app/agents/Agents.jsx'), /<SpendingLimits id="rulebook"[^>]* setups="agents" scope guard=/);
  assert.match(read('components/limits/KeyLimits.jsx'), /<SpendingLimits key=\{revision\} id="key-limits"[^>]* setups="key" scope guard=/);
  assert.match(read('components/harness/Limits.jsx'), /<SpendingLimits id="chat" compact setups="chat"/);
  const agents = read('app/agents/Agents.jsx');
  assert.doesNotMatch(agents, /StarterRulebooks|GuardStarters/);
  assert.equal((agents.match(/<StarterSetups /g) || []).length, 1); assert.match(agents, /\{!\(key && !off && agent\) && <StarterSetups id="setup-preview" view="agents"/);
  const task = TASKS.find(item => item.id === 'starter-setups');
  assert.equal(task.href, '/agents/#starter-setups'); assert.equal(task.menu, false); assert.equal(task.group, 'agents');
  assert.equal(TASKS.some(item => item.id === 'rulebook-templates'), false);
});

test('docs explain setups next to spending limits and the default route, linked from the feature index', () => {
  const page = read('app/docs/page.jsx');
  assert.match(page, /<SpendingLimitsDocs \/><DefaultRouteDocs \/><StarterSetupsDocs \/>/);
  assert.equal(page.split('<StarterSetupsDocs />').length - 1, 1);
  assert.match(read('components/DocsFeatureIndex.jsx'), /\["starter-setups", "Starter setups"\]/);
  const docs = read('components/StarterSetupsDocs.jsx');
  assert.match(docs, /<section id="starter-setups"><h2>Starter setups<\/h2>/);
  for (const phrase of ['PUT /api/v1/agents/:key_hash/policy', 'no endpoint and no rulebook field', 'More starting points', 'href="/status/#proof-time"', 'href="#default-route"']) assert.ok(docs.includes(phrase), phrase);
});

test('public wording in setups, the picker and the docs', () => {
  const banned = new RegExp(String.raw`\b(?:${['de' + 'mo', 'te' + 'st', 'te' + 'sted', 'mo' + 'ck', 'simu' + 'lated', 'place' + 'holder', 'fix' + 'ture', 'lo' + 'cal', 'ki' + 'll', 'anony' + 'mous', 'trust' + 'less', 'decen' + 'tralized', 'ea' + 'rn', 'yi' + 'eld', 'A' + 'PY', 'ret' + 'urns', 'pri' + 'vate', 'bo' + 'nds?', 'depo' + 'sits?', 'x4' + '02'].join('|')})\b|no lo` + 'gs|can[’\']t read your prompt', 'i');
  for (const file of ['lib/starter-setups.js', 'components/limits/StarterSetups.jsx', 'components/StarterSetupsDocs.jsx']) {
    const copy = read(file).replace(/import[^\n]*\n/g, '').replace(/'(?:private|kill)'/g, ''); // rulebook values and starter ids, never shown
    assert.doesNotMatch(copy, banned, file);
  }
  for (const setup of [...STARTER_SETUPS, ...MORE_STARTERS.filter(s => s.guardOnly)]) for (const view of SETUP_VIEWS) for (const guard of GUARDS) {
    const s = setupSummary(setup, { view, guard });
    assert.doesNotMatch([setup.name, setup.blurb, s.note, ...s.lines.map(l => l.text), ...s.elsewhere.map(l => l.text)].join(' '), banned, setup.id);
  }
});
