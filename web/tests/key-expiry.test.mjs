// C127
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXPIRY_OPTIONS, EXPIRY_WARNING, earliestExpiryDate, expiryAllowed, expiryIso, expiryKeyFields, expiryPatch, expiryText, keyHasExpired, localExpiryDate, withKeyExpiry } from '../lib/key-expiry.js';
import { KeyExpiryFields, KeyExpiryStatus, KeyExpiryRestore } from '../components/account/KeyExpiry.js';
import { searchAll } from '../lib/site-actions.js';

const DAY = 86_400_000, now = new Date(2030, 0, 1, 12).getTime();
const iso = days => new Date(now + days * DAY).toISOString();
const owner = { management: true }, existing = { team: null, expiresAt: iso(3) };
const source = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('presets use submission time, Never clears expiry, dates use browser midnight', () => {
  assert.deepEqual(EXPIRY_OPTIONS.map(row => row[1]), ['Never', 'in 1 day', 'in 7 days', 'in 30 days', 'on a date']);
  for (const days of [1, 7, 30]) assert.equal(expiryIso(String(days), '', now), iso(days));
  assert.equal(expiryIso('never', '', now), null);
  assert.equal(expiryIso('date', '2030-01-04', now), new Date(2030, 0, 4).toISOString());
  for (const date of ['', 'invalid', '2030-02-30', '2030-01-01', '2029-12-31']) assert.throws(() => expiryIso('date', date, now), /Choose a future date/);
  assert.throws(() => expiryIso('unknown', '', now), /Choose a future date/);
  assert.equal(localExpiryDate(iso(3)), '2030-01-04');
  assert.equal(earliestExpiryDate(new Date(2030, 2, 9, 23, 30).getTime()), '2030-03-10');
});

test('unchanged expiry stays exact; team controls and signed-out creation stay off', () => {
  const options = { choice: 'date', date: '2030-01-04', existing, caller: owner, now };
  assert.deepEqual(expiryPatch({ ...options, changed: false }), {});
  assert.deepEqual(expiryPatch({ ...options, changed: true }), { expires_at: new Date(2030, 0, 4).toISOString() });
  assert.deepEqual(expiryPatch({ ...options, changed: true, choice: 'never' }), { expires_at: null });
  assert.equal(expiryAllowed({ team: 'team-one' }, owner), false);
  assert.equal(expiryAllowed(null, { team: 'team-one', management: false }), false);
  assert.equal(expiryAllowed(null, owner), true);
  assert.equal(expiryAllowed(null, null), false);
  assert.deepEqual(expiryPatch({ ...options, existing: { team: 'team-one' }, changed: true }), {});
});

test('status labels use calendar days and expired rows are inactive, without changing disabled', () => {
  assert.equal(expiryText(iso(3), now), 'Expires in 3 days');
  assert.equal(expiryText(iso(1), now), 'Expires in 1 day');
  assert.equal(expiryText(new Date(now + 1).toISOString(), now), 'Expires today');
  assert.equal(expiryText(iso(0), now), 'Expired');
  assert.equal(expiryText(iso(-1), now), 'Expired');
  for (const value of [null, undefined, 'invalid']) assert.equal(expiryText(value, now), '');
  assert.equal(keyHasExpired(iso(0), now), true);
  const row = { disabled: false, expires_at: iso(-1), team: null };
  assert.equal(expiryKeyFields(row, now).active, false);
  assert.equal(row.disabled, false);
  assert.equal(expiryKeyFields({ disabled: false, expires_at: null }, now).active, true);
  assert.equal(expiryKeyFields({ disabled: true, expires_at: iso(3) }, now).active, false);
  // A daylight-saving transition does not turn three calendar days into two.
  assert.equal(expiryText(new Date(2030, 2, 11, 12).toISOString(), new Date(2030, 2, 8, 12).getTime()), 'Expires in 3 days');
});

