import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvalHourPath, approvalWindowsPath, approveHour, endApprovalHour, approvalHourText } from '../lib/approval-window.js';
import { TASKS } from '../lib/site-map.js';
test('hour requests encode identifiers and submit only the reviewed confirmation', async () => {
  const calls = [], request = async (...args) => calls.push(args);
  assert.equal(approvalHourPath('one/two'), '/api/v1/agents/approvals/one%2Ftwo/approve-hour');
  assert.equal(approvalWindowsPath('one/two'), '/api/v1/agents/one%2Ftwo/approval-windows');
  await approveHour(request, 'approval', 'digest'); await endApprovalHour(request, 'agent', 'one/two');
  assert.deepEqual(calls, [['/api/v1/agents/approvals/approval/approve-hour', { method: 'POST', body: { confirmation: 'digest' } }], ['/api/v1/agents/agent/approval-windows/one%2Ftwo', { method: 'DELETE' }]]);
  assert.equal(approvalHourText('2026-10-19T00:47:00Z', Date.parse('2026-10-19T00:00:00Z')), 'Approved for the next 47 minutes');
});
test('existing surfaces, documentation and search connect the same controls', () => {
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  for (const path of ['app/agents/Approvals.jsx', 'components/account/AccountInbox.jsx']) assert.match(read(path), /<ApproveForHour/);
  assert.match(read('app/agents/Agents.jsx'), /<ApprovalHours/);
  assert.match(read('components/ApprovalHours.jsx'), /End early/);
  assert.match(read('lib/agent-status.js'), /data.approval_windows/);
  assert.match(read('app/docs/page.jsx'), /<ApprovalHourDocs/);
  assert.equal(TASKS.find(t => t.id === 'approve-hour').href, '/docs/#approvals');
  const api = JSON.parse(read('public/openapi.json'));
  assert.ok(api.paths['/api/v1/agents/approvals/{id}/approve-hour'].post);
  assert.ok(api.paths['/api/v1/agents/{key_hash}/approval-windows/{id}'].delete);
  assert.doesNotMatch(read('components/ApprovalHourDocs.jsx'), /\b(?:demo|mock|simulated|placeholder|kill|anchored|staking|yield)\b/i);
});
