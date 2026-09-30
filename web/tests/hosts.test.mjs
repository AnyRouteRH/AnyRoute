import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describeHost, hostId, hostHref, hostPath, operatorHeader, rekorHref } from '../lib/hosts.js';
const host = JSON.parse(readFileSync(new URL('./fixtures/host.json', import.meta.url)));
test('the live host identifier has the complete page view model', () => {
  const v = describeHost(host);
  assert.equal(v.id, 'phala-qwen05b-tdx'); assert.equal(v.hardware.label, 'Hardware verified');
  assert.equal(v.href, '/hosts/?id=phala-qwen05b-tdx'); assert.equal(v.verifyHref, '/verify/?p=phala-qwen05b-tdx');
  assert.equal(v.models[0], 'qwen/qwen2.5-0.5b-instruct'); assert.equal(v.measurements.length, 2);
  assert.equal(v.measurements[0].current, true); assert.equal(v.measurements[1].current, false);
  assert.ok(v.measurements.every(m => m.rekorHref.startsWith('https://rekor.sigstore.dev/')));
  assert.equal(v.events.length, 1); assert.equal(v.earningsText, '<$1');
  assert.equal(v.anchor.label, 'Root kept off chain'); assert.equal(v.uptimeText, '99.2% across 100 observations');
});
test('status cannot promote stale hardware, unconfirmed roots or measured builds into approval', () => {
  const v = describeHost({ ...host, attested: false, anchoring: { latest: { anchored: true, status: 'pending' } } });
  assert.equal(v.hardware.tone, 'warn'); assert.equal(v.anchor.tone, 'warn'); assert.equal(v.build.label, 'Approval not established');
  assert.equal(describeHost({ ...host, anchoring: { latest: { anchored: true, status: 'confirmed', tx_hash: '0x12' } } }).anchor.label, 'Work anchored on chain');
  assert.equal(describeHost({ ...host, attestation: { status: 'unverified' } }).hardware.tone, 'warn');
});
test('missing and short records are unknown; proof-time shares never round up', () => {
  const v = describeHost(host);
  assert.equal(v.windows[0].shareText, '99.9%'); assert.match(v.windows[0].caption, /earlier part.*unknown/);
  assert.equal(v.windows[1].shareText, ''); assert.equal(describeHost({}).windows.length, 0);
  assert.equal(describeHost({}).uptimeText, 'No observations recorded');
});
test('query and fragment host selectors are bounded and links remain relative', () => {
  assert.equal(hostId('?id=phala-qwen05b-tdx', ''), host.id);
  assert.equal(hostId('', '#phala-qwen05b-tdx'), host.id); assert.equal(hostId('', '#id=phala-qwen05b-tdx'), host.id);
  for (const value of ['../../keys', '<script>', 'x'.repeat(129)]) assert.equal(hostId(`?id=${encodeURIComponent(value)}`, ''), '');
  assert.equal(hostId('', '#%broken'), ''); assert.equal(hostPath('a:b'), '/api/v1/hosts/a%3Ab');
  assert.ok(hostHref(host.id).startsWith('/hosts/'));
  assert.equal(rekorHref('javascript:alert(1)'), ''); assert.equal(rekorHref('http://private.invalid:9443'), '');
});
test('wallet signature binds the exact GET host resource using SHA-256', async () => {
  const calls = []; const address = '0x' + '43'.repeat(20);
  const wallet = { request: async input => { calls.push(input); return input.method === 'eth_requestAccounts' ? [address] : '0x1234'; } };
  const header = await operatorHeader(wallet, host.id, webcrypto.subtle, 1790769600000);
  const message = Buffer.from(calls[1].params[0].slice(2), 'hex').toString();
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from('GET ' + hostPath(host.id)))).toString('hex');
  assert.equal(message, `anyroute:1790769600:${hash}`); assert.equal(header, `${address}:1790769600:0x1234`);
});
test('API paths and optional operator fields are documented', () => {
  const api = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url)));
  for (const path of ['/api/v1/hosts', '/api/v1/hosts/{providerId}']) assert.ok(api.paths[path]?.get);
  assert.ok(api.paths['/api/v1/hosts/{providerId}'].get.parameters.some(p => p.name === 'X-Wallet-Auth'));
});
