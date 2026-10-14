// H171
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { duplicateAgent, duplicateName } from '../lib/duplicate-agent.js';

test('suggests an editable copy name within the key-name length limit', () => {
  assert.equal(duplicateName('Research'), 'Research copy');
  assert.equal(duplicateName(''), 'Unnamed agent copy');
  assert.equal(duplicateName('x'.repeat(100)).length, 100);
});
test('duplicates the selected agent with the edited name and refuses invalid names', async () => {
  let call;
  const result = await duplicateAgent(async (...args) => { call = args; return { key: 'one-time', data: { hash: 'fresh' } }; }, 'agent hash', '  Next agent  ');
  assert.deepEqual(call, ['/api/v1/agents/agent%20hash/duplicate', { method: 'POST', body: { name: 'Next agent' } }]);
  assert.equal(result.data.hash, 'fresh');
  for (const name of ['', ' ', 'x'.repeat(101)]) await assert.rejects(() => duplicateAgent(() => { throw new Error('must not send'); }, 'hash', name), /Choose a name/);
});
test('Agents uses an accessible dialog, existing reveal controls and memory-only secret state', () => {
  const component = readFileSync(new URL('../components/agents/DuplicateAgent.jsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/agents/Agents.jsx', import.meta.url), 'utf8');
  assert.match(page, /!agent.approval_only && <DuplicateAgent/);
  assert.match(component, /<Modal title=/);
  assert.match(component, /htmlFor=\{id \+ '-name'\}/);
  assert.match(component, /maxLength=\{100\} required/);
  assert.match(component, /setSecret\(''\)/);
  assert.match(component, /<CopyButton text=\{secret\}/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|console\./);
});
test('docs, search and OpenAPI describe duplication and its limits', () => {
  const schema = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  const operation = schema.paths['/api/v1/agents/{key}/duplicate'].post;
  assert.ok(operation.responses['201']); assert.ok(operation.responses['403']); assert.ok(operation.responses['409']);
  assert.deepEqual(operation.security, [{ BearerAuth: [] }]);
  const docs = readFileSync(new URL('../components/DuplicateAgentDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /id="duplicate-agent"/); assert.match(docs, /same account balance/);
});
