import { expect, test } from 'bun:test';
import { workHoursCheck, type WorkHours } from '../src/agents/work-hours.ts';
import { agentPolicySchema, canonicalAgentPolicy, type AgentPolicy } from '../src/agents/policy.ts';
import { evaluateAgentPolicy } from '../src/agents/evaluate.ts';
import { rulebookWords } from '../src/agents/rulebook-words.ts';
import { rulebookDiff } from '../src/agents/policy-history.ts';
import { replayRulebook, type ReplayInput } from '../src/agents/replay.ts';
import { rulebookWords as webWords } from '../web/lib/rulebook-words.js';
import { buildPolicy, policyForm } from '../web/lib/agents.js';
import { STARTER_RULEBOOKS } from '../web/lib/agent-starters.js';
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: 'deny' };
const hours: WorkHours = { days: [1,2,3,4,5], start: '09:00', end: '18:00', time_zone: 'America/New_York', outside: 'refuse' };
const state = { killed: false, spent_pico: { hour: 0n, day: 0n, week: 0n } };
const intent = { kind: 'inference' as const, model: 'sample/model', lane: 'public' as const, est_cost_pico: 1n, tools: [] };
const check = (at: string, h = hours) => workHoursCheck(h, new Date(at));
const run = (at: string, h = hours, extra = {}) => evaluateAgentPolicy({ ...base, work_hours: h, ...extra }, state, intent, new Date(at));

