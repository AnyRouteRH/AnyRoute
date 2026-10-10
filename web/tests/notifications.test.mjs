import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTICE_ROWS, localToUtc, utcToLocal, readNotifications, saveNotifications, NOTIFICATION_PATH } from '../lib/notifications.js';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS, TASKS } from '../lib/site-map.js';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('local clock conversion handles offsets, midnight, half-hour zones and validates input', () => {
  for (const offset of [0, 240, -330, -765, 480]) for (const time of ['00:00', '08:00', '22:30', '23:59']) assert.equal(utcToLocal(localToUtc(time, offset), offset), time);
  assert.equal(localToUtc('22:00', 240), '02:00'); assert.equal(utcToLocal('02:00', 240), '22:00');
  assert.equal(localToUtc('08:00', -330), '02:30');
  assert.throws(() => localToUtc('24:00')); assert.throws(() => utcToLocal('bad'));
});
test('request helpers save only the two documented settings fields', async () => {
  const calls = [], value = { channels: {}, quiet_hours: null, telegram_linked: true };
  const request = async (...args) => { calls.push(args); return { data: value }; };
  assert.equal(await readNotifications(request, { key: 'sample-key' }), value);
  assert.equal(await saveNotifications(request, value, { key: 'sample-key' }), value);
  assert.deepEqual(calls[1], [NOTIFICATION_PATH, { key: 'sample-key', method: 'PUT', body: { channels: {}, quiet_hours: null } }]);
});
test('all ten rows are discoverable under account Settings and documented in OpenAPI', () => {
  assert.equal(NOTICE_ROWS.length, 10); assert.equal(new Set(NOTICE_ROWS.map(row => row[0])).size, 10);
  assert.ok(ACCOUNT_GROUPS.find(group => group.id === 'settings').ids.includes('notifications'));
  assert.equal(ACCOUNT_SECTIONS.find(section => section.taskId === 'notifications').href, '/dashboard/#notifications');
  assert.ok(TASKS.some(task => task.id === 'notifications'));
  const path = JSON.parse(source('../public/openapi.json')).paths[NOTIFICATION_PATH];
  assert.ok(path.get.security.length && path.put.security.length);
  assert.deepEqual(path.put.requestBody.content['application/json'].schema.properties.channels.required, NOTICE_ROWS.map(row => row[0]));
  assert.match(source('../app/docs/page.jsx'), /<NotificationSettingsDocs \/>/);
  assert.match(source('../components/DocsFeatureIndex.jsx'), /\["notifications", "Notifications"\]/);
});
test('controls use labelled keyboard switches, link hints, local times and theme tokens', () => {
  const ui = source('../components/notifications/AccountNotifications.jsx'), css = source('../components/notifications/Notifications.module.css');
  assert.match(ui, /role="switch" aria-label=/); assert.match(ui, /aria-describedby=/); assert.match(ui, /!value.telegram_linked/);
  assert.match(ui, /type="time"/); assert.match(ui, /localToUtc\(from\)/); assert.match(ui, /role="status"/);
  assert.match(css, /focus-visible/); assert.match(css, /max-width: 420px/); assert.match(css, /var\(--night\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});