test('existing request keeps auth and budget; expiry is ISO/null only when edited', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { data: {} }; };
  const options = { key: 'sample-key', method: 'POST', body: { name: 'Work key', limit: 10 } };
  await withKeyExpiry(request, { expires_at: iso(7) })('/api/v1/keys', options);
  assert.deepEqual(calls[0], ['/api/v1/keys', { ...options, body: { ...options.body, expires_at: iso(7) } }]);
  const edit = { key: 'sample-key', method: 'PATCH', body: { name: 'Renamed' } };
  await withKeyExpiry(request, { expires_at: null })('/api/v1/keys/sample-hash', edit);
  assert.deepEqual(calls[1][1].body, { name: 'Renamed', expires_at: null });
  await withKeyExpiry(request, {})('/api/v1/keys', options);
  assert.equal(calls[2][1], options);
});

test('accessible controls warn for this browser, and expired cards offer expiry editing', () => {
  let picked, date;
  const controls = KeyExpiryFields({ choice: 'date', date: '2030-01-04', current: true, now, onChoice: value => { picked = value; }, onDate: value => { date = value; } });
  const html = renderToStaticMarkup(controls);
  assert.match(html, /label for="key-expiry">Expires/);
  assert.match(html, /aria-describedby="key-expiry-warning"/);
  assert.match(html, /type="date".*required/);
  assert.ok(html.includes(EXPIRY_WARNING));
  controls.props.children[1].props.onChange({ target: { value: '7' } });
  controls.props.children[2].props.children[1].props.onChange({ target: { value: '2030-01-05' } });
  assert.equal(picked, '7'); assert.equal(date, '2030-01-05');
  assert.ok(!renderToStaticMarkup(h(KeyExpiryFields, { choice: 'never', current: false })).includes(EXPIRY_WARNING));
  // Renaming a key expiring today or already expired preserves its exact deadline.
  assert.ok(!renderToStaticMarkup(h(KeyExpiryFields, { choice: 'date', date: '2030-01-01', edited: false, now })).includes('min='));
  const children = h('span', null, 'Active');
  assert.equal(renderToStaticMarkup(h(KeyExpiryStatus, { value: null, now }, children)), '<span>Active</span>');
  assert.match(renderToStaticMarkup(h(KeyExpiryStatus, { value: iso(3), now }, children)), /Active.*Expires in 3 days/);
  assert.equal(renderToStaticMarkup(h(KeyExpiryStatus, { value: iso(-1), now }, children)), '<div class="key-expiry-status"><span class="badge">Expired · switched off</span></div>');
  let edited = false;
  const restore = KeyExpiryRestore({ value: iso(-1), now, onEdit: () => { edited = true; } });
  restore.props.onClick(); assert.equal(edited, true);
  assert.match(renderToStaticMarkup(restore), /Change expiry/);
  assert.equal(KeyExpiryRestore({ value: iso(-1), now, team: 'team-one' }), null);
});

test('dashboard integration stays additive; docs and OpenAPI describe existing expiry', () => {
  const dashboard = source('../components/Dashboard.jsx');
  for (const text of ['const expiry = useKeyExpiry(existing, live)', '{expiry.fields}', '...expiryKeyFields(k, expiryNow)', 'withKeyExpiry(accountKeyRequest, values)', '<KeyExpiryContext.Provider value={ws?.me}>', '<KeyExpiryStatus', '<KeyExpiryRestore']) assert.ok(dashboard.includes(text));
  assert.match(source('../app/docs/page.jsx'), /<KeyExpiryDocs \/>/);
  assert.match(source('../components/KeyExpiryDocs.jsx'), /id="key-expiry"/);
  assert.match(source('../components/DocsFeatureIndex.jsx'), /\["key-expiry", "Keys that expire"\]/);
  assert.ok(searchAll('key expiry').some(item => item.href === '/docs/#key-expiry'));
  const schemas = JSON.parse(source('../public/openapi.json')).components.schemas;
  for (const schema of ['Key', 'KeyCreateRequest']) {
    assert.equal(schemas[schema].properties.expires_at.format, 'date-time');
    assert.deepEqual(schemas[schema].properties.expires_at.type, ['string', 'null']);
  }
});
