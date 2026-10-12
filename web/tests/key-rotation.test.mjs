import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRotateKey, rotateAccountKey, rotationChoices, rotationLines } from '../lib/key-rotation.js';
test('rotation choices and request use the selected key with no settings editing', async () => {
  assert.deepEqual(rotationChoices.map(([value]) => value), ['1h', '24h', '7d']);
  let call;
  await rotateAccountKey(async (...args) => { call = args; return { key: 'one-time' }; }, 'key hash', '7d');
  assert.deepEqual(call, ['/api/v1/keys/key%20hash/rotate', { method: 'POST', body: { grace: '7d' } }]);
  await assert.rejects(() => rotateAccountKey(() => {}, 'hash', 'forever'));
});
test('rotation is hidden from restricted callers and inactive or replaced keys', () => {
  const key = { hash: 'old', disabled: false }, caller = { hash: 'owner', management: true, scope: 'account' };
  assert.equal(canRotateKey(key, caller, null), true);
  for (const scope of ['read', 'inference']) assert.equal(canRotateKey(key, { ...caller, scope }, null), false);
  assert.equal(canRotateKey({ ...key, disabled: true }, caller, null), false);
  assert.equal(canRotateKey({ ...key, expires_at: '2000-01-01' }, caller, null), false);
  assert.equal(canRotateKey(key, caller, { to: 'new' }), false);
  assert.equal(canRotateKey(key, { hash: 'other' }, null), false);
});
test('history names both directions with dates and masked labels', () => {
  const lines = rotationLines({ from: 'old', to: 'next', at: '2026-10-12T00:00:00Z', grace_ends_at: '2026-10-13T00:00:00Z' }, [{ hash: 'old', label: 'masked old' }]);
  assert.equal(lines.length, 2); assert.match(lines[0], /Rotated from masked old/); assert.match(lines[1], /Rotated to next/); assert.match(lines[1], /Stops/);
  assert.deepEqual(rotationLines(null), []);
  const chained = rotationLines({ from: 'old', to: 'next', at: '2026-10-12T00:00:00Z', grace_ends_at: '2026-10-13T00:00:00Z' }, [], { old: { at: '2026-10-10T00:00:00Z' } });
  assert.ok(chained[0].includes(new Date('2026-10-10T00:00:00Z').toLocaleString()));
  assert.ok(chained[1].includes(new Date('2026-10-12T00:00:00Z').toLocaleString()));
});
test('Settings reuses the existing reveal, dialog and themed responsive layout', () => {
  const dashboard = readFileSync(new URL('../components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dashboard, /<KeyRotation apiKey=/);
  assert.match(dashboard, /onSecret=\{secret => setReveal/);
  const component = readFileSync(new URL('../components/account/KeyRotation.jsx', import.meta.url), 'utf8');
  assert.match(component, /<Modal title="Rotate this key"/);
  assert.match(component, /htmlFor=\{id \+ '-grace'\}/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|console\./);
});
