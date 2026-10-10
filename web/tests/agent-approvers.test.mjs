import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPROVER_MODES, approversBody, approversPath } from '../lib/agent-approvers.js';
test('approver modes use plain labels and saving excludes stale selections in owner modes', () => {
  assert.deepEqual(APPROVER_MODES.map(([v]) => v), ['owners', 'owners_and_admins', 'specific_members']);
  assert.deepEqual(approversBody('owners', ['member']), { mode: 'owners', member_ids: [] });
  assert.deepEqual(approversBody('specific_members', ['one', 'one', 'two']), { mode: 'specific_members', member_ids: ['one', 'two'] });
  assert.throws(() => approversBody('absent', []));
  assert.equal(approversPath('key/one'), '/api/v1/agents/key%2Fone/approvers');
});
test('keyboard controls, revocation disclosure and read-only approver view are wired into existing Agents', () => {
  const component = readFileSync(new URL('../components/AgentApprovers.jsx', import.meta.url), 'utf8');
  assert.match(component, /<label htmlFor=\{id\}/); assert.match(component, /<select id=\{id\}/);
  assert.match(component, /<fieldset disabled=\{busy\}><legend>Pick teammates/); assert.match(component, /type="checkbox"/);
  const agents = readFileSync(new URL('../app/agents/Agents.jsx', import.meta.url), 'utf8');
  assert.match(agents, /!agent.approval_only && <AgentWorkspace/); assert.match(agents, /<AgentApprovers/);
  const approvals = readFileSync(new URL('../app/agents/Approvals.jsx', import.meta.url), 'utf8'); assert.match(approvals, /row.can_allow !== false && <ApproveAndAllow/);
});
