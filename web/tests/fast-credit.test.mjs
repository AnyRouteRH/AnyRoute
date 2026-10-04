import test from 'node:test';
import assert from 'node:assert/strict';
import { depositCreditLabel, depositWaitText } from '../lib/fast-credit.js';
import { fundingState, initialFunding } from '../lib/add-funds.js';
test('status comes only from enabled router funding fields', () => {
  assert.equal(depositCreditLabel(), null);
  assert.equal(depositCreditLabel({ enabled: false, settling_usd: 10 }), null);
  assert.equal(depositCreditLabel({ enabled: true }), null);
  assert.equal(depositCreditLabel({ enabled: true, settling_usd: '10' }), 'Credited (settling, usually ~20 min)');
  assert.equal(depositCreditLabel({ enabled: true, settling_usd: '0' }), 'Final');
  assert.match(depositWaitText({ enabled: true }), /seconds/);
  assert.match(depositWaitText({ enabled: true }), /timing varies/);
  assert.doesNotMatch(depositWaitText(), /seconds/);
});
test('observed early funds become credited and refresh to final without another balance increase', () => {
  const pending = fundingState(initialFunding, { type: 'pending', total: 0 });
  const credited = fundingState(pending, { type: 'observed', total: 10, balance: 10, fastCredit: { enabled: true, settling_usd: 10 } });
  assert.equal(credited.phase, 'credited'); assert.match(credited.status, /settling/);
  const final = fundingState(credited, { type: 'observed', total: 10, balance: 8, fastCredit: { enabled: true, settling_usd: 0 } });
  assert.equal(final.status, 'Final');
});
