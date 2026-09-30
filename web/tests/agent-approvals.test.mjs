import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingApprovals, decideAgentApproval, intentSummary } from '../lib/agents.js';
test('pending list excludes expired and completed rows and orders oldest first', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const row = { status:'pending',expires_at:'2026-09-30T12:15:00Z',requested_at:'2026-09-30T11:59:00Z' };
  assert.deepEqual(pendingApprovals({ data:[{ ...row,id:'later' },{ ...row,id:'earlier',requested_at:'2026-09-30T11:58:00Z' },{ ...row,id:'used',status:'used' },{ ...row,id:'expired',expires_at:'2026-09-30T12:00:00Z' }] },now).map(r => r.id),['earlier','later']);
  assert.throws(() => pendingApprovals({}),/could not be read/);
});
test('approve and deny post to the selected approval, with no agent-supplied decision body', async () => {
  const calls = []; const request = async (...args) => { calls.push(args); return { data:{ status:'approved' } }; };
  assert.equal((await decideAgentApproval(request,'id/one','approve')).data.status,'approved');
  await decideAgentApproval(request,'id/two','deny');
  assert.deepEqual(calls,[['/api/v1/agents/approvals/id%2Fone/approve',{ method:'POST' }],['/api/v1/agents/approvals/id%2Ftwo/deny',{ method:'POST' }]]);
  await assert.rejects(decideAgentApproval(request,'id','used')); assert.equal(calls.length,2);
});
test('multi-model approval shows every model and lane', () => {
  const summary = intentSummary({ intents:[{ kind:'inference',model:'author/one',lane:'public',est_cost_pico:'10000',tools:[] },{ kind:'inference',model:'author/two',lane:'attested',est_cost_pico:'10000',tools:['read'] }] });
  assert.match(summary,/author\/one/); assert.match(summary,/author\/two/); assert.match(summary,/attested/); assert.match(summary,/read/);
});
