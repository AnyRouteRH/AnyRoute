import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QUIET_OPTIONS, quietAlertPath, quietChoice, quietSetting } from '../lib/quiet-agent-alerts.js';
import { TASKS } from '../lib/site-map.js';

test('quiet choices include Off and the supported hour windows; invalid responses never become Off', () => {
  assert.deepEqual(QUIET_OPTIONS, [null, 1, 3, 6, 12, 24, 72]);
  assert.equal(quietChoice('off'), null);
  for (const hours of QUIET_OPTIONS) assert.equal(quietSetting({ data: { hours } }), hours);
  for (const response of [{}, { data: {} }, { data: { hours: 0 } }, { data: { hours: '6' } }]) assert.throws(() => quietSetting(response));
  assert.equal(quietChoice('6'), 6);
  assert.equal(quietAlertPath('sample/key'), '/api/v1/agents/sample%2Fkey/quiet-alert');
});
test('row controls are separate from the row button, labelled, and discard disconnected requests', () => {
  const rows = readFileSync(new URL('../app/agents/Agents.jsx', import.meta.url), 'utf8');
  assert.match(rows, /<\/button><SealedBadge[^>]+\/><QuietAgentAlert/);
  const control = readFileSync(new URL('../components/QuietAgentAlert.jsx', import.meta.url), 'utf8');
  assert.match(control, /htmlFor=\{id\}/); assert.match(control, /<select id=\{id\}/);
  assert.match(control, /disabled=\{!state.ready \|\| state.busy\}/);
  assert.match(control, /return \(\) => ac.abort\(\)/);
  assert.match(control, /error.status === 404/);
  const css = readFileSync(new URL('../components/QuietAgentAlert.module.css', import.meta.url), 'utf8');
  assert.match(css, /flex-wrap: wrap/); assert.match(css, /focus-visible/); assert.match(css, /min-height: 44px/);
});
test('quiet alerts have a docs section, index/search entry and authenticated API specification', () => {
  assert.equal(TASKS.find(task => task.id === 'quiet-agent-alerts').href, '/docs/#quiet-agent-alerts');
  const docs = readFileSync(new URL('../components/QuietAgentAlertsDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /id="quiet-agent-alerts"/); assert.match(docs, /defaults to/); assert.match(docs, /not switched on yet/);
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  const endpoint = spec.paths['/api/v1/agents/{key_hash}/quiet-alert'];
  for (const method of ['get', 'put']) {
    assert.deepEqual(endpoint[method].security, [{ BearerAuth: [] }]);
    for (const code of ['200', '401', '403', '404']) assert.ok(endpoint[method].responses[code]);
  }
});
