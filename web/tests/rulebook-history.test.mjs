import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historyPath, restorePath, savedByLabel, historySource, restoreConfirmation } from '../lib/rulebook-history.js';

test('history targets the selected key and restore asks for a normal save', () => {
  assert.equal(historyPath('key/one'), '/api/v1/agents/key%2Fone/policy/versions');
  assert.equal(restorePath('key/one'), '/api/v1/agents/key%2Fone/policy/restore');
  assert.equal(savedByLabel('abcdef0123456789'), 'Key abcdef012345');
  assert.equal(historySource('approve_and_allow'), 'Approved and allowed next time');
  assert.match(restoreConfirmation('today'), /Restore the rules saved today\?/);
  assert.match(restoreConfirmation('today'), /Stop state and inherited rules still apply/);
});

test('History uses native keyboard controls, confirms restore and shows a playbook note', () => {
  const source = readFileSync(new URL('../components/limits/RulebookHistory.jsx', import.meta.url), 'utf8');
  assert.match(source, /<summary>History<\/summary>/);
  assert.match(source, /window\.confirm\(restoreConfirmation/);
  assert.match(source, /body: \{ sha256: version.sha256 \}/);
  assert.match(source, /This key follows playbook/);
  assert.match(source, /if \(!open \|\| playbook\) return/);
  assert.match(source, /version\.diff\.removed\.map/);
  assert.match(source, /version\.diff\.added\.map/);
  assert.doesNotMatch(source, /JSON\.stringify|<pre|<code/);
});
