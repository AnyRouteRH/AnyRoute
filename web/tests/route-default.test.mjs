import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildPolicy, policyForm } from '../lib/agents.js';
import { STARTER_RULEBOOKS, starterSettings } from '../lib/agent-starters.js';
import { ROUTE_DEFAULTS, ROUTE_DEFAULT_OPTIONS, ROUTE_DEFAULT_FIRST_NOTE, routeDefaultConflict, routeDefaultForm } from '../lib/route-default.js';

// U101: the rulebook's default route for requests that name no lane.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const base = { version: 1, models: {}, caps: {}, on_breach: 'deny' };

test('the three settings use the site terms, and standard is the default', () => {
  assert.deepEqual(ROUTE_DEFAULTS, ['standard', 'proven_first', 'proven_only']);
  assert.deepEqual(ROUTE_DEFAULT_OPTIONS.map(o => o.label), ['Standard provider', 'Proven hardware first', 'Proven hardware only']);
  assert.equal(routeDefaultForm(null), 'standard');
  assert.equal(routeDefaultForm({ route_default: 'proven_first' }), 'proven_first');
  assert.equal(routeDefaultForm({ route_default: 'something else' }), 'standard');
  assert.match(ROUTE_DEFAULT_FIRST_NOTE, /standard provider answers and the receipt and label show the standard route/);
});

test('standard leaves the rulebook exactly as it was; the other settings round-trip through the editor', () => {
  assert.deepEqual(buildPolicy(policyForm(null)), { policy: base, errors: [] });
  assert.deepEqual(buildPolicy(policyForm({ ...base, route_default: 'standard' })), { policy: base, errors: [] });
  for (const route_default of ['proven_first', 'proven_only']) {
    const policy = { ...base, lanes: ['public', 'attested'], route_default };
    assert.deepEqual(buildPolicy(policyForm(policy)), { policy, errors: [] });
  }
  const form = { ...policyForm(null), routeDefault: 'proven_only' };
  assert.equal(buildPolicy(form).policy.route_default, 'proven_only');
  assert.match(buildPolicy({ ...form, routeDefault: 'attested' }).errors.join(' '), /Default route: choose/);
});

test('the editor says when the lane allowlist is stricter than the chosen default', () => {
  assert.equal(routeDefaultConflict('standard', true, []), '');
  assert.equal(routeDefaultConflict('proven_only', false, []), '');
  assert.equal(routeDefaultConflict('proven_only', true, ['attested']), '');
  assert.match(routeDefaultConflict('proven_only', true, ['public']), /leave out attested, so requests that name no lane will be refused/);
  assert.match(routeDefaultConflict('proven_first', true, ['public']), /will use a standard provider/);
  assert.match(routeDefaultConflict('proven_first', true, ['unlinkable']), /leave out attested and public/);
  assert.match(routeDefaultConflict('proven_first', true, ['attested']), /leave out public, so a request whose model has no proven endpoint will be refused/);
  assert.equal(routeDefaultConflict('proven_first', true, ['public', 'attested']), '');
});

test('the shared spending limits editor shows the setting next to the lanes, on /agents and API keys', () => {
  const editor = read('components/limits/SpendingLimits.jsx');
  assert.ok(editor.indexOf('{W.lanesHelp}') < editor.indexOf('<RouteDefault '));
  for (const file of ['app/agents/Agents.jsx', 'components/limits/KeyLimits.jsx']) assert.match(read(file), /<SpendingLimits [^>]*\bscope\b/, file);
  const field = read('components/limits/RouteDefault.jsx');
  for (const phrase of ['<legend>Default route</legend>', 'ROUTE_DEFAULT_FIRST_NOTE', 'type="radio"', 'A lane the request names always wins', 'embeddings, rerank and document questions']) assert.ok(field.includes(phrase), phrase);
});

test('the Proven hardware only starter keeps its allowlist and sends requests that name no lane to proven hardware', () => {
  const starter = STARTER_RULEBOOKS.find(t => t.id === 'private');
  assert.deepEqual(starter.policy.lanes, ['attested']);
  assert.equal(starter.policy.route_default, 'proven_only');
  assert.deepEqual(buildPolicy(policyForm(starter.policy)), { policy: starter.policy, errors: [] });
  assert.deepEqual(Object.fromEntries(starterSettings(starter.policy)).Lanes, 'attested; requests that name no lane: proven hardware only');
  for (const other of STARTER_RULEBOOKS.filter(t => t.id !== 'private')) assert.equal(other.policy.route_default, undefined, other.id);
});

test('the documentation section names the field, the settings, the refusal and the honest fallback', () => {
  const source = read('components/DefaultRouteDocs.jsx');
  const js = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement"}}}).transformSync(await Bun.stdin.text()));'], { input: source, encoding: 'utf8' });
  const DefaultRouteDocs = new Function('React', js.replace('export default function DefaultRouteDocs', 'function DefaultRouteDocs') + '\nreturn DefaultRouteDocs;')({ createElement });
  const html = renderToStaticMarkup(createElement(DefaultRouteDocs));
  assert.ok(html.includes('id="default-route"'));
  for (const phrase of ['route_default', 'Standard provider', 'Proven hardware first', 'Proven hardware only', 'no_attested_endpoint', 'lane_not_allowed', 'never as proven hardware', 'X-Anyroute-Default-Route', 'AGENT_POLICY_ENABLED', 'embeddings, rerank and document questions', 'no chunk reaches a standard provider']) assert.ok(html.includes(phrase), phrase);
  assert.doesNotMatch(html.replace(/<code>[^<]*<\/code>/g, ''), /\b(?:demo|test|tested|mock|simulated|placeholder|fixture|local|anonymous|trustless|decentralized|earn|yield|APY|returns|private)\b|no logs|can[’']t read your prompt/i);
});
