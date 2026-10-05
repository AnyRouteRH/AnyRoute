import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GUARD_STARTERS, GUARD_LIMIT } from '../lib/agent-guard.js';
import { STARTER_RULEBOOKS } from '../lib/agent-starters.js';
import { LIMIT_CAPS, LIMIT_WORDS, CHAT_KEY, guardForm, limitsFromRulebook, rulebookFromLimits, withLimits, limitsFromChat, chatFromLimits } from '../lib/spending-limits.js';
import { chatLimitSpec, createHarnessLimits, CHAT_LIMITS_STORE } from '../lib/harness-limits.js';

// The router's own schema, where this Node can load TypeScript; the mapping must never produce a body it would refuse.
const schema = await import('../../src/agents/policy.ts').then(m => m.agentPolicySchema).catch(() => null);
const accepts = (t, policy) => { if (schema) assert.deepEqual(schema.parse(policy), policy); else t.diagnostic('router schema not loadable here'); };
const source = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

const full = {
  version: 1, models: { allow: ['author/*'], deny: ['author/no'] }, lanes: ['public', 'attested'],
  caps: { per_request_usd: 0.01, per_hour_usd: 1, per_day_usd: 4, per_week_usd: 20, max_output_tokens: 512 },
  tools: { allow: ['lookup'], deny: ['delete'], max_price_per_call: 0.5, daily_budget: 3, pass_to_models: false },
  windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }], approval: { above_usd: 0.02, above_calls_per_hour: 30 },
  breakers: { max_requests_per_minute: 60 }, autonomy: { rungs: [{ after_days: 7, clean_requests: 100, caps_multiplier: 2 }], demote_on: ['deny'] },
  alerts: { at_percent: [80, 100], denials_in_10min: 5, channels: ['webhook'] }, agreements: { max_escrow_usd: 50 },
  actions: structuredClone(GUARD_STARTERS[0].policy.actions), on_breach: 'kill',
};

test('one vocabulary and order: caps per request, hour, day and week, then ask me first, stop and resume', () => {
  assert.deepEqual(LIMIT_CAPS.map(([k]) => k), ['per_request_usd', 'per_hour_usd', 'per_day_usd', 'per_week_usd']);
  assert.deepEqual(LIMIT_CAPS.map(([, label]) => label), ['Cap per request ($)', 'Cap per hour ($)', 'Cap per day ($)', 'Cap per week ($)']);
  assert.equal(LIMIT_WORDS.ask, 'Ask me first above ($)'); assert.equal(LIMIT_WORDS.stop, 'Stop'); assert.equal(LIMIT_WORDS.resume, 'Resume');
  assert.equal(LIMIT_WORDS.title, 'Spending limits');
  const editor = source('../components/limits/SpendingLimits.jsx');
  const order = ['{W.caps}', '{W.ask}', '<StopResume', '{W.scope}', '{W.guard}', '    {children}\n  </div>'].map(mark => editor.indexOf(mark));
  assert.ok(order.every(i => i > 0)); assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(editor, /\{GUARD_LIMIT\}/);
});

test('no rulebook maps to the strict empty v1 body, and every rulebook setting survives a round trip', t => {
  assert.deepEqual(rulebookFromLimits(limitsFromRulebook(null)), { policy: { version: 1, models: {}, caps: {}, on_breach: 'deny' }, errors: [] });
  const { policy, errors } = rulebookFromLimits(limitsFromRulebook(full));
  assert.deepEqual(errors, []); assert.deepEqual(policy, full); accepts(t, policy);
  for (const starter of [...GUARD_STARTERS, ...STARTER_RULEBOOKS]) {
    const built = rulebookFromLimits(limitsFromRulebook(starter.policy));
    assert.deepEqual(built, { policy: starter.policy, errors: [] }); accepts(t, built.policy);
  }
});

