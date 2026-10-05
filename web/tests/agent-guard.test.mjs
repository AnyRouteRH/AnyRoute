import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GUARD_STARTERS, GUARD_LIMIT } from '../lib/agent-guard.js';
import { policyForm, buildPolicy, intentSummary } from '../lib/agents.js';
import { setupsFor } from '../lib/starter-setups.js';
test('guard starters match integration copies and survive model-rulebook edits', () => {
  assert.equal(GUARD_STARTERS.length, 3);
  for (const starter of GUARD_STARTERS) {
    assert.deepEqual(JSON.parse(readFileSync(`../integrations/robinhood-agents/rulebooks/${starter.id}.json`)), starter.policy);
    const { policy, errors } = buildPolicy(policyForm(starter.policy));
    assert.deepEqual(errors, []); assert.deepEqual(policy.actions, starter.policy.actions);
  }
});
test('approval summary shows readable action metadata and amount', () => {
  const summary = intentSummary({ kind: 'action', action: 'trade.order', target: 'NVDA', amount_pico: '360000000000000', details_sha256: 'sha256:' + 'a'.repeat(64) });
  assert.match(summary, /Action: trade.order/); assert.match(summary, /Target: NVDA/); assert.match(summary, /Amount: \$360.00/); assert.match(summary, /Order hash: sha256:/);
});
// U103: the guard starters are folded into Start from a setup, listed only where Guard's section shows.
test('guard starters are status-gated, labeled and use the existing responsive design', () => {
  assert.match(readFileSync('components/limits/SpendingLimits.jsx', 'utf8'), /agent_guard\?\.enabled === true/);
  const ids = guard => setupsFor('agents', { guard }).more.filter(s => s.guardOnly).map(s => s.id);
  assert.deepEqual(ids(false), []); assert.deepEqual(ids(true), GUARD_STARTERS.map(s => s.id));
  const source = readFileSync('components/limits/StarterSetups.jsx', 'utf8');
  assert.match(source, /label htmlFor=\{`\$\{id\}-more-starters`\}/); assert.match(source, /id=\{`\$\{id\}-more-starters`\}/);
  assert.match(source, /role="status"/); assert.match(source, /SpendingLimits.module.css/);
  assert.match(GUARD_LIMIT, /doesn't stop whoever holds the brokerage or wallet keys/);
});
