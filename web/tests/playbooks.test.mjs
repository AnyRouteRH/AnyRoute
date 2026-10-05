import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EMPTY_RULES, PLAYBOOK_WORDS, deleteRequest, followPath, followRequest, followersText, followsText, linkedPlaybook, ownRules, playbookBody, playbookForm, playbookHref, playbookPath, scopeText, startChoices, startRules } from '../lib/playbooks.js';
import { STARTER_SETUPS, setupPolicy } from '../lib/starter-setups.js';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS, TASKS } from '../lib/site-map.js';
import { AUDIT_ACTIONS, actionLabel } from '../lib/teams.js';

// The router's own schema, where this Node can load TypeScript; a playbook body must never be one it would refuse.
const schema = await import('../../src/agents/policy.ts').then(m => m.agentPolicySchema).catch(() => null);
const accepts = (t, policy) => { if (schema) assert.deepEqual(schema.parse(policy), policy); else t.diagnostic('router schema not loadable here'); };
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const rules = { version: 1, models: { allow: ['author/*'] }, lanes: ['public', 'attested'], caps: { per_request_usd: 0.05, per_day_usd: 5, max_output_tokens: 800 }, approval: { above_usd: 0.5 }, windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }], breakers: { max_denials_per_10min: 5 }, on_breach: 'deny' };
const agents = [
  { key_hash: 'a'.repeat(64), name: 'Support bot', policies: [{ key_hash: 'a'.repeat(64), inherited: false, policy: rules }] },
  { key_hash: 'b'.repeat(64), name: 'No rules', policies: [] },
  { key_hash: 'c'.repeat(64), name: 'Session', policies: [{ key_hash: 'd'.repeat(64), inherited: true, policy: rules }] },
];

test('a new playbook starts from no rules, a starter setup or a key’s own current rules', t => {
  const choices = startChoices(agents);
  assert.equal(choices[0].value, 'empty');
  assert.deepEqual(choices.filter(c => c.group === PLAYBOOK_WORDS.setups).map(c => c.value), STARTER_SETUPS.map(s => 'setup:' + s.id));
  assert.deepEqual(choices.filter(c => c.group === PLAYBOOK_WORDS.keys).map(c => c.value), ['key:' + 'a'.repeat(64)]); // inherited rules are not the key's own
  assert.deepEqual(startRules('empty'), EMPTY_RULES);
  assert.deepEqual(startRules('setup:nope'), EMPTY_RULES);
  for (const s of STARTER_SETUPS) for (const guard of [false, true]) {
    const policy = startRules('setup:' + s.id, [], { guard });
    assert.deepEqual(policy, setupPolicy(s, { guard }));
    accepts(t, policy);
  }
  const copied = startRules('key:' + 'a'.repeat(64), agents);
  assert.deepEqual(copied, rules);
  copied.caps.per_day_usd = 1; // a copy: editing the new playbook never changes the key's rules
  assert.equal(rules.caps.per_day_usd, 5);
  assert.equal(ownRules(agents[1]), null);
});

test('the editor round-trips a playbook’s rules and the body carries a checked name', t => {
  const kept = playbookBody('Support', playbookForm(rules));
  assert.deepEqual(kept, { body: { name: 'Support', policy: rules }, errors: [] }); // rules the editor does not show are kept
  accepts(t, kept.body.policy);
  for (const s of STARTER_SETUPS) {
    const policy = setupPolicy(s, { guard: true });
    assert.deepEqual(playbookBody('x', playbookForm(policy)).body.policy, policy, s.id);
  }
  assert.deepEqual(playbookBody('  Ops  ', playbookForm(null)).body, { name: 'Ops', policy: EMPTY_RULES });
  assert.deepEqual(playbookBody(' ', playbookForm(null)).errors, ['Name: enter a name for this playbook.']);
  assert.deepEqual(playbookBody('x'.repeat(101), playbookForm(null)).errors, ['Name: use at most 100 characters.']);
  assert.match(playbookBody('ok', { ...playbookForm(null), caps: { per_day_usd: '-1' } }).errors.join(' '), /Cap per day/);
});

test('follow, stop following and delete say what happens to the rules before anything is sent', () => {
  const book = { id: 'pb_1', name: 'Support', version: 3, followers: 2, team_id: null };
  assert.deepEqual(followRequest('k/1', book), { path: '/api/v1/agents/k%2F1/playbook', body: { playbook_id: 'pb_1' }, confirm: 'Follow playbook Support? Its rules replace this key’s own rules.' });
  assert.deepEqual(followRequest('k', null).body, { playbook_id: null });
  assert.match(followRequest('k', null).confirm, /keeps the playbook’s current rules as its own/);
  assert.deepEqual(deleteRequest(book), { path: '/api/v1/playbooks/pb_1?unlink=copy', confirm: 'Delete playbook Support? 2 keys follow it; each keeps these rules as its own.' });
  assert.deepEqual(deleteRequest({ ...book, followers: 0 }), { path: '/api/v1/playbooks/pb_1', confirm: 'Delete playbook Support?' });
  assert.equal(followersText(1), '1 key follows it'); assert.equal(followersText(0), '0 keys follow it');
  assert.equal(followsText(book), 'Follows playbook Support');
  assert.equal(playbookHref('pb 1'), '/dashboard/?playbook=pb%201#playbooks');
  assert.equal(playbookPath(), '/api/v1/playbooks'); assert.equal(followPath('k'), '/api/v1/agents/k/playbook');
  assert.equal(scopeText(book), 'Whole account'); assert.equal(scopeText({ team_id: 'team_1' }), 'Team playbook');
  assert.equal(linkedPlaybook('?playbook=pb_1', [book]), 'pb_1');
  assert.equal(linkedPlaybook('?playbook=pb_9', [book]), null);
  assert.equal(linkedPlaybook('', [book]), null);
});

