import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exactUsd, rulebookWords, rulebookApprovalLine } from '../lib/rulebook-words.js';
import { STARTER_RULEBOOKS } from '../lib/agent-starters.js';
import { GUARD_STARTERS } from '../lib/agent-guard.js';
import { STARTER_SETUPS, setupPolicy, describeRulebook } from '../lib/starter-setups.js';
import { TASKS } from '../lib/site-map.js';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('starter sentences match the shared snapshot, and setup summaries reuse the formatter', () => {
  const snapshot = Object.fromEntries([...STARTER_RULEBOOKS, ...GUARD_STARTERS].map(s => [s.id, rulebookWords(s.policy)]));
  for (const setup of STARTER_SETUPS) for (const guard of [false, true]) {
    const p = setupPolicy(setup, { guard }); const words = rulebookWords(p);
    snapshot[`${setup.id}:${guard}`] = words;
    for (const line of describeRulebook(p, { guard })) if (!['Any reply length', 'No ask-first amount', 'No circuit breakers', 'Any model', 'Any declared tool', 'Any lane', 'Any time', 'Requests that name no lane: Standard provider'].includes(line.text)) assert.ok(words.some(text => line.text.includes(text)), line.text);
  }
  assert.deepEqual(snapshot, JSON.parse(fs.readFileSync(new URL('../../test/fixtures/rulebook-words.json', import.meta.url), 'utf8')));
});
test('amounts preserve their exact decimals and approvals show the payment rules', () => {
  assert.equal(exactUsd(0.005), '$0.005'); assert.equal(exactUsd(1e-12), '$0.000000000001');
  const policy = { version: 1, models: {}, caps: {}, actions: { allow: ['payment.send'], per_action_usd: 20, approval_above_usd: 5 }, on_breach: 'kill' };
  assert.equal(rulebookApprovalLine(policy, true), 'Rulebook: up to $20 a payment; asks above $5');
  assert.ok(rulebookWords(policy).includes('Payments up to $20 each; asks you above $5'));
  assert.equal(rulebookApprovalLine(null), 'Rulebook: unavailable');
});
test('existing UI surfaces use sentences, a keyboard-operable Edit and visible Stop', () => {
  const card = read('components/limits/RulebookSentences.jsx');
  assert.match(card, /<details[^>]*><summary>Edit<\/summary>/); assert.ok(card.indexOf('<StopResume ') < card.indexOf('<details '));
  assert.match(read('app/agents/Agents.jsx'), /<RulebookCard policy=\{policy\}/);
  assert.match(read('app/agents/Agents.jsx'), /editor\.open = true/);
  assert.match(read('components/limits/Playbooks.jsx'), /<RulebookSentences policy=\{p\.policy\}/);
  assert.match(read('app/agents/Approvals.jsx'), /<ApprovalRulebook /);
  assert.match(read('components/limits/ApprovalRulebook.jsx'), /row\.inherited/);
  assert.match(read('components/account/AccountInbox.jsx'), /<InboxApprovalRulebook /);
  assert.match(read('components/limits/InboxRulebooks.jsx'), /item\.kind === 'approval' && item\.can_decide/);
  assert.match(read('components/limits/InboxRulebooks.jsx'), /controller\.abort/);
  for (const file of ['app/agents/Agents.jsx', 'components/limits/Playbooks.jsx']) assert.doesNotMatch(read(file), /View JSON|Hide JSON/);
  assert.match(read('components/limits/RulebookSentences.module.css'), /overflow-wrap: anywhere/);
});
test('docs and search explain the feature and limits without new endpoints or fields', () => {
  assert.match(read('app/docs/page.jsx'), /<RulebookWordsDocs \/>/);
  assert.match(read('components/DocsFeatureIndex.jsx'), /\["rulebook-words", "Rulebooks in plain English"\]/);
  assert.equal(TASKS.find(t => t.id === 'rulebook-words').href, '/docs/#rulebook-words');
  assert.match(read('components/RulebookWordsDocs.jsx'), /AGENT_RULEBOOK_WORDS_ENABLED defaults to false/);
  assert.doesNotMatch(read('components/RulebookWordsDocs.jsx'), /\b(?:demo|mock|simulated|placeholder|kill|anchored|staking|yield)\b/i);
});
