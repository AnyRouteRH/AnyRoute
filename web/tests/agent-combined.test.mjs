import test from 'node:test';
import assert from 'node:assert/strict';
import { policyForm, buildPolicy } from '../lib/agents.js';

test('editing a rulebook preserves breakers, autonomy and alerts together', () => {
  const policy = {
    version: 1, models: {}, caps: { per_request_usd: 1 }, on_breach: 'deny',
    breakers: { max_requests_per_minute: 2 },
    alerts: { at_percent: [80], denials_in_10min: 2, channels: [] },
    autonomy: { rungs: [{ after_days: 0, clean_requests: 1, caps_multiplier: 2 }], demote_on: ['breaker'] },
  };
  assert.deepEqual(buildPolicy(policyForm(policy)), { policy, errors: [] });
  const form = policyForm(policy);
  form.caps.per_request_usd = '3';
  assert.deepEqual(buildPolicy(form), { policy: { ...policy, caps: { per_request_usd: 3 } }, errors: [] });
});
