import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSecurityAlerts, saveSecurityAlerts } from '../lib/security-alerts.js';
test('security alerts read and save a strict preference with the current account key', async () => {
  const calls = [], signal = new AbortController().signal;
  const request = async (path, options) => { calls.push([path, options]); return { data: { enabled: options.body?.enabled ?? true } }; };
  assert.equal((await readSecurityAlerts(request, { key: 'sample-key', signal })).enabled, true);
  assert.equal((await saveSecurityAlerts(request, false, { key: 'sample-key' })).enabled, false);
  assert.equal((await saveSecurityAlerts(request, true, { key: 'sample-key' })).enabled, true);
  assert.deepEqual(calls, [['/api/v1/account/security-alerts', { key: 'sample-key', signal }], ['/api/v1/account/security-alerts', { key: 'sample-key', method: 'PATCH', body: { enabled: false } }], ['/api/v1/account/security-alerts', { key: 'sample-key', method: 'PATCH', body: { enabled: true } }]]);
});
test('invalid settings and API failures remain visible to callers', async () => {
  await assert.rejects(() => readSecurityAlerts(async () => ({ data: {} })), /could not be read/);
  await assert.rejects(() => saveSecurityAlerts(async () => {}, 'false'), /Choose whether/);
  for (const status of [401, 403, 404]) {
    const error = Object.assign(new Error('Unavailable'), { status });
    await assert.rejects(() => readSecurityAlerts(async () => { throw error; }), result => result === error);
  }
});
test('security alert settings, docs, search and OpenAPI describe the same feature', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const settings = read('../components/security-alerts/SecurityAlertsSettings.jsx');
  assert.match(settings, /type="checkbox"/); assert.match(settings, /disabled=\{busy\}/); assert.match(settings, /role="alert"/);
  assert.match(read('../components/security-alerts/SecurityAlertsDocs.jsx'), /id="security-alerts"/);
  assert.match(read('../components/DocsFeatureIndex.jsx'), /\["security-alerts", "Security alerts"\]/);
  assert.match(read('../lib/site-map.js'), /task\("security-alerts"/);
  const spec = JSON.parse(read('../public/openapi.json'));
  for (const method of ['get', 'patch']) assert.deepEqual(spec.paths['/api/v1/account/security-alerts'][method].security, [{ BearerAuth: [] }]);
  assert.match(spec.paths['/api/v1/inbox'].get['x-D138-security-alerts'], /team owners\/admins see only their team/);
});
