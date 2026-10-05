import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LABS, READING, STATUS_PATH, UNREAD, labRows, loadLabRows } from '../lib/labs.js';
import { TASKS, menuTasks } from '../lib/site-map.js';

// The shape of GET /api/v1/status at anyroute.tech, cut to the fields Labs reads.
const live = () => ({
  agent_guard: { enabled: true },
  agent_pay: { enabled: false },
  per_call: { configured: false, x402: { configured: false } },
  tools: { enabled: false, ready: false },
  decision_tags: { enabled: false },
  data_tools: { enabled: false },
  makegood: { enabled: false },
  identity: { enabled: false },
  commerce: { enabled: false },
  facilitator: { enabled: false },
});
const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));

test('each live row reads its own status field and says which', () => {
  const rows = byId(labRows(live()));
  assert.deepEqual(Object.values(rows).filter(r => r.source === 'status').map(r => [r.id, r.field]), [
    ['agent-guard', 'agent_guard.enabled'], ['agent-pay', 'agent_pay.enabled'], ['x402', 'per_call.x402.configured'], ['paid-tools', 'tools.ready'],
    ['decision-tags', 'decision_tags.enabled'], ['data-tools', 'data_tools.enabled'], ['make-good', 'makegood.enabled'],
    ['identity', 'identity.enabled'], ['commerce', 'commerce.enabled'], ['facilitator', 'facilitator.enabled'],
  ]);
  assert.deepEqual([rows['agent-guard'].state, rows['agent-guard'].label], ['on', 'On']);
  for (const id of ['agent-pay', 'paid-tools', 'decision-tags', 'data-tools', 'make-good', 'identity', 'commerce', 'facilitator']) assert.deepEqual([rows[id].state, rows[id].label], ['off', 'Off'], id);
  // Flipping one field flips only its row.
  const on = byId(labRows({ ...live(), makegood: { enabled: true } }));
  assert.equal(on['make-good'].state, 'on'); assert.equal(on.commerce.state, 'off');
});

test('x402 per-call payment is described as not live unless the status says it is configured', () => {
  const off = byId(labRows(live())).x402;
  assert.deepEqual([off.state, off.label], ['off', 'Not live']); assert.match(off.blurb, /^Built, not live\./);
  for (const phase of ['loading', 'error']) assert.match(byId(labRows(null, phase)).x402.blurb, /not live/);
  const on = byId(labRows({ ...live(), per_call: { configured: true, x402: { configured: true } } })).x402;
  assert.deepEqual([on.state, on.label], ['on', 'On']); assert.doesNotMatch(on.blurb, /not live/);
});

test('an absent Agent Guard section reads as off; any other missing field is not reported, never guessed', () => {
  const { agent_guard, agent_pay, decision_tags, ...rest } = live();
  const rows = byId(labRows(rest));
  assert.deepEqual([rows['agent-guard'].state, rows['agent-guard'].label], ['off', 'Off']);
  assert.deepEqual([rows['agent-pay'].state, rows['agent-pay'].label], ['off', 'Off']); // a router from before it
  assert.equal(byId(labRows({ ...live(), agent_pay: { enabled: true } }))['agent-pay'].state, 'on');
  assert.match(rows['agent-pay'].blurb, /Anyroute never holds the money\./);
  assert.deepEqual([rows['decision-tags'].state, rows['decision-tags'].label], ['unknown', 'Not reported']);
  assert.equal(byId(labRows({ ...live(), commerce: { enabled: 'yes' } })).commerce.state, 'unknown');
});

test('documented rows carry their documented state, whatever the status says', () => {
  for (const data of [live(), null]) {
    const rows = byId(labRows(data, data ? 'ready' : 'error'));
    assert.deepEqual([rows.zkapi.state, rows.zkapi.label, rows.zkapi.source, rows.zkapi.field], ['pilot', 'Pilot', 'docs', null]);
    assert.deepEqual([rows['host-bonds'].state, rows['host-bonds'].label], ['off', 'Off']);
    assert.match(rows['host-bonds'].blurb, /^Switched off/);
  }
});

