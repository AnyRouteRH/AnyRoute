import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTICE_ROWS } from '../lib/notifications.js';
import { TASKS } from '../lib/site-map.js';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('Service incidents reuses notification controls, with opt-in schema and discoverable docs', () => {
  assert.ok(NOTICE_ROWS.some(([type, title]) => type === 'status_incidents' && title === 'Service incidents'));
  assert.ok(TASKS.some(task => task.id === 'incident-alerts' && task.href === '/docs/#incident-alerts'));
  assert.match(read('../components/DocsFeatureIndex.jsx'), /\["incident-alerts", "Service incident alerts"\]/);
  assert.match(read('../app/docs/page.jsx'), /<IncidentAlertsDocs \/>/);
  const paths = JSON.parse(read('../public/openapi.json')).paths;
  for (const method of ['get', 'put']) {
    const channels = paths['/api/v1/account/notifications'][method].responses['200'].content['application/json'].schema.properties.data.properties.channels;
    assert.ok(channels.required.includes('status_incidents'));
    assert.equal(channels.properties.status_incidents.properties.inbox.default, false);
    assert.equal(channels.properties.status_incidents.properties.telegram.default, false);
  }
  const docs = read('../components/incident-notices/IncidentAlertsDocs.jsx');
  assert.match(docs, /id="incident-alerts"/); assert.match(docs, /STATUS_INCIDENT_NOTICES_ENABLED defaults to false/);
  assert.match(docs, /Quiet hours hold Telegram/); assert.match(docs, /switched on at anyroute\.tech/);
});