test('editing caps and ask me first writes the existing rulebook fields with the editor’s words in errors', t => {
  const form = limitsFromRulebook(null);
  form.caps = { ...form.caps, per_request_usd: '0.5', per_hour_usd: '2', per_day_usd: '10', per_week_usd: '40' }; form.approval = '1';
  const { policy } = rulebookFromLimits(form);
  assert.deepEqual(policy.caps, { per_request_usd: 0.5, per_hour_usd: 2, per_day_usd: 10, per_week_usd: 40 }); assert.deepEqual(policy.approval, { above_usd: 1 }); accepts(t, policy);
  for (const [k, label] of LIMIT_CAPS) for (const bad of ['0', '-1', '1000000.01', 'NaN']) {
    const errors = rulebookFromLimits({ ...form, caps: { ...form.caps, [k]: bad } }).errors;
    assert.ok(errors.some(e => e.startsWith(label.replace(' ($)', ''))), `${k} ${bad}`);
  }
  assert.ok(rulebookFromLimits({ ...form, approval: '0' }).errors.some(e => e.startsWith('Ask me first above')));
  assert.ok(rulebookFromLimits({ ...form, approval: '', approvalCalls: '5' }).errors.some(e => /Ask me first above/.test(e)));
});

test('Agent Guard actions map both ways, keep empty restricted lists and validate their amounts', t => {
  const g = guardForm(GUARD_STARTERS[1].policy.actions);
  assert.equal(g.deny, 'transfer.*\nbridge.*'); assert.equal(g.per_action_usd, '200'); assert.equal(g.restrictActions, true);
  const form = { ...limitsFromRulebook(null), guard: { ...guardForm(null), restrictActions: true, targetAllow: 'NVDA, SPY', per_day_usd: '100', max_per_hour: '4', approval_above_usd: '25' } };
  const { policy, errors } = rulebookFromLimits(form);
  assert.deepEqual(errors, []); assert.deepEqual(policy.actions, { allow: [], targets: { allow: ['NVDA', 'SPY'] }, per_day_usd: 100, max_per_hour: 4, approval_above_usd: 25 }); accepts(t, policy);
  assert.deepEqual(rulebookFromLimits({ ...form, guard: guardForm(null) }).policy.actions, {});
  assert.equal(rulebookFromLimits({ ...limitsFromRulebook(full), guard: null }).policy.actions, undefined);
  for (const [k, bad] of [['per_action_usd', '0'], ['per_day_usd', '1000001'], ['approval_above_usd', 'NaN'], ['max_per_hour', '1.5'], ['max_per_hour', '100001']]) assert.ok(rulebookFromLimits({ ...form, guard: { ...form.guard, [k]: bad } }).errors.length, k);
  assert.ok(rulebookFromLimits({ ...form, guard: { ...form.guard, allow: Array(65).fill('a').join('\n') } }).errors.length);
  assert.match(GUARD_LIMIT, /Rules apply to actions your agent checks first/);
});

test('an editor that shows only some fields overlays them and keeps the saved rulebook’s other rules', t => {
  const chat = limitsFromRulebook(null);
  chat.caps = { ...chat.caps, per_day_usd: '9' }; chat.approval = '0.5'; chat.modelAllow = 'other/*';
  const { policy } = rulebookFromLimits(withLimits(full, chat));
  assert.deepEqual(policy.caps, { per_day_usd: 9, max_output_tokens: 512 }); assert.deepEqual(policy.approval, { above_usd: 0.5, above_calls_per_hour: 30 });
  assert.deepEqual(policy.models, full.models); assert.deepEqual(policy.windows, full.windows); assert.deepEqual(policy.actions, full.actions); assert.equal(policy.on_breach, 'kill'); accepts(t, policy);
  assert.deepEqual(rulebookFromLimits(withLimits(full, chat, { scope: true })).policy.models, { allow: ['other/*'] });
  assert.equal(rulebookFromLimits(withLimits(full, { ...chat, guard: null }, { guard: true })).policy.actions, undefined);
});

