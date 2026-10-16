// J185
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TASKS } from '../lib/site-map.js';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('approval surfaces render server-built context with wrapping and existing theme styles', () => {
  for (const path of ['app/agents/Approvals.jsx', 'components/account/AccountInbox.jsx', 'components/nav/AccountDrawer.jsx']) {
    assert.match(read(path), /<ApprovalContext lines=\{(?:row\?|item)\.approval_context\}/);
  }
  const view = read('components/ApprovalContext.jsx');
  assert.match(view, /overflowWrap: 'anywhere'/); assert.match(view, /className="help-text"/);
  assert.doesNotMatch(view, /dangerouslySetInnerHTML|JSON|intent|prompt|arguments/);
});
test('docs, feature index, search and additive API fields explain context and limits', () => {
  assert.match(read('app/docs/page.jsx'), /<ApprovalContextDocs \/>/);
  assert.match(read('components/DocsFeatureIndex.jsx'), /\["approvals", "Approval context"\]/);
  assert.equal(TASKS.find(t => t.id === 'approval-context').href, '/docs/#approvals');
  const docs = read('components/ApprovalContextDocs.jsx');
  for (const text of ['defaults to false', 'rolling 24 hours', 'Monday', 'excludes open holds', 'router still reads ordinary request text']) assert.ok(docs.includes(text), text);
  assert.doesNotMatch(docs, /\b(?:demo|mock|simulated|placeholder|kill|anchored|staking|yield)\b/i);
  const api = JSON.parse(read('public/openapi.json'));
  assert.equal(api.components.schemas.AgentApproval.properties.approval_context.type, 'array');
  assert.ok(api.paths['/api/v1/inbox'].get['x-approval-context']);
});
