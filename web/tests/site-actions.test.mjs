import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, TASKS } from '../lib/site-map.js';
import { SITE_ACTIONS, actionHref, agentChoices, agentLink, agentQuestion, filterChoices, firstStep, focusSelector, loadAgents, modelChoices, needsSignIn, receiptIdFromQuery, runAgentCommand, searchAll, startHref } from '../lib/site-actions.js';
import { confirmKill, FEATURE_OFF } from '../lib/agents.js';
import { LIMIT_WORDS } from '../lib/spending-limits.js';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const ids = rows => rows.map(row => row.id);
const byId = id => SITE_ACTIONS.find(action => action.id === id);
const HASH = 'a'.repeat(64);
const agent = (name, more = {}) => ({ key_hash: HASH, name, has_policy: true, killed: false, ...more });
function recorder(reply = { data: [] }) {
  const calls = [];
  const request = async (url, options = {}) => { calls.push([url, options]); return reply; };
  return { calls, request };
}

test('the seven actions come from the site map, each tied to an existing task and page', () => {
  assert.deepEqual(ids(SITE_ACTIONS), ['add-funds', 'new-key', 'set-limit', 'stop-agent', 'resume-agent', 'open-receipt', 'chat-model', 'default-route']);
  assert.equal(SITE_ACTIONS.length, ACTIONS.length);
  const taskIds = new Set(TASKS.map(task => task.id));
  for (const action of SITE_ACTIONS) {
    assert.ok(taskIds.has(action.task), action.id);
    assert.ok(!taskIds.has(action.id), `${action.id} clashes with a task id`);
    assert.equal(action.page, TASKS.find(task => task.id === action.task).href);
    assert.ok(fs.existsSync(path.join(root, 'app', action.page.split(/[?#]/)[0], 'page.jsx')), action.page);
    assert.ok(action.title.length <= 40 && action.description.length <= 90, action.id);
  }
  assert.equal(new Set(ids(SITE_ACTIONS)).size, SITE_ACTIONS.length);
});

test('action copy follows the wording rules: Anyroute, Chat, Stop, and no banned words', () => {
  for (const action of SITE_ACTIONS) {
    const shown = [action.title, action.description].join(' ');
    assert.doesNotMatch([shown, ...action.keywords].join(' '), /\b(?:earn|yield|APY|returns|passive|demo|test|tested|local|mock|simulated|placeholder|fixture|private|no logs|bond|bonds|x402|decentralized|trustless)\b/i, action.id);
    assert.doesNotMatch(shown, /\b(?:kill|harness)\b/i, action.id);
  }
  assert.doesNotMatch(read('components/nav/SiteSearch.jsx').replace(/^import .*$/gm, ''), /\b(?:kill|Harness|demo|mock|simulated|private|no logs)\b/);
});

test('natural queries find the actions', () => {
  const top = (query, n = 1) => ids(searchAll(query)).slice(0, n);
  assert.deepEqual(top('add money'), ['add-funds']);
  assert.deepEqual(top('top up'), ['add-funds']);
  assert.deepEqual(top('new key'), ['new-key']);
  assert.deepEqual(top('stop agent'), ['stop-agent']);
  assert.deepEqual(top('kill agent'), ['stop-agent']);
  assert.deepEqual(top('resume'), ['resume-agent']);
  assert.ok(top('limit', 3).includes('set-limit'));
  assert.deepEqual(top('receipt'), ['open-receipt']);
  assert.deepEqual(top('model'), ['chat-model']);
  assert.deepEqual(top('switch model'), ['chat-model']);
  assert.deepEqual(top('route'), ['default-route']);
  assert.ok(ids(searchAll('receipt')).includes('receipt'), 'links still follow the actions');
});

test('an empty query lists the actions, then the featured tasks', () => {
  assert.deepEqual(ids(searchAll('')), [...ids(SITE_ACTIONS), ...ids(TASKS.filter(task => task.featured))]);
});

test('a receipt id typed into search opens that receipt', () => {
  const id = 'gen-1730000000-AbC_d-9xyzQ';
  assert.equal(receiptIdFromQuery(id), id);
  assert.equal(receiptIdFromQuery('receipt abc12345'), 'abc12345');
  assert.equal(receiptIdFromQuery('reciept 98765432'), '98765432');
  for (const query of ['model llama-3-70b-instruct', 'receipt', 'receipt abc', 'claude-3-5-sonnet', 'gen-']) assert.equal(receiptIdFromQuery(query), '', query);
  const [first, ...rest] = searchAll(id);
  assert.equal(first.id, 'open-receipt'); assert.equal(first.prefill, id); assert.equal(rest.length, 0);
  assert.equal(actionHref(first, first.prefill), `/verify/?r=${id}#v-saw`);
  assert.equal(searchAll(`receipt ${id}`)[0].prefill, id);
});

test('signed out, every action that needs a key says so and goes to its own sign-in page; nothing else is locked', () => {
  const locked = SITE_ACTIONS.filter(action => needsSignIn(action, false)).map(action => action.id);
  assert.deepEqual(locked, ['add-funds', 'new-key', 'set-limit', 'stop-agent', 'resume-agent', 'default-route']);
  for (const action of SITE_ACTIONS) assert.equal(needsSignIn(action, true), false, action.id);
  assert.equal(startHref(byId('add-funds')), '/dashboard/#payments');
  assert.equal(startHref(byId('new-key')), '/dashboard/?new=key#api-keys');
  for (const id of ['set-limit', 'stop-agent', 'resume-agent', 'default-route']) assert.equal(startHref(byId(id)), '/agents/');
  assert.equal(firstStep(byId('add-funds')), null);
  assert.equal(firstStep(byId('open-receipt')), 'input');
  assert.equal(firstStep(byId('chat-model')), 'pick');
});

test('each action opens the right screen with the choice filled in, and never puts a key in a link', () => {
  assert.equal(actionHref(byId('add-funds')), '/dashboard/#payments');
  assert.equal(actionHref(byId('new-key')), '/dashboard/?new=key#api-keys');
  assert.equal(actionHref(byId('set-limit'), HASH), `/agents/?agent=${HASH}&focus=limits`);
  assert.equal(actionHref(byId('default-route'), HASH), `/agents/?agent=${HASH}&focus=route`);
  assert.equal(actionHref({ ...byId('stop-agent'), focus: null }, HASH), `/agents/?agent=${HASH}`);
  assert.equal(actionHref(byId('chat-model'), 'meta-llama/llama-3.1-8b-instruct:free'), '/harness/?model=meta-llama%2Fllama-3.1-8b-instruct%3Afree');
  assert.equal(actionHref(byId('open-receipt'), 'gen-1-a b'), null);
  for (const action of SITE_ACTIONS.filter(item => item.pick)) {
    for (const bad of ['', '  ', 'sk-ar-v1-' + 'f'.repeat(64), '<script>', 'a/../../b?c=d', 'two words']) assert.equal(actionHref(action, bad), null, `${action.id} ${bad}`);
  }
});

test('the agent pick step greys out agents Stop or Resume cannot act on, with the page’s reasons', () => {
  const rows = [agent('Stopped one', { killed: true, key_hash: 'b'.repeat(64) }), agent('No limits', { has_policy: false, key_hash: 'c'.repeat(64) }), agent('Research'), { name: 'bad hash', key_hash: '../x' }];
  const stop = agentChoices(rows, byId('stop-agent'));
  assert.deepEqual(stop.map(choice => [choice.title, choice.disabled]), [['Research', false], ['Stopped one', true], ['No limits', true]]);
  assert.equal(stop[2].note, LIMIT_WORDS.stopFirst);
  const resume = agentChoices(rows, byId('resume-agent'));
  assert.deepEqual(resume.map(choice => [choice.title, choice.disabled]), [['Stopped one', false], ['No limits', true], ['Research', true]]);
  assert.ok(agentChoices(rows, byId('default-route')).every(choice => !choice.disabled));
  assert.deepEqual(ids(filterChoices('resea', stop)), [HASH]);
  assert.equal(agentChoices([{ key_hash: HASH }], byId('set-limit'))[0].title, 'Unnamed agent');
});

test('the model pick step lists models Chat can use', () => {
  const choices = modelChoices([{ id: 'acme/fast-1', name: 'Fast 1', author: 'Acme', type: 'General' }, { id: 'acme/embed', name: 'Embed', author: 'Acme', type: 'Embeddings' }, { id: 'acme/away', name: 'Away', author: 'Acme', type: 'General', availability: 'temporarily_unavailable' }]);
  assert.deepEqual(ids(choices), ['acme/fast-1']);
  assert.deepEqual(ids(filterChoices('fast', choices)), ['acme/fast-1']);
  assert.ok(filterChoices('', Array.from({ length: 80 }, (_, i) => ({ id: 'm' + i, title: 'M' + i, description: '', keywords: ['m'], featured: true }))).length === 50);
});

test('Stop asks the same words as the /agents page; Resume asks before acting', async () => {
  const research = agent('Research');
  let asked = '';
  await confirmKill(research, '', message => { asked = message; return false; }, async () => {});
  assert.equal(agentQuestion('stop', research), asked);
  assert.match(agentQuestion('resume', research), /^Resume Research\? /);
  assert.match(agentQuestion('stop', { key_hash: HASH }), /^Stop this key\?/);
});

test('Stop and Resume call the existing API only after the confirm step, and only signed in', async () => {
  const research = agent('Research');
  for (const options of [{}, { confirmed: false, signedIn: true }, { confirmed: 'yes', signedIn: true }, { confirmed: true, signedIn: false }]) {
    const { calls, request } = recorder();
    assert.equal(await runAgentCommand('stop', research, request, options), false);
    assert.equal(await runAgentCommand('resume', research, request, options), false);
    assert.equal(calls.length, 0);
  }
  const { calls, request } = recorder();
  assert.equal(await runAgentCommand('stop', research, request, { confirmed: true, signedIn: true }), true);
  assert.equal(await runAgentCommand('resume', research, request, { confirmed: true, signedIn: true }), true);
  assert.equal(await runAgentCommand('delete', research, request, { confirmed: true, signedIn: true }), false);
  assert.deepEqual(calls, [[`/api/v1/agents/${HASH}/kill`, { method: 'POST', body: {} }], [`/api/v1/agents/${HASH}/resume`, { method: 'POST' }]]);
});

test('signed out, the agent list is never requested', async () => {
  const { calls, request } = recorder({ data: [agent('Research')] });
  assert.deepEqual(await loadAgents(request, false), { state: 'signin', rows: [] });
  assert.equal(calls.length, 0);
  assert.deepEqual(await loadAgents(request, true), { state: 'ok', rows: [agent('Research')] });
  assert.deepEqual(calls.map(call => call[0]), ['/api/v1/agents']);
  const off = await loadAgents(async () => { throw Object.assign(new Error('no'), { status: 404, type: 'not_found' }); }, true);
  assert.deepEqual(off, { state: 'off', rows: [], error: FEATURE_OFF });
  const bad = await loadAgents(async () => ({ data: {} }), true);
  assert.equal(bad.state, 'error');
});

test('the /agents link selects one agent and focuses its spending limits or default route', () => {
  assert.deepEqual(agentLink(`?agent=${HASH}&focus=route`), { agent: HASH, focus: 'route' });
  assert.deepEqual(agentLink(`agent=${HASH}&focus=constructor`), { agent: HASH, focus: null });
  for (const search of ['', '?focus=route', '?agent=../x', '?agent=sk-ar-v1-abc']) assert.equal(agentLink(search), null, search);
  assert.equal(focusSelector('route', 'rulebook'), 'input[name="rulebook-route-default"]:checked');
  assert.equal(focusSelector('limits', 'rulebook'), '#rulebook-per_request_usd');
  assert.equal(focusSelector('nope', 'rulebook'), null);
});

test('the target pages read the links the actions make', () => {
  const agents = read('app/agents/Agents.jsx');
  assert.match(agents, /agentLink\(location\.search\)/);
  assert.match(agents, /<SpendingLimits id="rulebook"/);
  assert.match(read('components/limits/SpendingLimits.jsx'), /id=\{`\$\{id\}-\$\{k\}`\}/);
  assert.match(read('components/limits/RouteDefault.jsx'), /name=\{`\$\{id\}-route-default`\}/);
  assert.match(read('components/Dashboard.jsx'), /get\("new"\) !== "key"/);
  assert.match(read('components/Dashboard.jsx'), /setModal\(\{ type: "key" \}\)/);
  assert.match(read('components/Harness.jsx'), /URLSearchParams\(window\.location\.search\)\.get\("model"\)/);
  assert.match(read('lib/privacy.js'), /params\.get\("r"\)/);
  assert.match(read('components/Verify.jsx'), /id="v-saw"/);
});
