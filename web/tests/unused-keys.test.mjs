import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import KeyLastUsed from '../components/account/KeyLastUsed.js';
import { lastUsedText, unusedKeys, unusedKeysNotice, switchOffUnusedKeys } from '../lib/unused-keys.js';
import { searchAll } from '../lib/site-actions.js';

const now = Date.now(), DAY = 86_400_000;
const ago = days => new Date(now - days * DAY).toISOString();
const row = (hash, fields = {}) => ({ hash, name: hash, disabled: false, created_at: ago(90), last_used: ago(31), ...fields });
const source = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('30 full days is inclusive; recent, disabled and unknown timestamps are excluded', () => {
  const keys = [row('boundary', { last_used: ago(30) }), row('just-recent', { last_used: new Date(now - 30 * DAY + 1).toISOString() }),
    row('recent', { last_used: ago(3) }), row('off', { disabled: true }), row('invalid', { last_used: 'invalid' }), row('future', { last_used: ago(-2) })];
  assert.deepEqual(unusedKeys(keys, 'browser', now).map(key => key.hash), ['boundary']);
});

test('never-used keys age from creation, including management keys', () => {
  const keys = [row('old-never', { last_used: null, created_at: ago(30) }), row('new-never', { last_used: null, created_at: ago(29) }),
    row('manager', { management: true }), row('unknown-never', { last_used: null, created_at: null })];
  assert.deepEqual(unusedKeys(keys, 'browser', now).map(key => key.hash), ['old-never', 'manager']);
});

test("this browser's key is always excluded and unknown current key fails closed", () => {
  const keys = [row('browser', { management: true, last_used: null }), row('other')];
  assert.deepEqual(unusedKeys(keys, 'browser', now).map(key => key.hash), ['other']);
  assert.deepEqual(unusedKeys(keys, null, now), []);
  assert.deepEqual(unusedKeys([], 'browser', now), []);
  assert.equal(unusedKeysNotice(3), "3 keys haven't made a call in 30 days.");
  assert.equal(unusedKeysNotice(1), "1 key hasn't made a call in 30 days.");
});

test('Last used is relative, and the current-key label renders as plain text', () => {
  assert.equal(lastUsedText(null, now), 'Never');
  assert.equal(lastUsedText(ago(3), now), '3 days ago');
  assert.equal(lastUsedText(ago(1), now), '1 day ago');
  assert.equal(lastUsedText(ago(0), now), 'Today');
  assert.equal(lastUsedText('invalid', now), 'Unknown');
  assert.match(renderToStaticMarkup(h(KeyLastUsed, { value: null, current: true, now })), /Last call: Never.*This browser&#x27;s key/);
  assert.match(renderToStaticMarkup(h(KeyLastUsed, { value: ago(3), now })), /<time dateTime="[^"]+" title="[^"]+">3 days ago<\/time>/);
});

test('one explicit confirmation is required before any disable request', async () => {
  const calls = [], changed = [];
  const request = async (...args) => { calls.push(args); };
  const options = { keys: [row('one'), row('two'), row('browser')], currentHash: 'browser', selected: ['one', 'two', 'browser', 'unlisted'] };
  await assert.rejects(switchOffUnusedKeys(request, options), /Confirm/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await switchOffUnusedKeys(request, { ...options, confirmed: true }, hash => changed.push(hash)), { disabled: ['one', 'two'], failed: [] });
  assert.deepEqual(calls, [['/api/v1/keys/one', { method: 'DELETE' }], ['/api/v1/keys/two', { method: 'DELETE' }]]);
  assert.deepEqual(changed, ['one', 'two']);
});

test('confirmation rechecks eligibility and partial failures preserve successful changes', async () => {
  const calls = [], changed = [];
  const keys = [row('first'), row('forbidden'), row('key/hash', { management: true }), row('recent', { last_used: ago(1) }), row('off', { disabled: true })];
  const outcome = await switchOffUnusedKeys(async (path, options) => {
    calls.push([path, options]); if (path.endsWith('forbidden')) throw new Error('Access denied.');
  }, { keys, currentHash: 'browser', selected: keys.map(key => key.hash), confirmed: true }, hash => changed.push(hash));
  assert.deepEqual(outcome, { disabled: ['first', 'key/hash'], failed: [{ hash: 'forbidden', name: 'forbidden', message: 'Access denied.' }] });
  assert.deepEqual(changed, ['first', 'key/hash']);
  assert.deepEqual(calls.map(([path]) => path), ['/api/v1/keys/first', '/api/v1/keys/forbidden', '/api/v1/keys/key%2Fhash']);
});

test('empty or signed-out selections cannot disable anything', async () => {
  const request = async () => assert.fail('Unexpected request');
  for (const options of [{ keys: [], currentHash: 'browser', selected: ['one'] }, { keys: [row('one')], currentHash: null, selected: ['one'] }, { keys: [row('one')], currentHash: 'browser', selected: [] }]) {
    assert.deepEqual(await switchOffUnusedKeys(request, { ...options, confirmed: true }), { disabled: [], failed: [] });
  }
});

test('account UI wires a checkbox review to one modal, authenticated requests, and refresh', () => {
  const component = source('../components/account/AccountUnusedKeys.jsx');
  assert.match(component, /type="checkbox" checked=\{selected\.includes\(key\.hash\)\}/);
  assert.match(component, /onClick=\{\(\) => setConfirm\(picked\.map\(key => key\.hash\)\)\}/);
  assert.match(component, /\{confirm && <Modal title="Switch off selected keys\?" onClose=\{close\}>/);
  assert.match(component, /onClick=\{switchOff\}/);
  assert.match(component, /api\(path, \{ \.\.\.options, key: apiKey \}\)/);
  assert.match(component, /await onChanged\?\.\(\)/);
  assert.match(component, /if \(!apiKey \|\| !currentHash\) return null/);
  const dashboard = source('../components/Dashboard.jsx');
  assert.match(dashboard, /live && !ws\?\.keysError && <AccountUnusedKeys key=\{apiKey\}/);
  assert.match(dashboard, /<KeyLastUsed value=\{ws\?\.keys\?\.find\(key => key\.hash === k\.id\)\?\.last_used\} current=\{k\.current\}/);
});

test('docs and search describe existing fields and the charged-call limit', () => {
  assert.match(source('../components/UnusedKeysDocs.jsx'), /Last used records a charged call/);
  assert.match(source('../app/docs/page.jsx'), /<UnusedKeysDocs \/>/);
  assert.match(source('../components/DocsFeatureIndex.jsx'), /\["unused-keys", "Review unused keys"\]/);
  assert.ok(searchAll('unused keys').some(item => item.href === '/dashboard/#api-keys'));
});
