// H172
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bulkAgents, bulkQuestion, confirmAllStops } from '../lib/agent-stop-all.js';
import { TASKS } from '../lib/site-map.js';
const now = new Date('2026-10-14T12:00:00Z');
test('bulk Stop cancels without a request, confirms once and sends existing absolute presets', async () => {
  const calls = []; let confirms = 0;
  const request = async (...args) => { calls.push(args); return { data: { count: 4, message: 'Stopped 4 agents' } }; };
  assert.equal(await confirmAllStops('stop-all', 'hour', 4, () => false, request, now), null); assert.equal(calls.length, 0);
  const result = await confirmAllStops('stop-all', 'hour', 4, text => { confirms++; assert.match(text, /Stop all 4 agents/); return true; }, request, now);
  assert.equal(confirms, 1); assert.equal(result.message, 'Stopped 4 agents'); assert.deepEqual(calls[0], ['/api/v1/agents/stop-all', { method: 'POST', body: { until: '2026-10-14T13:00:00.000Z' } }]);
  await confirmAllStops('stop-all', 'manual', 4, () => true, request, now); assert.deepEqual(calls[1][1].body, {});
  await confirmAllStops('stop-all', 'tomorrow', 4, () => true, request, now); const tomorrow = new Date(calls[2][1].body.until); assert.equal(tomorrow.getHours(), 9); assert.equal(tomorrow.getDate(), new Date(now.getTime() + 86400000).getDate());
  await confirmAllStops('resume-all', 'manual', 4, () => true, request); assert.deepEqual(calls[3], ['/api/v1/agents/resume-all', { method: 'POST' }]);
  await assert.rejects(confirmAllStops('invalid', 'manual', 4, () => true, request));
  assert.match(bulkQuestion('resume-all', 4), /rulebook limits still apply/);
});
test('bulk controls exclude approval-only and absent rulebooks; docs and search describe limits', () => {
  assert.equal(bulkAgents([{ has_policy: true }, { has_policy: false }, { has_policy: true, approval_only: true }]).length, 1);
  assert.equal(TASKS.find(t => t.id === 'stop-all').href, '/docs/#stop-all');
  const docs = readFileSync(new URL('../components/StopAllDocs.jsx', import.meta.url), 'utf8');
  for (const text of ['id="stop-all"', '09:00 tomorrow UTC', 'read-only', 'inference-only', 'session', 'already running', 'notification settings']) assert.ok(docs.toLowerCase().includes(text.toLowerCase()), text);
  const paths = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8')).paths;
  for (const action of ['stop-all', 'resume-all']) assert.deepEqual(paths['/api/v1/agents/' + action].post.security, [{ BearerAuth: [] }]);
});
