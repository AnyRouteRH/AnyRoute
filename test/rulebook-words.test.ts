import { expect, test } from 'bun:test';
import { plainApprovalText } from '../src/agents/rulebook-approval-text.ts';
import { approvalText } from '../src/telegram/delivery.ts';
import type { ApprovalRow } from '../src/agents/approvals.ts';
import { readFileSync } from 'node:fs';
import { agentPolicySchema } from '../src/agents/policy.ts';
import { exactUsd, rulebookWords, rulebookApprovalLine } from '../src/agents/rulebook-words.ts';
import { rulebookWords as webWords } from '../web/lib/rulebook-words.js';
import { STARTER_RULEBOOKS } from '../web/lib/agent-starters.js';
import { GUARD_STARTERS } from '../web/lib/agent-guard.js';
import { STARTER_SETUPS, setupPolicy } from '../web/lib/starter-setups.js';

const policy = agentPolicySchema.parse({
  version: 1, models: { allow: ['meta-llama/llama-3.3-70b-instruct'], deny: ['blocked/*'] }, lanes: ['attested'], route_default: 'proven_only',
  caps: { per_request_usd: 0.005, per_hour_usd: 0.07, per_day_usd: 1, per_week_usd: 5, max_output_tokens: 256 },
  tools: { allow: ['read'], deny: ['write'], max_price_per_call: 0.003, daily_budget: 0.09, pass_to_models: false },
  windows: [{ days: [5, 3, 1, 2, 4, 1], start: '13:30', end: '20:00' }],
  approval: { above_usd: 0.001, above_calls_per_hour: 60 },
  actions: { allow: ['payment.send'], deny: ['transfer.*'], targets: { allow: ['STORE_A'], deny: ['STORE_B'] }, per_action_usd: 20, per_day_usd: 30, approval_above_usd: 5, max_per_hour: 2 },
  breakers: { max_spend_usd_per_minute: 0.008, max_requests_per_minute: 4, max_denials_per_10min: 6, max_distinct_models_per_hour: 3 },
  alerts: { at_percent: [50, 80], denials_in_10min: 7, channels: ['webhook', 'email', 'telegram'] },
  agreements: { max_escrow_usd: 9, counterparties_allow: ['0x' + 'ab'.repeat(20)] },
  autonomy: { rungs: [{ after_days: 8, clean_requests: 10, caps_multiplier: 1.5 }], demote_on: ['deny', 'kill', 'breaker'] }, on_breach: 'kill',
});
const coverage: Record<string, string> = {
  version: '' /* not shown */, 'models.allow': 'Only these models: Llama 3.3 70B', 'models.deny': 'Never uses these models: blocked/*', lanes: 'Only these lanes: proven hardware', route_default: 'Requests that name no lane: Proven hardware only',
  'caps.per_request_usd': '$0.005 a request', 'caps.per_hour_usd': '$0.07 in any hour', 'caps.per_day_usd': '$1 in any 24 hours', 'caps.per_week_usd': '$5 in any 7 days', 'caps.max_output_tokens': 'Replies up to 256 tokens',
  'tools.allow': 'Only these declared or paid tools: read', 'tools.deny': 'Never uses these tools: write', 'tools.max_price_per_call': 'Paid tools up to $0.003 a call', 'tools.daily_budget': 'Paid tools up to $0.09 in any 24 hours', 'tools.pass_to_models': 'Does not pass purchased tool results to models',
  'windows.days': 'Weekdays', 'windows.start': '13:30', 'windows.end': '20:00 UTC (start included, end excluded)', 'approval.above_usd': 'Asks you above $0.001 for a model or paid tool call', 'approval.above_calls_per_hour': 'Asks you after 60 model calls in any hour',
  'actions.allow': 'Only these actions: payment.send', 'actions.deny': 'Never sends transfer.*', 'actions.targets.allow': 'Only these action targets: STORE_A', 'actions.targets.deny': 'Never uses these action targets: STORE_B', 'actions.per_action_usd': 'Payments up to $20 each', 'actions.per_day_usd': 'Actions up to $30 in any 24 hours', 'actions.approval_above_usd': 'asks you above $5', 'actions.max_per_hour': 'Up to 2 actions in any hour',
  'breakers.max_spend_usd_per_minute': 'Stop at $0.008 spent in any minute', 'breakers.max_requests_per_minute': 'Stop at 4 requests in any minute', 'breakers.max_denials_per_10min': 'Stop at 6 denials in any 10 minutes', 'breakers.max_distinct_models_per_hour': 'Stop at 3 different models in any hour',
  'alerts.at_percent': 'Alerts at 50%, 80% of hourly, daily and weekly caps', 'alerts.denials_in_10min': 'Alerts after 7 denials in ten minutes', 'alerts.channels': 'Alert channels: webhook, email (not switched on yet), Telegram',
  'agreements.max_escrow_usd': 'Agreement escrow up to $9 each', 'agreements.counterparties_allow': 'Agreements only with: 0x' + 'ab'.repeat(20),
  'autonomy.rungs.after_days': 'after 8 days', 'autonomy.rungs.clean_requests': '10 clean requests at the previous step', 'autonomy.rungs.caps_multiplier': 'spending caps become 1.5 times the base caps', 'autonomy.demote_on': 'Reset to base caps after: a refusal, Stop, a circuit breaker trip', on_breach: 'If a rule is broken: Stop until you resume',
};
function leaves(schema: any, path = ''): string[] {
  if (schema._zod.def.type === 'optional') return leaves(schema.unwrap(), path);
  if (schema._zod.def.type === 'array') return schema.element._zod.def.type === 'object' ? leaves(schema.element, path) : [path];
  if (schema.shape) return Object.entries(schema.shape).flatMap(([key, value]) => leaves(value, path ? `${path}.${key}` : key));
  return [path];
}
test('every schema field has an exact sentence, including every nested field', () => {
  expect(Object.keys(coverage).sort()).toEqual(leaves(agentPolicySchema).sort());
  const text = rulebookWords(policy).join('\n');
  for (const [path, sentence] of Object.entries(coverage)) expect(text, path).toContain(sentence);
});
test('server and web copies are identical after removing TypeScript types', () => {
  const source = readFileSync('src/agents/rulebook-words.ts', 'utf8').split('// ==== shared formatter (begin) ====\n')[1].split('// ==== shared formatter (end) ====')[0];
  const expected = '// B124: generated from the shared formatter in src/agents/rulebook-words.ts.\n' + new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  expect(readFileSync('web/lib/rulebook-words.js', 'utf8')).toBe(expected);
  expect(webWords(policy)).toEqual(rulebookWords(policy));
});
test('exact amounts, empty allow lists, absent rules and UTC overnight boundaries', () => {
  for (const [amount, text] of [[0.005, '$0.005'], [0.000000000001, '$0.000000000001'], [0.123456789123, '$0.123456789123'], [1e-7, '$0.0000001'], [1000000, '$1000000']] as const) expect(exactUsd(amount)).toBe(text);
  const p = agentPolicySchema.parse({ version: 1, models: { allow: [] }, caps: {}, tools: { allow: [], pass_to_models: true }, lanes: [], windows: [{ days: [6], start: '22:00', end: '02:00' }, { days: [], start: '09:00', end: '10:00' }, { days: [1], start: '09:00', end: '09:00' }], actions: { allow: [], targets: { allow: [] } }, on_breach: 'deny' });
  expect(rulebookWords(p)).toContain('No models allowed'); expect(rulebookWords(p)).toContain('No lanes allowed'); expect(rulebookWords(p)).toContain('No declared or paid tools allowed'); expect(rulebookWords(p)).toContain('No actions allowed');
  expect(rulebookWords(p)).toContain('Saturday 22:00–02:00 UTC (start included, end excluded; ends the following day)'); expect(rulebookWords(p).filter(s => s === 'This window allows no requests')).toHaveLength(2);
  expect(rulebookWords(null)).toEqual(['No rulebook set']);
  expect(rulebookWords({ ...p, models: { allow: ['constructor', 'toString'] } })).toContain('Only these models: constructor, toString');
  expect(rulebookApprovalLine({ ...p, actions: undefined }, true)).toBe('Rulebook: no action rules; checked actions are refused');
  expect(rulebookApprovalLine(policy, true)).toBe('Rulebook: up to $20 a payment; asks above $5');
});
test('all starter rulebooks and both setup guard states match their sentence snapshot', () => {
  const snapshot = Object.fromEntries([...STARTER_RULEBOOKS, ...GUARD_STARTERS].map(s => [s.id, rulebookWords(agentPolicySchema.parse(s.policy))]));
  for (const setup of STARTER_SETUPS) for (const guard of [false, true]) snapshot[`${setup.id}:${guard}`] = rulebookWords(agentPolicySchema.parse(setupPolicy(setup, { guard })));
  expect(snapshot).toEqual(JSON.parse(readFileSync('test/fixtures/rulebook-words.json', 'utf8')));
});

