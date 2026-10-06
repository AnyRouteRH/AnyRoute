import test from 'node:test';
import assert from 'node:assert/strict';
import { depositCountdown } from '../lib/deposit-countdown.js';
import { depositProgressView } from '../lib/deposit-progress.js';
import { fundingDepositView } from '../lib/funding-display.js';
const now = Date.parse('2026-10-06T12:00:00Z');
const waiting = { stage: 'detected', lane: 'escrow', expected_final_at: new Date(now + 840000).toISOString() };
test('B123 countdown moves with the clock and never declares finality', () => {
  assert.equal(depositCountdown(waiting, now), 'About 14 min until final');
  assert.equal(depositCountdown(waiting, now + 60000), 'About 13 min until final');
  assert.equal(depositCountdown(waiting, now + 839999), 'About 1 min until final');
  assert.equal(depositCountdown(waiting, now + 840000), null);
  assert.equal(depositProgressView(waiting, now + 840000).final, false);
  assert.match(depositProgressView(waiting, now).status, /About 14 min until final/);
  assert.equal(fundingDepositView(waiting, {}, now).detail, 'About 14 min until final');
});
test('B123 unknown, expired, terminal and unconfirmed stages fall back to stage labels', () => {
  for (const expected_final_at of [null, '', 'invalid', new Date(now - 1).toISOString()]) assert.equal(depositCountdown({ ...waiting, expected_final_at }, now), null);
  for (const stage of ['checking', 'submitted', 'final', 'credited', 'reversed', 'orphaned', 'awaiting_price', 'crediting']) assert.equal(depositCountdown({ ...waiting, stage }, now), null);
  assert.equal(depositCountdown({ ...waiting, lane: 'usdg' }, now), null);
  assert.match(depositProgressView({ ...waiting, expected_final_at: null }, now).status, /Waiting for chain finality/);
  assert.match(depositProgressView({ ...waiting, stage: 'final', credited_usd: 1.01 }, now).status, /\$1.01 added.*final/);
  assert.match(fundingDepositView({ ...waiting, stage: 'provisional', credited_usd: 1.01 }, {}, now).detail, /14 min until final.*reverse/);
});
