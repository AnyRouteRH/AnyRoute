import { expect, test } from 'bun:test';
import { agentPolicySchema, agentIntentSchema } from '../src/agents/policy.ts';
import { evaluateAgentPolicy, type AgentPolicyState } from '../src/agents/evaluate.ts';
import { STARTER_RULEBOOKS } from '../web/lib/agent-starters.js';
import { buildPolicy, policyForm } from '../web/lib/agents.js';

const state: AgentPolicyState = { killed: false, spent_pico: { hour: 0n, day: 0n, week: 0n }, breakers: { spent_minute_pico: 0n, requests_minute: 0, denials_10min: 0, distinct_models_hour: 0 } };
const now = new Date('2026-09-28T12:00:00Z');
for (const template of STARTER_RULEBOOKS) {
  test(`${template.id}: validates against the enforced schema and stays restricted after editing`, () => {
    const policy = agentPolicySchema.parse(template.policy);
    expect(policy).toEqual(template.policy);
    expect(buildPolicy(policyForm(policy))).toEqual({ policy, errors: [] });
    const intent = agentIntentSchema.parse({ kind: 'inference', model: policy.models.allow?.[0] ?? "any/model", lane: policy.lanes![0], est_cost_pico: '0', max_output_tokens: 100, tools: [] });
    expect(evaluateAgentPolicy(policy, state, intent, now).decision).toBe('allow');
    expect(evaluateAgentPolicy(policy, state, { ...intent, tools: ['pay'] }, now).reasons.map(reason => reason.code)).toContain('tool_not_allowed');
    expect(evaluateAgentPolicy(policy, state, { ...intent, est_cost_pico: 1_000_000_000_000n }, now).decision).toBe('deny');
  });
}
test('attested starter refuses public requests; a first denial trips the experiment breaker', () => {
  const privatePolicy = agentPolicySchema.parse(STARTER_RULEBOOKS.find(template => template.id === 'private')!.policy);
  const intent = agentIntentSchema.parse({ kind: 'inference', model: privatePolicy.models.allow?.[0] ?? "any/model", lane: 'public', est_cost_pico: '0', tools: [], max_output_tokens: 100 });
  expect(evaluateAgentPolicy(privatePolicy, state, intent, now).reasons.map(reason => reason.code)).toContain('lane_not_allowed');
  const experiment = agentPolicySchema.parse(STARTER_RULEBOOKS.find(template => template.id === 'experiment')!.policy);
  expect(evaluateAgentPolicy(experiment, { ...state, breakers: { ...state.breakers!, denials_10min: 1 } }, intent, now).reasons.map(reason => reason.code)).toContain('breaker:max_denials_per_10min');
});
