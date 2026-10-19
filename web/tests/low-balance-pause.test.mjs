// K195: reuse dollar validation, account controls, notifications and Resume all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pauseAmount, readBalancePause, saveBalancePause, LOW_BALANCE_PAUSE_PATH } from '../lib/low-balance-pause.js';
import { NOTICE_ROWS } from '../lib/notifications.js';
import { inboxGroup } from '../lib/inbox-filters.js';
import { TASKS } from '../lib/site-map.js';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('pause starts off and requires a bounded dollar amount only when opted in', () => {
  assert.equal(pauseAmount(false, ''), null); assert.equal(pauseAmount(false, 'invalid'), null);
  for (const text of ['0', '5', '5.25', '1000000']) assert.equal(pauseAmount(true, text), Number(text));
  for (const text of ['', '-1', '1000001', 'five', '0.001']) assert.throws(() => pauseAmount(true, text));
});
test('setting requests use the account path and nullable amount without sending UI state', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { enabled: true, low_balance_usd: 5 }; };
  assert.equal((await readBalancePause(request, { key: 'sample-key' })).low_balance_usd, 5);
  await saveBalancePause(request, true, '5.25', { key: 'sample-key' });
  await saveBalancePause(request, false, '5.25', { key: 'sample-key' });
  assert.deepEqual(calls[1], [LOW_BALANCE_PAUSE_PATH, { key: 'sample-key', method: 'PATCH', body: { low_balance_usd: 5.25 } }]);
  assert.equal(calls[2][1].body.low_balance_usd, null);
});
test('control sits next to Balance alert, uses labelled inputs and existing layout, and links to Resume all and Notifications', () => {
  const dashboard = source('../components/Dashboard.jsx'), ui = source('../components/runway/LowBalancePauseSetting.jsx');
  assert.match(dashboard, /<LowBalanceSetting[^\n]+\n[^\n]+<LowBalancePauseSetting/);
  for (const text of ['useState(false)', 'type="checkbox"', 'htmlFor={id}', 'inputMode="decimal"', 'aria-describedby=', 'role="alert"', 'role="status"', 'Runway.module.css', 'AbortController']) assert.ok(ui.includes(text), text);
  assert.match(ui, /Pause my agents when my balance falls below \$/); assert.match(ui, /\/dashboard\/#notifications/); assert.match(ui, /\/agents\/\?command=resume-all/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage|#[0-9a-f]{3,8}\b|rgba?\(/i);
});
test('docs, search, OpenAPI and notice groups describe the feature and its guards', () => {
  assert.ok(NOTICE_ROWS.some(([kind]) => kind === 'low_balance_pause')); assert.equal(inboxGroup('low_balance_pause'), 'agents');
  assert.ok(TASKS.some(task => task.id === 'low-balance-pause' && task.href === '/dashboard/#payments'));
  assert.match(source('../components/DocsFeatureIndex.jsx'), /\["low-balance-pause",/);
  assert.match(source('../app/docs/page.jsx'), /<LowBalancePauseDocs \/>/);
  const docs = source('../components/LowBalancePauseDocs.jsx');
  for (const text of ['id="low-balance-pause"', 'defaults false', 'latest 100', 'Ordinary request text is still read', 'strictly above', 'equality']) assert.ok(docs.toLowerCase().includes(text.toLowerCase()), text);
  const api = JSON.parse(source('../public/openapi.json')), path = api.paths[LOW_BALANCE_PAUSE_PATH];
  for (const method of ['get', 'patch']) {
    assert.ok(path[method].security.length);
    for (const security of path[method].security) for (const name of Object.keys(security)) assert.ok(api.components.securitySchemes[name], name);
  }
  assert.match(api.paths['/api/v1/inbox'].get['x-k195-low-balance-pause'], /low_balance_pause/);
  assert.deepEqual(path.patch.requestBody.content['application/json'].schema.required, ['low_balance_usd']);
  const channels = api.paths['/api/v1/account/notifications'].put.requestBody.content['application/json'].schema.properties.channels;
  assert.ok(channels.required.includes('low_balance_pause')); assert.ok(channels.properties.low_balance_pause);
});
