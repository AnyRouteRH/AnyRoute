import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODEL_WATCH_PATH, readModelWatches, changeModelWatch } from '../lib/model-watch.js';
import { NOTICE_ROWS } from '../lib/notifications.js';
import { TASKS } from '../lib/site-map.js';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('model watch helpers keep ids in strict bodies and send the connected key', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { data: [], limit: 20 }; };
  assert.equal((await readModelWatches(request, { key: 'sample-key' })).limit, 20);
  await changeModelWatch(request, 'sample/model', true, { key: 'sample-key' });
  await changeModelWatch(request, 'sample/model', false, { key: 'sample-key' });
  assert.deepEqual(calls, [[MODEL_WATCH_PATH, { key: 'sample-key' }], [MODEL_WATCH_PATH, { key: 'sample-key', method: 'PUT', body: { model: 'sample/model' } }], [MODEL_WATCH_PATH, { key: 'sample-key', method: 'DELETE', body: { model: 'sample/model' } }]]);
});
test('watch controls use account sign-in, labelled buttons, native menu and narrow layouts', () => {
  const button = source('../components/model-watch/ModelWatchButton.jsx'), settings = source('../components/model-watch/ModelWatchSettings.jsx');
  assert.match(button, /useAccountKey/); assert.match(button, /aria-pressed=/); assert.match(button, /<details><summary>/);
  assert.match(source('../components/ModelPage.jsx'), /<ModelWatchButton model=\{model\}/);
  assert.match(source('../components/ModelCatalog.jsx'), /<ModelWatchMenu model=\{raw\}/);
  assert.match(source('../components/Dashboard.jsx'), /<ModelWatchSettings key=\{apiKey\}/);
  assert.match(settings, /aria-label=\{'Unwatch '/); assert.match(settings, /role="status"/);
  const css = source('../components/model-watch/ModelWatch.module.css'); assert.match(css, /focus-visible/); assert.match(css, /max-width: 420px/); assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});
test('docs, search and notifications describe guarded endpoints and the new channel', () => {
  assert.ok(TASKS.some(task => task.id === 'model-watch')); assert.ok(NOTICE_ROWS.some(row => row[0] === 'model_watch' && row[1] === 'Model watch'));
  assert.match(source('../app/docs/page.jsx'), /<ModelWatchDocs \/>/); assert.match(source('../components/DocsFeatureIndex.jsx'), /\["model-watch", "Model watch"\]/);
  assert.match(source('../components/model-watch/ModelWatchDocs.jsx'), /MODEL_WATCH_ENABLED defaults to false/);
  const spec = JSON.parse(source('../public/openapi.json'));
  for (const method of ['get', 'put', 'delete']) assert.ok(spec.paths[MODEL_WATCH_PATH][method].security[0].BearerAuth);
  const prefs = spec.paths['/api/v1/account/notifications'].put.requestBody.content['application/json'].schema.properties.channels;
  assert.ok(prefs.required.includes('model_watch')); assert.ok(prefs.properties.model_watch);
});
