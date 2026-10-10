// E149
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { READ_ONLY_LABEL, readScopeSelectable, withReadScope } from '../lib/read-only-keys.js';
import { withKeyExpiry } from '../lib/key-expiry.js';
import { TASKS } from '../lib/site-map.js';

test('only management owners can select read scope', () => {
  assert.equal(readScopeSelectable({ management: true, scope: 'account' }), true);
  for (const caller of [null, {}, { management: false }, { management: true, scope: 'read' }]) assert.equal(readScopeSelectable(caller), false);
  assert.equal(READ_ONLY_LABEL, "Read only: can see activity and statements, can't spend or change anything");
});
test('read scope composes with expiry and preserves existing requests', async () => {
  const request = (path, options) => ({ path, options });
  const options = { method: 'POST', body: { name: 'Accounting', limit: 10 } };
  assert.equal(withReadScope(request, {})('/api/v1/keys', options).options, options);
  assert.equal(withReadScope(request, { scope: 'read' })('/api/v1/keys/sample', options).options, options);
  const api = withKeyExpiry(withReadScope(request, { scope: 'read' }), { expires_at: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(api('/api/v1/keys', options).options.body, { ...options.body, scope: 'read', expires_at: '2027-01-01T00:00:00.000Z' });
});
test('badge and accessible control are integrated in Keys and docs are searchable', () => {
  const component = readFileSync(new URL('../components/account/ReadOnlyKeys.jsx', import.meta.url), 'utf8');
  assert.match(component, /<label[^>]*>.*<input type="checkbox"/);
  assert.match(component, /value === 'read'.*Read only/);
  const dashboard = readFileSync(new URL('../components/Dashboard.jsx', import.meta.url), 'utf8');
  for (const needle of ['readOnly.fields', 'readOnly.wrapSave', 'ReadOnlyKeyBadge', 'withReadScope']) assert.ok(dashboard.includes(needle));
  const docs = readFileSync(new URL('../app/docs/page.jsx', import.meta.url), 'utf8');
  assert.match(docs, /<ReadOnlyKeysDocs \/>/);
  assert.ok(TASKS.some(task => task.href === '/docs/#read-only-keys'));
  const openapi = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url)));
  assert.ok(openapi['x-e149-read-only-keys'].scope_values.includes('read'));
});
