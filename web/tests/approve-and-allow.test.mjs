import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowChangeText, readAllowChange, confirmAllowChange, playbookAllowLink } from '../lib/approve-and-allow.js';
test('exact change includes unrounded request amount and distinguishes model estimates', () => {
  assert.equal(allowChangeText({ field: 'actions.approval_above_usd', before_usd: '5', after_usd: '12.01', amount_usd: '12.001' }), 'Ask-first amount: $5 → $12.01 (this action was $12.001)');
  assert.match(allowChangeText({ before_usd: '0.0001', after_usd: '0.01', amount_usd: '0.001' }), /model call was estimated at \$0.001/);
});
test('preview reads and confirmation submits only reviewed policy hash', async () => {
  const calls = []; const request = async (...args) => { calls.push(args); };
  await readAllowChange(request, 'id/one'); await confirmAllowChange(request, 'id/one', { policy_sha256: 'digest', after_usd: '12' });
  assert.deepEqual(calls, [['/api/v1/agents/approvals/id%2Fone/approve-and-allow', { signal: undefined }], ['/api/v1/agents/approvals/id%2Fone/approve-and-allow', { method: 'POST', body: { policy_sha256: 'digest' } }]]);
  assert.equal(playbookAllowLink('book/one'), '/dashboard/?playbook=book%2Fone#playbooks');
});
test('confirmation and playbook links are wired into both existing approval views', () => {
  for (const file of ['app/agents/Approvals.jsx', 'components/account/AccountInbox.jsx']) assert.match(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /<ApproveAndAllow/);
  const component = readFileSync(new URL('../components/ApproveAndAllow.jsx', import.meta.url), 'utf8');
  assert.match(component, /Confirm and approve/); assert.match(component, /allowChangeText\(change\)/); assert.match(component, /Open playbook/);
});
