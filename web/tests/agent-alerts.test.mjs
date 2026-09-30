import test from 'node:test';
import assert from 'node:assert/strict';
import {policyForm,buildPolicy} from '../lib/agents.js';
import {alertLabel,alertSettingsErrors} from '../lib/agent-alerts.js';
test('alert opt-in round trips without adding defaults or dropping settings', () => {
  const base = {version:1,models:{},caps:{},on_breach:'deny'};
  assert.deepEqual(buildPolicy(policyForm(base)).policy,base);
  for (const alerts of [{},{at_percent:[50,80,100],denials_in_10min:3,channels:['email']},{at_percent:[],channels:[]}]) assert.deepEqual(buildPolicy(policyForm({...base,alerts})).policy,{...base,alerts});
  for (const alerts of [{at_percent:[101]},{denials_in_10min:0},{channels:['sms']}]) assert.ok(alertSettingsErrors(alerts).length);
});
test('feed uses fixed metadata labels', () => {
  assert.equal(alertLabel({kind:'cap',percent:80,window:'hour'}),'80% of the rolling hour cap');
  assert.equal(alertLabel({kind:'killed'}),'Agent killed');
  assert.equal(alertLabel({kind:'approval'}),'Agent requested approval');
});
