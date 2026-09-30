import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usdgAmount, bondTransaction, describeBond } from '../lib/host-bonds.js';
test('USDG amounts remain exact and links are fixed to the chain explorer', () => {
  assert.equal(usdgAmount('5000000001'), '5000.000001 USDG');
  assert.equal(usdgAmount('1000000000000000000000000000000'), '1000000000000000000000000 USDG');
  assert.equal(usdgAmount('-1'), 'Unknown');
  assert.equal(bondTransaction('javascript:alert(1)'), '');
  const hash = `0x${'a'.repeat(64)}`;
  assert.equal(bondTransaction(hash), `https://robinhoodchain.blockscout.com/tx/${hash}`);
  const b = describeBond({ amount_units: '5000000000', active_units: '0', unbonding: { amount_units: '5000000000' }, slashes: [{ amount_units: '1000000', transactions: [{ hash, event: 'SlashProposed' }] }] });
  assert.equal(b.amount, '5000 USDG'); assert.equal(b.active, '0 USDG'); assert.equal(b.queued, '5000 USDG'); assert.equal(b.slashes[0].amount, '1 USDG'); assert.ok(b.slashes[0].transactions[0].href);
});
test('host view and docs disclose deposit, stale state and independent owner review', () => {
  const view = readFileSync(new URL('../app/hosts/HostBond.jsx', import.meta.url), 'utf8');
  const docs = readFileSync(new URL('../components/HostBondsDocs.jsx', import.meta.url), 'utf8');
  for (const text of ['Work deposit', 'Unbonding:', 'Slash history', 'independent owner approval', 'stale']) assert.ok(view.includes(text));
  for (const text of ['NETWORK_BONDS_ENABLED=false', 'NETWORK_SLASHING_ENABLED=false', 'review-only evidence', 'source evidence']) assert.ok(docs.includes(text));
});