test('strict validation of days, times, time zone and mode; old policies and starters are unchanged', () => {
  expect(agentPolicySchema.parse({ ...base, work_hours: hours }).work_hours).toEqual(hours);
  for (const patch of [{ days: [] }, { days: [1,1] }, { days: [7] }, { start: '9:00' }, { end: '24:00' }, { end: '09:00' }, { time_zone: 'Mars/Nowhere' }, { time_zone: '+01:00' }, { time_zone: 'x'.repeat(101) }, { outside: 'allow' }, { prompt: 'sample text' }]) expect(agentPolicySchema.safeParse({ ...base, work_hours: { ...hours, ...patch } }).success).toBe(false);
  expect(agentPolicySchema.parse(base)).toEqual(base);
  expect(canonicalAgentPolicy(base)).toBe('{"caps":{},"models":{},"on_breach":"deny","version":1}');
  expect(evaluateAgentPolicy(base, state, intent, new Date('2026-10-12T01:00:00Z'))).toEqual({ decision: 'allow', reasons: [] });
  for (const starter of STARTER_RULEBOOKS) expect(buildPolicy(policyForm(starter.policy)).policy).toEqual(agentPolicySchema.parse(starter.policy));
});
test('weekday boundaries, weekend, next opening and local zone rather than UTC', () => {
  expect(check('2026-10-12T12:59:59Z').inside).toBe(false);
  expect(check('2026-10-12T13:00:00Z').inside).toBe(true);
  expect(check('2026-10-12T21:59:59Z').inside).toBe(true);
  expect(check('2026-10-12T22:00:00Z').next?.toISOString()).toBe('2026-10-13T13:00:00.000Z');
  expect(check('2026-10-17T13:00:00Z').next?.toISOString()).toBe('2026-10-19T13:00:00.000Z');
  const result = run('2026-10-12T22:00:00Z');
  expect(result.decision).toBe('deny'); expect(result.reasons[0].code).toBe('outside_work_hours');
  expect(result.reasons[0].message).toContain('2026-10-13T13:00:00.000Z');
});
test('overnight belongs to its starting day, including Saturday to Sunday wrap', () => {
  const h = { ...hours, days: [6], start: '22:00', end: '06:00', time_zone: 'UTC' };
  expect(check('2026-10-17T21:59:59Z', h).inside).toBe(false);
  expect(check('2026-10-17T22:00:00Z', h).inside).toBe(true);
  expect(check('2026-10-18T05:59:59Z', h).inside).toBe(true);
  expect(check('2026-10-18T06:00:00Z', h).inside).toBe(false);
  expect(check('2026-10-19T01:00:00Z', h).inside).toBe(false);
});
test('DST spring skip opens at first real minute and weekly missing windows move to next week', () => {
  const h = { ...hours, days: [0], start: '02:30', end: '04:00' };
  expect(check('2026-03-08T06:59:00Z', h).next?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  expect(check('2026-03-08T07:00:00Z', h).inside).toBe(true);
  expect(check('2026-03-08T08:00:00Z', h).inside).toBe(false);
  expect(check('2026-03-08T06:59:00Z', { ...h, end: '02:45' }).next?.toISOString()).toBe('2026-03-15T06:30:00.000Z');
  expect(check('2026-03-09T13:00:00Z').inside).toBe(true);
});
test('DST fall repeated minutes are both allowed and next opening can be the second occurrence', () => {
  const h = { ...hours, days: [0], start: '01:30', end: '01:45' };
  expect(check('2026-11-01T05:30:00Z', h).inside).toBe(true);
  expect(check('2026-11-01T05:45:00Z', h).next?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
  expect(check('2026-11-01T06:30:00Z', h).inside).toBe(true);
  expect(check('2026-11-01T06:45:00Z', h).inside).toBe(false);
  expect(check('2026-11-02T13:00:00Z').inside).toBe(false);
  expect(check('2026-11-02T14:00:00Z').inside).toBe(true);
});
test('ask first works for every intent; ordinary refusals retain precedence', () => {
  const h = { ...hours, outside: 'ask_first' as const };
  for (const i of [intent, { kind: 'mcp_tool' as const, name: 'read' }, { kind: 'paid_tool' as const, resource: 'https://tools.example/read', seller: '0x' + 'ab'.repeat(20), price_pico: 1n }, { kind: 'action' as const, action: 'payment.send', amount_pico: 1n }]) {
    const result = evaluateAgentPolicy({ ...base, work_hours: h, actions: {} }, state, i, new Date('2026-10-12T22:00:00Z'));
    expect(result.decision).toBe('approval_required'); expect(result.reasons.map(r => r.code)).toEqual(['approval_work_hours']);
  }
  expect(run('2026-10-12T22:00:00Z', h, { models: { allow: [] } }).reasons.map(r => r.code)).toEqual(['model_not_allowed']);
  expect(run('2026-10-12T22:00:00Z', h, { windows: [] }).decision).toBe('deny');
  expect(run('2026-10-12T13:00:00Z', h).decision).toBe('allow');
  expect(evaluateAgentPolicy({ ...base, work_hours: h, approval: { above_usd: 1e-12 } }, state, { ...intent, est_cost_pico: 2n }, new Date('2026-10-12T22:00:00Z')).reasons.map(r => r.code)).toEqual(['approval_work_hours', 'approval_required']);
});
test('plain sentences, editor round trip and history differences include work hours', () => {
  const p = { ...base, work_hours: { ...hours, outside: 'ask_first' as const } };
  const sentence = 'Works Monday to Friday, 9:00 to 18:00 New York time; asks first outside those hours';
  expect(rulebookWords(p)).toContain(sentence); expect(webWords(p)).toEqual(rulebookWords(p));
  expect(buildPolicy(policyForm(p))).toEqual({ policy: p, errors: [] });
  expect(rulebookDiff(base, p)).toEqual({ added: [sentence], removed: [] });
  const form = policyForm(p); form.workHours = undefined;
  expect(buildPolicy(form).policy).toEqual(base);
});
test('replay checks hours at each recorded instant, for both outside modes', () => {
  const input: ReplayInput = { from: new Date('2026-10-12T00:00:00Z'), to: new Date('2026-10-13T00:00:00Z'), days: 1, truncated: false, seed: { spend: [], calls: [], actions: [] }, refused: 0, inherited: 0, items: ['2026-10-12T12:59:00Z', '2026-10-12T13:00:00Z', '2026-10-12T22:00:00Z'].map(at => ({ kind: 'call', ts: new Date(at), model: 'sample/model', lane: 'public', cost_pico: 1n, tokens_out: 10, est_cost_pico: 1n, max_output_tokens: 20, tools: [], actual: 'allow' })) };
  for (const outside of ['refuse', 'ask_first'] as const) {
    const r = replayRulebook({ ...base, work_hours: { ...hours, outside } }, input);
    expect([r.allowed, r.denied, r.asked]).toEqual(outside === 'refuse' ? [1,2,0] : [1,0,2]);
    expect(r.by_reason).toEqual({ [outside === 'refuse' ? 'outside_work_hours' : 'approval_work_hours']: 2 });
    if (outside === 'ask_first') expect(r.notes.join(' ')).toContain('cannot know whether you would have approved');
  }
});
