import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentStatusParts } from '../lib/agent-status.js';
import { stoppedLabel } from '../lib/stop-until.js';
const base = { key_hash: 'agent-a', stopped: false, work_hours: [], pending_approvals: 0, runway: { today_charged_usd: 0, limits: [], time_zone: 'UTC' }, quiet: null, guard_paused: false };
const cap = { source: 'rulebook', period: 'day', cap_usd: 5, charged_usd: 2.2, remaining_usd: 2.8, estimated_days_left: 0.5, estimated_reaches_at: '2026-10-17T00:00:00Z', resets_at: null };
test('parts with nothing to say are omitted and Working is only the Stop state', () => {
  assert.deepEqual(agentStatusParts(base), [{ kind: 'stop', text: 'Working', href: '/agents/?agent=agent-a#agent-status-stop' }]);
});
test('all sources compose in a consistent order and link to their existing sections', () => {
  const data = { ...base, work_hours: [{ inside: true }], pending_approvals: 1, runway: { ...base.runway, today_charged_usd: 1.2, limits: [cap] }, quiet: { hours: 6 }, guard_paused: true };
  const parts = agentStatusParts(data);
  assert.deepEqual(parts.map(p => p.kind), ['stop', 'hours', 'approvals', 'runway', 'quiet', 'guard']);
  assert.deepEqual(parts.map(p => p.text), ['Working', 'inside work hours', '1 approval waiting', '$1.20 today · $2.20 of $5.00 rolling day cap · estimate: 12 hours left at this pace', 'quiet for 6 hours', 'Agent Guard stopped this agent']);
  assert.deepEqual(parts.map(p => new URL(p.href, 'https://anyroute.invalid').hash), ['#agent-status-stop', '#agent-status-hours', '#approvals', '#agent-status-runway', '#agent-status-quiet-agent-a', '#agent-status-guard']);
  assert.match(parts[3].title, /Estimate:/);
  for (const part of parts) assert.equal(new URL(part.href, 'https://anyroute.invalid').searchParams.get('agent'), 'agent-a');
});
test('Stop uses the existing timed and indefinite wording; outside hours, plural approvals and quiet hours compose', () => {
  const stopped_until = '2026-10-17T09:00:00Z';
  const data = { ...base, stopped: true, stopped_until, work_hours: [{ inside: true }, { inside: false }], pending_approvals: 2, quiet: { hours: 1 } };
  assert.deepEqual(agentStatusParts(data).map(p => p.text), [stoppedLabel(stopped_until), 'outside work hours', '2 approvals waiting', 'quiet for 1 hour']);
  assert.equal(agentStatusParts({ ...base, stopped: true })[0].text, 'Stopped until you resume');
});
test('budget labels separate calendar spending from rolling enforcement and show honest pace states', () => {
  const parts = limits => agentStatusParts({ ...base, runway: { ...base.runway, limits } });
  assert.match(parts([{ ...cap, estimated_days_left: null }])[1].text, /rolling day cap$/);
  assert.match(parts([{ ...cap, remaining_usd: 0, estimated_days_left: 0 }])[1].text, /cap reached$/);
  assert.match(parts([{ ...cap, source: 'key_budget', resets_at: '2026-10-17', reaches_before_reset: false }])[1].text, /daily key budget \(UTC\).*lasts until reset$/);
  assert.equal(agentStatusParts({ ...base, runway: { ...base.runway, today_charged_usd: 0.5 } })[1].text, '$0.50 today');
});
test('both views reuse one component outside the card selection button; stale identity, cleanup and existing targets are guarded', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const agents = read('../app/agents/Agents.jsx'), component = read('../components/AgentStatus.jsx');
  assert.match(agents, /<AgentStatus agent=\{agent\}/); assert.match(agents, /withAgentStatus\(QuietAgentAlert\)/);
  assert.match(component, /<AgentStatus agent=\{props.agent\}\/><QuietAlert/);
  assert.match(agents, /<\/button><SealedBadge.*<QuietAgentAlert/);
  assert.match(component, /state\?\.key === key && state\?\.hash === agent.key_hash/);
  assert.match(component, /ac\.abort\(\)/); assert.match(component, /agent\.approval_only/); assert.match(component, /clearInterval\(timer\)/);
  assert.match(read('../components/AgentStatusTarget.jsx'), /editor\.open = true/);
  for (const id of ['agent-status-stop', 'agent-status-hours', 'agent-status-runway', 'agent-status-guard']) assert.ok(agents.includes('id="' + id + '"'));
  assert.match(read('../components/QuietAgentAlert.jsx'), /agent-status-quiet-/);
  assert.match(read('../components/AgentStatus.module.css'), /overflow-wrap:anywhere/);
  assert.match(read('../components/AgentStatusDocs.jsx'), /id="agent-status"/);
  const spec = JSON.parse(read('../public/openapi.json'));
  assert.equal(spec.paths['/api/v1/agents/{key_hash}/status'].get.operationId, 'agentStatus');
});

test('inherited Stop, work hours and Guard links select the rulebook that manages them', () => {
  const data = { ...base, as_of: '2026-10-16T12:00:00Z', stopped: true, guard_paused: true, work_hours: [{ key_hash: 'parent-agent', inside: false }] };
  const policies = [{ key_hash: 'expired-agent', killed: true, stopped_until: '2026-10-16T11:00:00Z', killed_reason: 'over_action_per_day' }, { key_hash: 'parent-agent', killed: true, killed_reason: 'over_action_per_day' }];
  const parts = agentStatusParts(data, policies);
  for (const part of parts) assert.equal(new URL(part.href, 'https://anyroute.invalid').searchParams.get('agent'), 'parent-agent');
  const until = '2026-10-16T15:00:00Z';
  const timed = agentStatusParts({ ...base, as_of: data.as_of, stopped: true, stopped_until: until }, [...policies, { key_hash: 'timed-agent', killed: true, stopped_until: until }]);
  assert.equal(new URL(timed[0].href, 'https://anyroute.invalid').searchParams.get('agent'), 'timed-agent');
});
