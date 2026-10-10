import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkWallet, shortWallet, unlinkWallet } from '../lib/linked-wallets.js';
test('links the selected secondary wallet by signing the exact challenge, without a transaction', async () => {
  const calls = [], address = '0x' + 'a'.repeat(40), message = 'Anyroute wallet link\nNonce: sample-nonce';
  const request = async (path, options) => { calls.push([path, options]); return { data: { message, nonce: 'sample-nonce' } }; };
  const provider = { request: async args => { calls.push(args); return args.method === 'eth_requestAccounts' ? [address] : '0xsigned'; } };
  await linkWallet(request, provider, 'sample-key');
  assert.deepEqual(calls[0], { method: 'eth_requestAccounts' });
  assert.equal(calls[1][1].body.address, address);
  assert.deepEqual(calls[2], { method: 'personal_sign', params: ['0x' + Buffer.from(message).toString('hex'), address] });
  assert.deepEqual(calls[3], ['/api/v1/account/wallets', { key: 'sample-key', method: 'POST', body: { nonce: 'sample-nonce', signature: '0xsigned' } }]);
  assert.equal(shortWallet(address), '0xaaaa…aaaa');
});
test('unlink sends explicit confirmation and wallet failures remain visible', async () => {
  const address = '0x' + 'b'.repeat(40);
  await unlinkWallet(async (path, options) => { assert.equal(path, '/api/v1/account/wallets/' + address); assert.deepEqual(options, { key: 'sample-key', method: 'DELETE', body: { confirm: true } }); }, 'sample-key', address);
  await assert.rejects(linkWallet(async () => {}, null, 'sample-key'), /browser with a wallet/);
  const error = new Error('Signing cancelled');
  await assert.rejects(linkWallet(async () => {}, { request: async () => { throw error; } }, 'sample-key'), e => e === error);
});
test('Settings, docs, search and authenticated API are wired together', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const ui = read('../components/linked-wallets/LinkedWalletsSettings.jsx');
  assert.match(ui, /Modal title="Unlink wallet"/); assert.match(ui, /disabled=\{busy\}/); assert.match(ui, /role="alert"/); assert.match(ui, /<time dateTime=/);
  assert.match(read('../components/Dashboard.jsx'), /<LinkedWalletsSettings key=\{apiKey\}/);
  assert.match(read('../components/linked-wallets/LinkedWalletsDocs.jsx'), /id="linked-wallets"/);
  assert.match(read('../components/DocsFeatureIndex.jsx'), /\["linked-wallets", "Link another wallet"\]/);
  assert.match(read('../lib/site-map.js'), /task\('linked-wallets'/);
  const spec = JSON.parse(read('../public/openapi.json'));
  for (const [path, methods] of [['/api/v1/account/wallets', ['get', 'post']], ['/api/v1/account/wallets/challenge', ['post']], ['/api/v1/account/wallets/{address}', ['delete']]]) for (const method of methods) assert.deepEqual(spec.paths[path][method].security, [{ BearerAuth: [] }]);
});