test('before the status answers, or when it cannot be read, no live row says on or off', () => {
  for (const [phase, state, label] of [['loading', 'loading', 'Reading…'], ['error', 'unknown', 'Unknown']]) {
    for (const row of labRows(null, phase).filter(r => r.source === 'status')) assert.deepEqual([row.state, row.label], [state, label], row.id);
  }
  assert.ok(labRows(undefined, 'ready').filter(r => r.source === 'status').every(r => r.state === 'unknown'));
});

test('loading reads GET /api/v1/status once and falls back to "Couldn’t read live status" on any failure', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push([url, init.headers.accept]); return { ok: true, json: async () => ({ data: live() }) }; };
  const got = await loadLabRows('https://router.example', ok);
  assert.deepEqual(calls, [['https://router.example' + STATUS_PATH, 'application/json']]);
  assert.equal(got.phase, 'ready'); assert.equal(byId(got.rows)['agent-guard'].state, 'on');
  for (const fail of [async () => { throw new TypeError('network'); }, async () => ({ ok: false, status: 503 }), async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }), async () => ({ ok: true, json: async () => ({}) })]) {
    const r = await loadLabRows('', fail);
    assert.equal(r.phase, 'error'); assert.ok(r.rows.filter(row => row.source === 'status').every(row => row.state === 'unknown'));
  }
  await assert.rejects(loadLabRows('', async () => { throw Object.assign(new Error('stop'), { name: 'AbortError' }); }), { name: 'AbortError' });
  assert.equal(UNREAD, 'Couldn’t read live status'); assert.equal(READING, 'Reading live status…');
});

test('the page is static, titled, links each row to existing docs, and keeps public wording', () => {
  const page = fs.readFileSync('app/labs/page.jsx', 'utf8'), board = fs.readFileSync('app/labs/LabsBoard.jsx', 'utf8');
  assert.match(page, /title: "Labs — Anyroute"/); assert.doesNotMatch(page, /use client|dynamic\s*=/);
  assert.match(board, /^"use client";/); assert.match(board, /UNREAD/);
  const docs = ['app/docs/page.jsx', ...fs.readdirSync('components').filter(f => f.endsWith('Docs.jsx')).map(f => 'components/' + f)].map(f => fs.readFileSync(f, 'utf8')).join('\n');
  for (const { id, href } of LABS) {
    const [route, anchor] = href.split('#');
    assert.ok(fs.existsSync(`app${route}page.jsx`), id);
    if (anchor) assert.ok(docs.includes(`id="${anchor}"`), href);
  }
  const banned = new RegExp(String.raw`\b(?:${['de' + 'mo', 'te' + 'st', 'te' + 'sted', 'lo' + 'cal', 'mo' + 'ck', 'simu' + 'lated', 'place' + 'holder', 'fix' + 'ture', 'ki' + 'll', 'ea' + 'rn', 'yi' + 'eld', 'A' + 'PY', 'ret' + 'urns', 'pri' + 'vate', 'depo' + 'sits?'].join('|')})\b|no lo` + 'gs', 'i');
  const copy = [page, board.replace(/import[^\n]*\n/g, ''), ...LABS.flatMap(l => [l.name, typeof l.blurb === 'function' ? [l.blurb(true), l.blurb(false)] : l.blurb]).flat()].join('\n');
  assert.doesNotMatch(copy, banned);
});

test('search finds Labs, and it sits low in the Learn menu', () => {
  const task = TASKS.find(t => t.id === 'labs');
  assert.equal(task.href, '/labs/'); assert.equal(task.group, 'learn'); assert.equal(task.featured, false);
  const learn = menuTasks('learn');
  assert.equal(learn.at(-1), task); assert.ok(learn.length <= 9);
});