test('the default route sits next to the lanes, maps both ways and keeps the allowlist warning (U101)', t => {
  const editor = source('../components/limits/SpendingLimits.jsx');
  const at = mark => editor.indexOf(mark);
  assert.ok(at('{W.lanesHelp}') > 0 && at('{W.lanesHelp}') < at('<RouteDefault ') && at('<RouteDefault ') < at('{W.guard}'));
  assert.match(editor, /\{scope && <RouteDefault id=\{id\} value=\{value\.routeDefault\} onChange=\{v => set\(\{ routeDefault: v \}\)\} restrictLanes=\{!!value\.restrictLanes\} lanes=\{value\.lanes\}/);
  for (const route_default of ['proven_first', 'proven_only']) {
    const policy = { ...full, route_default };
    const form = limitsFromRulebook(policy);
    assert.equal(form.routeDefault, route_default);
    const built = rulebookFromLimits(form);
    assert.deepEqual(built, { policy, errors: [] }); accepts(t, built.policy);
  }
  // Standard is the default and is left out, so a rulebook without the setting keeps its exact body.
  assert.equal(limitsFromRulebook(full).routeDefault, 'standard');
  assert.equal(rulebookFromLimits(limitsFromRulebook(full)).policy.route_default, undefined);
  const edited = { ...limitsFromRulebook(null), routeDefault: 'proven_first' };
  assert.deepEqual(rulebookFromLimits(edited), { policy: { version: 1, models: {}, route_default: 'proven_first', caps: {}, on_breach: 'deny' }, errors: [] });
  assert.ok(rulebookFromLimits({ ...edited, routeDefault: 'attested' }).errors.some(e => e.startsWith('Default route')));
  // An editor that shows the lanes writes the default with them; one that does not (chat) keeps the saved default.
  const saved = { ...full, route_default: 'proven_only' };
  assert.equal(rulebookFromLimits(withLimits(saved, edited, { scope: true })).policy.route_default, 'proven_first');
  assert.equal(rulebookFromLimits(withLimits(saved, limitsFromRulebook(null))).policy.route_default, 'proven_only');
  assert.equal(chatFromLimits(limitsFromChat({ budget_usd: 5, policy: { version: 1, models: {}, caps: {}, route_default: 'proven_first', on_breach: 'deny' } })).policy.route_default, 'proven_first');
  // The allowlist above is stricter, and the setting says so.
  const field = source('../components/limits/RouteDefault.jsx');
  assert.match(field, /routeDefaultConflict\(current, restrictLanes, lanes \?\? \[\]\)/); assert.match(field, /role="status">\{conflict\}/);
  assert.match(field, /name=\{`\$\{id\}-route-default`\}/); // one radio group per editor
});

test('chat limits map to the session body and the chat key’s rulebook; the earlier flat form gives the same payloads', t => {
  const form = limitsFromChat(null);
  assert.equal(form.total, '5'); assert.equal(form.minutes, '60');
  form.caps = { ...form.caps, per_request_usd: '0.2', per_day_usd: '2' }; form.approval = '0.1';
  const out = chatFromLimits(form);
  assert.deepEqual(out, { session: { name: CHAT_KEY.name, budget_usd: 5, ttl_minutes: 60 }, policy: { version: 1, models: {}, caps: { per_request_usd: 0.2, per_day_usd: 2 }, approval: { above_usd: 0.1 }, on_breach: 'deny' }, errors: [] });
  accepts(t, out.policy);
  assert.deepEqual(chatLimitSpec({ session: '5', day: '2', approval: '0.1', minutes: '60' }), chatLimitSpec({ ...form, caps: { ...form.caps, per_request_usd: '' } }));
  assert.equal(chatFromLimits({ ...form, guard: guardForm(null) }).policy.actions, undefined);
  for (const change of [{ total: '0' }, { total: '1001' }, { minutes: '0' }, { minutes: '1441' }, { minutes: '2.5' }]) assert.ok(chatFromLimits({ ...form, ...change }).errors.length);
  const saved = { budget_usd: 7, policy: out.policy };
  assert.deepEqual([limitsFromChat(saved).total, limitsFromChat(saved).caps.per_request_usd, limitsFromChat(saved).approval], ['7', '0.2', '0.1']);
});

test('chat Save changes the chat key’s rulebook in place with the creating key and keeps rules saved elsewhere', async () => {
  const calls = [], values = new Map();
  const server = { version: 1, models: {}, caps: { per_day_usd: 2 }, windows: [{ days: [1], start: '09:00', end: '17:00' }], approval: { above_usd: 0.1 }, on_breach: 'deny' };
  const c = createHarnessLimits({ storage: { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }, stream: async () => 'reply',
    request: async (url, opts) => { calls.push([url, opts.method || 'GET', opts.key, opts.body]);
      if (url === '/api/v1/sessions') return { data: { id: 'chat-session', key: 'child-key', key_hash: 'child-hash', budget_usd: 5, expires_at: new Date(Date.now() + 900_000).toISOString() } };
      if (url.endsWith('/policy') && !opts.method) return { data: { policy: server } };
      return { data: {} }; } });
  await c.connect('parent-key', 'parent-hash');
  await assert.rejects(c.update(limitsFromChat(null)), /Create the chat key/);
  await c.enable({ session: '5', day: '2', approval: '0.1', minutes: '60' });
  const form = limitsFromChat(c.get().session); form.caps = { ...form.caps, per_hour_usd: '1' }; form.approval = '';
  await c.update(form);
  const [get, put] = calls.slice(-2);
  assert.deepEqual(get.slice(0, 3), ['/api/v1/agents/child-hash/policy', 'GET', 'parent-key']);
  assert.deepEqual(put.slice(0, 3), ['/api/v1/agents/child-hash/policy', 'PUT', 'parent-key']);
  assert.deepEqual(put[3], { version: 1, models: {}, caps: { per_hour_usd: 1, per_day_usd: 2 }, windows: server.windows, on_breach: 'deny' });
  assert.deepEqual(JSON.parse(values.get(CHAT_LIMITS_STORE)).policy, put[3]);
  const before = calls.length;
  await assert.rejects(c.update({ ...form, caps: { ...form.caps, per_week_usd: '-1' } }), /Cap per week/);
  assert.equal(calls.slice(before).some(([, method]) => method === 'PUT'), false);
});

test('the shared editor is used for chat, /agents and every key in the dashboard; Guard keeps its caveat', () => {
  assert.match(source('../components/harness/Limits.jsx'), /<SpendingLimits id="chat" compact/);
  const agents = source('../app/agents/Agents.jsx');
  assert.match(agents, /<SpendingLimits id="rulebook"[^>]* scope guard=/); assert.doesNotMatch(agents, /Kill switch|Kill agent/);
  assert.equal((agents.match(/aria-label="Agent keys"/g) || []).length, 1);
  assert.doesNotMatch(agents, /<Alerts key=\{key\+agent\.key_hash\}/); // the workspace and alerts need distinct keys
  assert.match(source('../components/limits/KeyLimits.jsx'), /<SpendingLimits key=\{revision\} id="key-limits"[^>]* scope guard=/);
  const dashboard = source('../components/Dashboard.jsx');
  assert.match(dashboard, /setModal\(\{ type: "limits", data: k \}\)/); assert.match(dashboard, /<KeyLimits apiKey=\{apiKey\} keyHash=\{modal\.data\.id\}/);
});

test('docs and editor copy say Spending limits and avoid unavailable or banned wording', () => {
  const docs = source('../components/SpendingLimitsDocs.jsx');
  assert.match(docs, /<section id="spending-limits"><h2>Spending limits<\/h2>/); assert.doesNotMatch(docs, /<h[23]>Limits</);
  assert.match(docs, /\{GUARD_LIMIT\}/);
  const banned = new RegExp(String.raw`\b(?:${['de' + 'mo', 'te' + 'st', 'te' + 'sted', 'mo' + 'ck', 'simu' + 'lated', 'place' + 'holder', 'fix' + 'ture', 'lo' + 'cal', 'anony' + 'mous', 'trust' + 'less', 'decen' + 'tralized', 'ea' + 'rn', 'yi' + 'eld', 'A' + 'PY', 'ret' + 'urns', 'pri' + 'vate'].join('|')})\b|no lo` + 'gs', 'i');
  for (const file of ['../components/SpendingLimitsDocs.jsx', '../components/limits/SpendingLimits.jsx', '../components/limits/KeyLimits.jsx', '../components/harness/Limits.jsx', '../lib/spending-limits.js', '../components/limits/RouteDefault.jsx', '../lib/route-default.js']) {
    const copy = source(file).replace(/\bplaceholder=|import[^\n]*\n/g, '');
    assert.doesNotMatch(copy, banned, file);
  }
});
