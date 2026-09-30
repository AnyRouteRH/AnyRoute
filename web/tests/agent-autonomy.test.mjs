import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autonomyLadder } from '../lib/agent-autonomy.js';
import { buildPolicy, policyForm } from '../lib/agents.js';
const policy = { version:1,models:{},caps:{per_day_usd:1},on_breach:'deny',autonomy:{rungs:[{after_days:1,clean_requests:2,caps_multiplier:2},{after_days:3,clean_requests:5,caps_multiplier:4}],demote_on:['deny','kill','breaker']} };
test('editing other rulebook fields preserves optional autonomy and absent stays absent', () => {
  assert.deepEqual(buildPolicy(policyForm(policy)),{policy,errors:[]});
  assert.equal(buildPolicy(policyForm(null)).policy.autonomy,undefined);
});
test('ladder includes base caps and marks the current server-reported rung', () => {
  assert.deepEqual(autonomyLadder({},{}),[]);
  assert.deepEqual(autonomyLadder(policy,null),[]);
  const ladder = autonomyLadder(policy,{rung:1});
  assert.deepEqual(ladder.map(r => r.caps_multiplier),[1,2,4]);
  assert.deepEqual(ladder.map(r => r.current),[false,true,false]);
  assert.deepEqual(ladder.map(r => r.reached),[true,true,false]);
  assert.equal(ladder[2].clean_requests,5);
});
test('published API includes optional bounded autonomy and progress', () => {
  const api = JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
  const schema = api.components.schemas.AgentPolicy;
  assert.equal(schema.required.includes('autonomy'),false);
  assert.equal(schema.properties.autonomy.properties.rungs.maxItems,5);
  assert.equal(schema.properties.autonomy.properties.rungs.items.properties.caps_multiplier.maximum,10);
  assert.match(api.paths['/api/v1/agents/me'].get.description,/days_remaining.*requests_remaining/);
});
