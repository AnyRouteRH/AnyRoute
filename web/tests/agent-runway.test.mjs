import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentRunwayLines } from '../lib/agent-runway.js';
const base = { time_zone: 'UTC', today_charged_usd: 1.2, limits: [] };
const limit = { source: 'rulebook', period: 'day', cap_usd: 5, charged_usd: 1.2, remaining_usd: 3.8, estimated_days_left: 0.125, estimated_reaches_at: '2026-10-14T15:00:00Z', resets_at: null };
test('no caps and zero pace use plain honest words', () => {
  assert.deepEqual(agentRunwayLines(base), ['Today: $1.20 charged · UTC.', 'No caps set.']);
  assert.match(agentRunwayLines({ ...base, limits: [{ ...limit, estimated_days_left: null }] }).join(' '), /No spending pace yet/);
  assert.match(agentRunwayLines({ ...base, limits: [{ ...limit, remaining_usd: 0 }] }).join(' '), /reached this cap/);
});
test('daily time estimates say zone and weekly estimates say pace', () => {
  const daily = agentRunwayLines({ ...base, time_zone: 'America/Toronto', limits: [limit] }).join(' ');
  assert.match(daily, /Estimate:.*Oct 14, 11:00 AM \(America\/Toronto\)/);
  const weekly = agentRunwayLines({ ...base, limits: [{ ...limit, period: 'week', estimated_days_left: 4.1 }] }).join(' ');
  assert.match(weekly, /Rolling week cap/); assert.match(weekly, /about 4 more days at your 7-day pace/);
  assert.match(agentRunwayLines({ ...base, limits: [{ ...limit, period: 'week', estimated_days_left: 0.5 }] }).join(' '), /less than one more day/);
});
test('monthly budget honors UTC reset and per-request caps have no forecast', () => {
  const monthly = agentRunwayLines({ ...base, limits: [{ ...limit, source: 'key_budget', period: 'month', resets_at: '2026-11-01T00:00:00Z', reaches_before_reset: false }] }).join(' ');
  assert.match(monthly, /Calendar month key budget/); assert.match(monthly, /until the next UTC reset/);
  assert.equal(agentRunwayLines({ ...base, limits: [{ ...limit, period: 'request' }] })[1], 'Per request cap: $5.00.');
});
test('cards and detail share the existing Spend renderer; stale identities and aborted requests are guarded', () => {
  const agents = readFileSync(new URL('../app/agents/Agents.jsx', import.meta.url), 'utf8');
  const component = readFileSync(new URL('../components/AgentRunway.jsx', import.meta.url), 'utf8');
  assert.match(agents, /<AgentRunway agent=\{agent\}>/);
  assert.match(component, /state\?\.key === key && state\?\.hash === agent.key_hash/);
  assert.match(component, /ac\.abort\(\)/); assert.match(component, /agent\.approval_only/);
  const docs = readFileSync(new URL('../components/AgentRunwayDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /id="agent-runway"/);
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  assert.equal(spec.paths['/api/v1/agents/{key_hash}/runway'].get.operationId, 'agentRunway');
});
