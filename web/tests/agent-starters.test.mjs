import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTER_RULEBOOKS, applyStarter, starterSettings } from '../lib/agent-starters.js';
import { buildPolicy, policyForm } from '../lib/agents.js';
import { checkSelectedRequest } from '../lib/agent-request-check.js';
import { TASKS, menuTasks } from '../lib/site-map.js';

const secret = 'sk-ar-v1-' + 'a'.repeat(64);
const form = { model: 'author/model', lane: 'attested', cost: '0.123456789123', tokens: '512', tools: 'lookup, read' };

test('nine distinct starters show every setting and preserve all restrictions through the editor', () => {
  assert.equal(STARTER_RULEBOOKS.length, 9);
  assert.equal(new Set(STARTER_RULEBOOKS.map(template => template.id)).size, 9);
  for (const template of STARTER_RULEBOOKS) {
    assert.deepEqual(buildPolicy(policyForm(template.policy)), { policy: template.policy, errors: [] });
    assert.equal(starterSettings(template.policy).length, 12);
    // Trading agents run on platforms that declare their own tools; every other starter denies declared tools.
    if (template.id.startsWith('trading-')) assert.equal(template.policy.tools, undefined);
    else assert.deepEqual(template.policy.tools, { allow: [] });
    assert.ok(template.policy.caps.per_request_usd > template.policy.approval.above_usd);
    assert.equal(template.policy.autonomy, undefined);
  }
  const editor = policyForm(STARTER_RULEBOOKS[0].policy);
  editor.toolAllow = 'lookup';
  assert.deepEqual(buildPolicy(editor).policy.tools, { allow: ['lookup'] });
  editor.restrictTools = false; editor.toolAllow = '';
  assert.equal(buildPolicy(editor).policy.tools, undefined);
});

test('trading starters: a model allowlist, a daily model budget and an ask-first call count survive the editor', () => {
  const byId = Object.fromEntries(STARTER_RULEBOOKS.map(template => [template.id, template.policy]));
  assert.deepEqual(byId['trading-allowlist'].models, { allow: ['anthropic/*', 'openai/*', 'google/*'] });
  assert.equal(byId['trading-budget'].caps.per_day_usd, 5);
  assert.equal(byId['trading-ask-first'].approval.above_calls_per_hour, 60);
  const settings = Object.fromEntries(starterSettings(byId['trading-ask-first']));
  assert.match(settings['Ask first'], /after 60 model calls in a rolling hour/);
  assert.match(settings.Tools, /not restricted/);
  const form = policyForm(byId['trading-ask-first']);
  assert.equal(form.approvalCalls, '60');
  form.approvalCalls = '2.5';
  assert.ok(buildPolicy(form).errors.some(error => /whole number/.test(error)));
  form.approvalCalls = '10'; form.approval = '';
  assert.ok(buildPolicy(form).errors.some(error => /approval amount/.test(error)));
  form.approvalCalls = '';
  assert.equal(buildPolicy(form).policy.approval, undefined);
});

test('apply uses only the existing scoped PUT with a fresh copy of exactly the selected policy', async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return { data: {} }; };
  await applyStarter(request, 'key/one', STARTER_RULEBOOKS[0]);
  assert.deepEqual(calls, [['/api/v1/agents/key%2Fone/policy', { method: 'PUT', body: STARTER_RULEBOOKS[0].policy }]]);
  assert.notEqual(calls[0][1].body, STARTER_RULEBOOKS[0].policy);
  await assert.rejects(applyStarter(request, '', STARTER_RULEBOOKS[0]));
  assert.equal(calls.length, 1);
});

for (const decision of ['allow', 'approval_required', 'deny']) test(`request form preserves the router’s ${decision} decision and reasons without inference`, async () => {
  const calls = [];
  const reasons = [{ code: 'new_reason', message: 'Router reason verbatim.' }];
  const request = async (path, options) => { calls.push([path, options]); return path.endsWith('/me') ? { data: { key_hash: 'selected' } } : { data: { decision, reasons } }; };
  assert.deepEqual(await checkSelectedRequest('selected', secret, form, request), { decision, reasons });
  assert.deepEqual(calls, [
    ['/api/v1/agents/me', { key: secret, signal: undefined }],
    ['/api/v1/agents/check', { key: secret, signal: undefined, method: 'POST', body: { kind: 'inference', model: 'author/model', lane: 'attested', est_cost_pico: '123456789123', max_output_tokens: 512, tools: ['lookup', 'read'] } }],
  ]);
});

test('invalid input sends nothing and a different agent key never reaches the check endpoint', async () => {
  const calls = [];
  const request = async path => { calls.push(path); return { data: { key_hash: 'another' } }; };
  for (const args of [['selected', '', form], ['', secret, form], ['selected', secret, { ...form, cost: '-1' }]]) await assert.rejects(checkSelectedRequest(...args, request));
  assert.deepEqual(calls, []);
  await assert.rejects(checkSelectedRequest('selected', secret, form, request), /different agent/);
  assert.deepEqual(calls, ['/api/v1/agents/me']);
});

test('errors and invalid response shapes are not reported as an allowed request; cancellation is forwarded', async () => {
  const controller = new AbortController();
  const request = async (path, options) => { assert.equal(options.signal, controller.signal); return path.endsWith('/me') ? { data: { key_hash: 'selected' } } : { data: { decision: 'unknown', reasons: [] } }; };
  await assert.rejects(checkSelectedRequest('selected', secret, form, request, controller.signal), /could not be read/);
  await assert.rejects(checkSelectedRequest('selected', secret, form, async () => { throw new Error('Permission denied'); }), /Permission denied/);
});

test('both tools use the agents map and stay search-only within the menu limit', () => {
  for (const id of ['starter-setups', 'request-check']) { // U103: Start from a setup replaces the rulebook templates entry.
    const task = TASKS.find(item => item.id === id);
    assert.equal(task.group, 'agents'); assert.equal(task.menu, false);
    assert.equal(task.href, '/agents/#' + id);
  }
  assert.ok(menuTasks('agents').length <= 9);
});
