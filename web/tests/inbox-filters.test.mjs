// H173
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterUrl, inboxGroup, markAllRead, projectInbox, selectedKinds, undoMarkAllRead } from '../lib/inbox-filters.js';
import { readInbox, readSeen } from '../lib/inbox.js';
import { TASKS } from '../lib/site-map.js';
const scope = 'a'.repeat(64), other = 'b'.repeat(64), at = '2026-10-01T12:00:00.000Z';
const page = { as_of: at, seen_scope: scope, count: 3, data: [
  { id: 'approval:1', kind: 'approval', status: 'pending', at: '2026-10-01T11:00:00.000Z', unread: true, can_decide: true },
  { id: 'deposit:1', kind: 'deposit', at, unread: true }, { id: 'notice:1', kind: 'new_kind', at, unread: true },
] };
function storage() { const data = new Map(); return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; }
const echo = async () => ({ seen_at: at, seen_scope: scope });
test('URL filters support multiple chips, preserve unrelated query and hash, and clear with All', () => {
  assert.deepEqual(selectedKinds('?other=1&kinds=money,approvals,money'), ['money', 'approvals']);
  assert.deepEqual(selectedKinds('?kinds=%3Cscript%3E'), []);
  assert.equal(filterUrl('https://anyroute.tech/dashboard/?tab=1#inbox', ['models', 'agents']), '/dashboard/?tab=1&kinds=models%2Cagents#inbox');
  assert.equal(filterUrl('https://anyroute.tech/dashboard/?tab=1&kinds=money#inbox', []), '/dashboard/?tab=1#inbox');
});
test('counts cover the whole snapshot, unknown kinds go to Other and read approvals remain actionable', () => {
  assert.equal(inboxGroup('new_kind'), 'other'); assert.equal(inboxGroup('__proto__'), 'other');
  const result = projectInbox(page, at, ['approvals']);
  assert.deepEqual(result.filters.counts, { approvals: 1, agents: 0, money: 1, security: 0, models: 0, other: 1 });
  assert.equal(result.data.length, 1); assert.equal(result.data[0].unread, false); assert.equal(result.data[0].can_decide, true);
  assert.equal(result.data[0].status, 'pending'); assert.equal(page.data[0].unread, true);
  assert.equal(result.count, 2); // Header total is independent of the selected chips.
  assert.equal(projectInbox(page, '', ['other']).data[0].id, 'notice:1');
  assert.equal(projectInbox(page, '', []).data.length, 3);
});
test('mark all uses the full snapshot, separates account/key scopes, and undo restores only its bookmark', async () => {
  const store = storage(), calls = [], request = async (...args) => { calls.push(args); return echo(); };
  const token = await markAllRead(request, store, projectInbox(page, '', ['models']).filters.snapshot, () => 1000);
  assert.deepEqual(calls, [['/api/v1/inbox/seen?through=' + encodeURIComponent(at), { method: 'POST' }]]);
  assert.equal(token.expires, 11000); assert.deepEqual([...store.data.values()], [at]);
  assert.equal(readSeen(store, other), '');
  assert.equal(undoMarkAllRead(store, token, other, () => 2000), false);
  assert.equal(readSeen(store, scope), at);
  assert.equal(undoMarkAllRead(store, token, scope, () => 10999), true);
  assert.equal(readSeen(store, scope), '');
  const old = '2026-09-30T12:00:00.000Z'; store.setItem('anyroute-inbox-seen-v1:' + scope, old);
  const next = await markAllRead(echo, store, page, () => 1000);
  assert.equal(undoMarkAllRead(store, next, scope, () => 3000), true); assert.equal(readSeen(store, scope), old);
});
test('undo expires at ten seconds and never overwrites a newer mark in another view', async () => {
  const store = storage(), token = await markAllRead(echo, store, page, () => 1000);
  assert.equal(undoMarkAllRead(store, token, scope, () => 11000), false); assert.equal(readSeen(store, scope), at);
  store.setItem('anyroute-inbox-seen-v1:' + scope, '2026-10-02T12:00:00.000Z');
  assert.equal(undoMarkAllRead(store, token, scope, () => 2000), false);
  assert.equal(readSeen(store, scope), '2026-10-02T12:00:00.000Z');
});
test('read uses the bookmark for the bell too, keeps pending decisions and includes arrivals after the snapshot', async () => {
  const store = storage(); await markAllRead(echo, store, page);
  const later = { kind: 'security', at: '2026-10-01T12:00:01.000Z', unread: true };
  const result = await readInbox(async path => path.includes('since=') ? { ...page, count: 2, data: [page.data[0], later] } : page, store);
  assert.equal(result.count, 1); assert.equal(result.data[0].unread, false); assert.equal(result.data[0].can_decide, true); assert.equal(result.data[1], later);
  assert.equal(undoMarkAllRead(store, await markAllRead(echo, store, page), scope), true);
});
test('failed auth, changed scope or blocked storage cannot create a successful undo', async () => {
  const store = storage();
  await assert.rejects(markAllRead(async () => { throw new Error('Unauthorized'); }, store, page), /Unauthorized/);
  await assert.rejects(markAllRead(async () => ({ seen_at: at, seen_scope: other }), store, page));
  await assert.rejects(markAllRead(echo, { getItem: () => null, setItem: () => { throw new Error('Storage blocked'); } }, page), /Storage blocked/);
  assert.equal(store.data.size, 0);
});
test('account integration has accessible chips, a timed undo, visible decision state and docs search', () => {
  const component = readFileSync(new URL('../components/account/InboxFilters.jsx', import.meta.url), 'utf8');
  assert.match(component, /role="group" aria-label="Filter inbox by kind"/); assert.match(component, /aria-pressed=/);
  assert.match(component, /popstate|INBOX_FILTER_EVENT/); assert.match(component, /setTimeout/); assert.match(component, /currentKey.current === key/);
  assert.match(component, /Needs a decision/); assert.match(component, /Mark all read/);
  const css = readFileSync(new URL('../components/account/InboxFilters.module.css', import.meta.url), 'utf8');
  assert.match(css, /flex-wrap: wrap/); assert.match(css, /min-height: 44px/); assert.match(css, /focus-visible/);
  assert.equal(TASKS.find(task => task.id === 'inbox-filters').href, '/docs/#inbox-filters');
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  assert(spec.paths['/api/v1/inbox'].get.parameters.some(param => param.name === 'kinds'));
});