test('Playbooks sits in Keys & limits, with a search task', () => {
  assert.deepEqual(ACCOUNT_GROUPS.find(g => g.id === 'keys').ids.slice(0, 3), ['account-keys', 'rulebook', 'playbooks']);
  assert.equal(ACCOUNT_SECTIONS.find(s => s.taskId === 'playbooks').href, '/dashboard/#playbooks');
  const task = TASKS.find(t => t.id === 'playbooks');
  assert.equal(task.title, 'Share one rulebook across agents'); assert.equal(task.menu, false);
  assert.match(read('components/Dashboard.jsx'), /\{tab === "Playbooks" && <Playbooks /);
});

test('Playbooks has a docs section after starter setups, a feature index link and its API in OpenAPI', () => {
  assert.match(read('components/DocsFeatureIndex.jsx'), /\["playbooks", "Playbooks"\]/);
  const page = read('app/docs/page.jsx');
  assert.match(page, /<SpendingLimitsDocs \/><DefaultRouteDocs \/><StarterSetupsDocs \/>(?:<\w+Docs \/>)*<PlaybooksDocs \/>/); // in the spending limits group
  assert.equal(page.split('<PlaybooksDocs />').length, 2);
  const docs = read('components/PlaybooksDocs.jsx');
  assert.match(docs, /<section id="playbooks"><h2>Playbooks<\/h2>/);
  for (const phrase of ['GET /api/v1/playbooks', 'POST /api/v1/agents/:key_hash/playbook', '?unlink=copy', 'playbook_followed', 'playbook_linked', 'AGENT_POLICY_ENABLED, which defaults to false', 'Playbook X changed; N keys follow it']) assert.ok(docs.includes(phrase), phrase);
  const spec = JSON.parse(read('public/openapi.json'));
  assert.deepEqual(Object.keys(spec.paths['/api/v1/playbooks']), ['get', 'post']);
  assert.deepEqual(Object.keys(spec.paths['/api/v1/playbooks/{id}']), ['get', 'put', 'delete']);
  assert.ok(spec.paths['/api/v1/agents/{key_hash}/playbook'].post);
  assert.deepEqual(spec.paths['/api/v1/playbooks/{id}'].delete.parameters.find(p => p.name === 'unlink').schema.enum, ['copy']);
  assert.ok(spec.tags.some(t => t.name === 'Playbooks'));
  assert.doesNotMatch(docs, /\b(?:demo|test|tested|local|mock|simulated|placeholder|fixture|kill|killed|earn|yield|APY|x402)\b/i);
});

test('every key and agent shows the playbook it follows or offers one; followed rules are read-only but Stop still works', () => {
  for (const file of ['components/limits/KeyLimits.jsx', 'app/agents/Agents.jsx']) assert.match(read(file), /<FollowPlaybook /, file);
  assert.match(read('components/limits/KeyLimits.jsx'), /locked=\{!!playbook\}/);
  assert.match(read('app/agents/Agents.jsx'), /locked=\{!!agent\.playbook\}/);
  const editor = read('components/limits/SpendingLimits.jsx');
  assert.match(editor, /const disabled = busy \|\| locked;/);
  assert.match(editor, /<StopResume id=\{id\} stop=\{stop\} disabled=\{busy\}\/>/);
});

test('playbook copy is plain and uses the site’s words', () => {
  const copy = [...Object.values(PLAYBOOK_WORDS), read('components/limits/Playbooks.jsx'), read('components/limits/FollowPlaybook.jsx'), TASKS.find(t => t.id === 'playbooks').description].join('\n');
  assert.doesNotMatch(copy, /\b(?:demo|test|tested|local|mock|simulated|placeholder|fixture|kill|killed|earn|yield|APY|x402)\b/i);
});

test('the team audit log names every playbook change the router records', () => {
  const router = fs.readFileSync(new URL('../../src/teams/audit.ts', import.meta.url), 'utf8');
  const recorded = [...router.matchAll(/"(playbook\.[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(recorded, ['playbook.create', 'playbook.update', 'playbook.rename', 'playbook.delete', 'playbook.follow', 'playbook.unfollow']);
  for (const action of recorded) { assert.ok(AUDIT_ACTIONS.includes(action), action); assert.notEqual(actionLabel(action), action); }
  assert.equal(actionLabel('playbook.update'), 'Playbook changed');
});