test('Telegram summaries cover model, tool and inherited rules with exact costs; default delivery is untouched', () => {
  const row = { id: 'approval-one', keyHash: 'agent-key', intent: { intents: [{ kind: 'inference', model: 'qwen/model', lane: 'attested', tools: ['read'] }, { kind: 'paid_tool', resource: 'https://tools.example/read', seller: 'seller-one' }, { kind: 'mcp_tool', name: 'read' }] }, maxCostPico: 5000000000n, status: 'pending', expiresAt: new Date('2000-01-01T00:15:00Z'), requestedAt: new Date('2000-01-01T00:00:00Z') } as ApprovalRow;
  const text = plainApprovalText(row, [{ policy, inherited: false }, { policy: { ...policy, caps: { per_request_usd: 0.003 }, autonomy: undefined }, inherited: true }], 'Sample agent');
  for (const part of ['Model: qwen/model; lane: attested; declared tools: read', 'Paid tool: https://tools.example/read; seller: seller-one', 'Declared tool: read', 'Maximum cost: $0.005', 'base cap up to $0.005 a model call (autonomy can increase it)', 'Inherited: up to $0.003 a model call', 'Status: expired']) expect(text).toContain(part);
  expect(plainApprovalText(row, [])).toContain('Rulebook: unavailable');
  expect(approvalText(row)).toBe(`AnyRoute approval ${row.id}\nIntent: ${JSON.stringify(row.intent).slice(0, 2600)}\nMaximum cost: ${row.maxCostPico} pico-USD\nExpires: ${row.expiresAt.toISOString()}\nStatus: expired`);
});
