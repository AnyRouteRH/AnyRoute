import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserTime, listBrowsers, signOutBrowsers } from '../lib/browser-sessions.js';
import { searchAll } from '../lib/site-actions.js';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const rows = [{ hash: 'current', browser_label: 'Chrome on macOS', current: true }, { hash: 'other/key', browser_label: 'Safari on iOS', current: false }];

test('all pages are read before a browser selection is changed', async () => {
  const urls = [];
  const result = await listBrowsers(async url => { urls.push(url); return urls.length === 1 ? { data: [rows[0]], has_more: true } : { data: [rows[1]], has_more: false }; });
  assert.deepEqual(result, rows);
  assert.deepEqual(urls, ['/api/v1/account/browser-sessions?offset=0&limit=100', '/api/v1/account/browser-sessions?offset=100&limit=100']);
  await assert.rejects(listBrowsers(async () => ({ data: [], has_more: true })), /remaining browsers/);
});
test('one confirmation is required; all others never signs out the current key', async () => {
  const calls = [], disabled = [];
  const request = async (path, options) => { calls.push([path, options]); return { data: rows }; };
  await assert.rejects(signOutBrowsers(request, { allOthers: true }), /Confirm/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await signOutBrowsers(request, { allOthers: true, confirmed: true }, row => disabled.push(row.hash)), { disabled: ['other/key'], failed: [] });
  assert.deepEqual(calls[1], ['/api/v1/keys/other%2Fkey', { method: 'DELETE' }]);
  assert.deepEqual(disabled, ['other/key']);
});
test('current browser uses PATCH; only a refreshed listed key can be signed out', async () => {
  const calls = [];
  const request = async (path, options) => { calls.push([path, options]); return { data: rows }; };
  await signOutBrowsers(request, { hash: 'current', confirmed: true });
  assert.deepEqual(calls[1], ['/api/v1/keys/current', { method: 'PATCH', body: { disabled: true } }]);
  calls.length = 0;
  assert.deepEqual(await signOutBrowsers(request, { hash: 'unlisted', confirmed: true }), { disabled: [], failed: [] });
  assert.equal(calls.length, 1);
});
test('partial failure retains successful changes for retry and prevents clearing a failed current key', async () => {
  const changed = [];
  const request = async (url) => {
    if (url.includes('browser-sessions')) return { data: [...rows, { hash: 'third', browser_label: 'Firefox on Windows' }] };
    if (url.endsWith('other%2Fkey')) throw new Error('Denied');
  };
  assert.deepEqual(await signOutBrowsers(request, { allOthers: true, confirmed: true }, row => changed.push(row.hash)), { disabled: ['third'], failed: [{ hash: 'other/key', label: 'Safari on iOS' }] });
  assert.deepEqual(changed, ['third']);
  const failed = await signOutBrowsers(async url => { if (url.includes('browser-sessions')) return { data: rows }; throw new Error('Denied'); }, { hash: 'current', confirmed: true }, () => assert.fail('Must not clear the key'));
  assert.deepEqual(failed.disabled, []);
});
test('dates, Settings, confirmation, docs and search are wired without new storage', () => {
  assert.equal(browserTime(null), 'Never'); assert.equal(browserTime('bad date'), 'Unknown');
  assert.notEqual(browserTime('2026-01-01T00:00:00Z'), 'Unknown');
  const component = source('../components/account/SignedInBrowsers.jsx');
  assert.match(component, /row.current.*This browser/);
  assert.match(component, /<time dateTime=\{row.created_at\}/);
  assert.match(component, /Sign out all other browsers/);
  assert.match(component, /<Modal/); assert.match(component, /confirmed: true/);
  assert.match(component, /if \(row.current\).*clearKey\(\); onSignedOut/);
  assert.match(component, /role="alert"/); assert.doesNotMatch(component, /localStorage|sessionStorage/);
  assert.match(source('../components/Dashboard.jsx'), /<SignedInBrowsers key=\{apiKey\}/);
  assert.match(source('../app/docs/page.jsx'), /<SignedInBrowsersDocs \/>/);
  assert.match(source('../components/SignedInBrowsersDocs.jsx'), /id="signed-in-browsers"/);
  assert.ok(searchAll('signed-in browsers').some(item => item.href === '/dashboard/#settings'));
  const schema = JSON.parse(source('../public/openapi.json'));
  assert.ok(schema.paths['/api/v1/account/browser-sessions'].get);
});
