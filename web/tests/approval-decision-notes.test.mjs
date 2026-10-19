// K186
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setApprovalNote, approvalNoteBody } from '../lib/approval-notes.js';
import { decideAgentApproval, decisionText } from '../lib/agents.js';
import { decideInboxApproval } from '../lib/inbox.js';
import { confirmAllowChange } from '../lib/approve-and-allow.js';
import { TASKS } from '../lib/site-map.js';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
for (const [surface, decide] of [['agents', decideAgentApproval], ['inbox', decideInboxApproval]]) for (const action of ['approve', 'deny']) {
  test(`${surface} ${action} sends an optional plain note and preserves an empty decision's request`, async () => {
    const calls = [], request = async (...args) => { calls.push(args); return { data: { status: action === 'deny' ? 'denied' : 'approved' } }; };
    await decide(request, 'one/id', action);
    assert.deepEqual(calls.at(-1), ['/api/v1/agents/approvals/one%2Fid/' + action, { method: 'POST' }]);
    setApprovalNote(request, 'one/id', '  Check <recipient> first.  ');
    await decide(request, 'one/id', action);
    assert.deepEqual(calls.at(-1)[1], { method: 'POST', body: { decision_note: 'Check <recipient> first.' } });
    setApprovalNote(request, 'one/id', '');
    assert.deepEqual(approvalNoteBody(request, 'one/id'), {});
  });
}
test('approve and allow keeps the confirmation hash and the same note', async () => {
  const calls = [], request = async (...args) => calls.push(args), change = { policy_sha256: 'reviewed-hash' };
  setApprovalNote(request, 'id', 'This amount is fine.');
  await confirmAllowChange(request, 'id', change);
  assert.deepEqual(calls[0][1], { method: 'POST', body: { policy_sha256: 'reviewed-hash', decision_note: 'This amount is fine.' } });
});
test('drafts have no persistence, stay within one signed-in request and one approval, and enforce Unicode length', async () => {
  let calls = 0; const request = async () => calls++, other = async () => {};
  setApprovalNote(request, 'one', '😀'.repeat(280));
  assert.equal(Array.from(approvalNoteBody(request, 'one').decision_note).length, 280);
  assert.deepEqual(approvalNoteBody(request, 'two'), {}); assert.deepEqual(approvalNoteBody(other, 'one'), {});
  for (const value of ['a'.repeat(281), '😀'.repeat(281), 'hidden\u0000text']) {
    setApprovalNote(request, 'one', value);
    await assert.rejects(decideAgentApproval(request, 'one', 'deny'), /280/);
  }
  assert.equal(calls, 0);
  assert.doesNotMatch(read('lib/approval-notes.js'), /localStorage|sessionStorage|fetch\(/);
});
test('decision history uses plain words for approval events and notes', () => {
  assert.equal(decisionText('approval_note_added'), 'Decision note added');
  assert.equal(decisionText('approval_denied'), 'Denied');
});
test('every decision view uses the shared labelled note input with keyboard and narrow-screen support', () => {
  for (const path of ['app/agents/Approvals.jsx', 'components/account/AccountInbox.jsx', 'components/nav/AccountDrawer.jsx']) assert.match(read(path), /<ApprovalDecisionNote request=\{request\} id=\{(?:row.id|item.approval_id)\}/);
  const component = read('components/ApprovalDecisionNote.jsx');
  for (const pattern of [/htmlFor=\{field\}/, /<textarea/, /className="field"/, /aria-describedby/, /280 characters/, /disabled=\{disabled\}/, /width: '100%'/]) assert.match(component, pattern);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|JSON|#[a-f0-9]{3,8}\b/i);
});
test('docs and additive API declarations cover notes, auth, retention and off-by-default Telegram prompts', () => {
  const docs = read('components/ApprovalDecisionNoteDocs.jsx');
  for (const text of ['280', 'TELEGRAM_APPROVAL_NOTES_ENABLED', 'defaults to false', 'five minutes', 'deciding key', '90-day', 'never sends', 'quiet-hours', 'still reads ordinary request text']) assert.ok(docs.includes(text), text);
  assert.doesNotMatch(docs, /\b(?:demo|mock|simulated|placeholder|kill|anchored|staking|yield)\b/i);
  assert.match(read('components/ApprovalContextDocs.jsx'), /href="#approval-notes"/);
  assert.equal(TASKS.find(task => task.id === 'approval-notes').href, '/docs/#approval-notes');
  const api = JSON.parse(read('public/openapi.json'));
  for (const action of ['approve', 'deny', 'approve-and-allow']) assert.equal(api.paths['/api/v1/agents/approvals/{id}/' + action].post.requestBody.content['application/json'].schema.properties.decision_note.maxLength, 280);
  assert.equal(api.components.schemas.AgentApproval.properties.decision_note.maxLength, 280);
  assert.equal(api.paths['/api/v1/agents/approvals/{id}'].get.responses['200'].content['application/json'].schema.properties.data.properties.decision_note.maxLength, 280);
});
