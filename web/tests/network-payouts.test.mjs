import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { payoutStatus } from '../lib/network-payouts.js';
test('payout copy opens only on a strict flag; missing or unreachable status stays closed', async () => {
  for (const network of [undefined, {}, { payouts_open: 'true' }, { payouts_open: false }]) assert.equal((await payoutStatus(async () => ({ ok: true, json: async () => ({ data: { network } }) }))).open, false);
  assert.deepEqual(await payoutStatus(async () => { throw new Error('unavailable'); }), { open: false, feeBps: 500 });
  assert.deepEqual(await payoutStatus(async () => ({ ok: true, json: async () => ({ data: { network: { payouts_open: true, fee_bps: 500 } } }) })), { open: true, feeBps: 500 });
  assert.equal((await payoutStatus(async () => ({ ok: true, json: async () => ({ data: { network: { payouts_open: true, fee_bps: 2001 } } }) }))).feeBps, 500);
});
test('fee wording and exact operator field use the runtime payout response', () => {
  const copy = readFileSync(new URL('../components/NetworkPayoutCopy.jsx', import.meta.url), 'utf8');
  assert.match(copy, /payoutStatus/); assert.match(copy, /Payouts to network hosts aren’t switched on yet/); assert.match(copy, /\$ANYR burns are coming soon/); assert.doesNotMatch(copy, /\d+% network fee|Weekly/); // burns stay undefined until they are live
  const dashboard = readFileSync(new URL('../components/NetworkHostPayout.jsx', import.meta.url), 'utf8'); assert.match(dashboard, /accrued_net_usdg_units !== undefined/);
});
