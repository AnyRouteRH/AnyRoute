// E148
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowlistFromLines, addCurrentIp, saveKeyAllowedIps } from '../lib/key-ip.js';
import { searchAll } from '../lib/site-actions.js';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('browser validation stays identical to the router without a production build dependency', () => {
  const browser = source('../lib/key-ip.js').split('\n').slice(1).join('\n').split('\n// E148: editor operations.')[0].trim();
  assert.equal(browser, source('../../src/key-ip/address.js').trim());
  assert.deepEqual(allowlistFromLines('203.0.113.9\r\n 2001:db8::/48\n'), ['203.0.113.9', '2001:db8::/48']);
  assert.equal(allowlistFromLines('\n'), null);
  for (const bad of ['host.example', '1.2.3.4/33', '::/129', 'fe80::1%eth0', '203.0.113.999', '::/01']) assert.throws(() => allowlistFromLines(bad));
  assert.throws(() => allowlistFromLines(Array(33).fill('203.0.113.9').join('\n')), /32/);
});

test('current-IP helper is an explicit read; adds without saving, deduplicates, validates and caps', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { data: { ip: '203.0.113.9' } }; };
  assert.equal(await addCurrentIp(request, '2001:db8::/32'), '2001:db8::/32\n203.0.113.9');
  assert.deepEqual(calls, [['/api/v1/keys/current-ip']]);
  assert.equal(await addCurrentIp(request, '203.0.113.9'), '203.0.113.9');
  await assert.rejects(addCurrentIp(async () => ({ data: { ip: 'host.example' } }), ''), /not available/);
  await assert.rejects(addCurrentIp(request, Array(32).fill('2001:db8::/32').join('\n')), /32/);
  await assert.rejects(addCurrentIp(async () => { throw new Error('Refused'); }, ''), /Refused/);
});

test('save validates before PATCH, empty clears, and API refusal reaches the editor', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { data: {} }; };
  assert.deepEqual(await saveKeyAllowedIps(request, 'key/hash', '203.0.113.9\n2001:db8::/32'), ['203.0.113.9', '2001:db8::/32']);
  assert.deepEqual(calls[0], ['/api/v1/keys/key%2Fhash', { method: 'PATCH', body: { allowed_ips: ['203.0.113.9', '2001:db8::/32'] } }]);
  assert.equal(await saveKeyAllowedIps(request, 'hash', ''), null);
  assert.deepEqual(calls[1][1].body, { allowed_ips: null });
  await assert.rejects(saveKeyAllowedIps(request, 'hash', 'bad'), /valid IPv4/);
  assert.equal(calls.length, 2);
  await assert.rejects(saveKeyAllowedIps(async () => { throw new Error('Refused'); }, 'hash', ''), /Refused/);
});

test('key editor is accessible, uses theme tokens, and docs/API/search expose the feature', () => {
  const editor = source('../components/account/KeyIpAllowlist.jsx');
  for (const text of ['Only allow these IP addresses', 'Use my current IP', 'Save IP addresses', 'htmlFor={id}', "aria-describedby={id + '-help'}", 'role="alert"', 'role="status"', 'type="button"', 'disabled={busy || !loaded}']) assert.ok(editor.includes(text), text);
  assert.ok(source('../components/Dashboard.jsx').includes('<KeyIpAllowlist keyHash={existing.id}'));
  assert.ok(source('../components/account/KeyIpAllowlist.module.css').includes('min-width:0'));
  assert.ok(!/#[a-f\d]{3,8}\b|rgba?\(/i.test(source('../components/account/KeyIpAllowlist.module.css')));
  assert.ok(source('../app/docs/page.jsx').includes('<KeyIpAllowlistDocs /> {/* E148 */}'));
  assert.ok(source('../components/KeyIpAllowlistDocs.jsx').includes('id="key-ip-allowlist"'));
  assert.ok(searchAll('ip allowlist').some(result => result.href === '/docs/#key-ip-allowlist'));
  const api = JSON.parse(source('../public/openapi.json'));
  assert.equal(api.components.schemas.Key.properties.allowed_ips.maxItems, 32);
  assert.equal(api.components.schemas.KeyCreateRequest.properties.allowed_ips.minItems, 1);
  assert.deepEqual(api.paths['/api/v1/keys/current-ip'].get.security, [{ BearerAuth: [] }]);
});
