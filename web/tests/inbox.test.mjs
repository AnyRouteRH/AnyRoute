import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import InboxTrigger from '../components/account/InboxTrigger.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxBadge, inboxPage, markInboxSeen, readInbox, readSeen, decideInboxApproval } from '../lib/inbox.js';
import { sectionFromHash } from '../components/account/account-state.js';
import { ACCOUNT_GROUPS, TASKS } from '../lib/site-map.js';
const scope = 'a'.repeat(64), other = 'b'.repeat(64), at = '2026-09-28T12:00:00.000Z';
const page = { data: [], count: 0, as_of: at, seen_scope: scope };
function storage() { const data = new Map(); return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), data }; }
test('badge count hides zero in the UI and caps its visible label without changing the accessible total', () => {
  assert.equal(inboxBadge(0), '0'); assert.equal(inboxBadge(1), '1'); assert.equal(inboxBadge(99), '99'); assert.equal(inboxBadge(100), '99+');
  assert.throws(() => inboxPage({ ...page, count: -1 })); assert.throws(() => inboxPage({ ...page, seen_scope: 'invalid' }));
});
test('mark seen posts the displayed snapshot and stores only its timestamp in the matching visibility scope', async () => {
  const store = storage(), calls = [];
  const request = async (...args) => { calls.push(args); return { seen_at: at, seen_scope: scope }; };
  await markInboxSeen(request, store, page);
  assert.deepEqual(calls, [['/api/v1/inbox/seen?through=' + encodeURIComponent(at), { method: 'POST' }]]);
  assert.deepEqual([...store.data.values()], [at]); assert.equal(readSeen(store, scope), at); assert.equal(readSeen(store, other), '');
  await assert.rejects(markInboxSeen(async () => ({ seen_at: at, seen_scope: other }), store, page));
  const older = { ...page, as_of: '2026-09-27T12:00:00.000Z' };
  await markInboxSeen(async () => ({ seen_at: older.as_of, seen_scope: scope }), store, older); assert.equal(readSeen(store, scope), at);
});
test('read finds the account/team/key bookmark before requesting new events; unavailable storage still reads', async () => {
  const store = storage(); await markInboxSeen(async () => ({ seen_at: at, seen_scope: scope }), store, page);
  const calls = []; await readInbox(async path => { calls.push(path); return page; }, store);
  assert.deepEqual(calls, ['/api/v1/inbox', '/api/v1/inbox?since=' + encodeURIComponent(at)]);
  calls.length = 0; await readInbox(async path => { calls.push(path); return { ...page, seen_scope: other }; }, store); assert.equal(calls.length, 1);
  assert.equal(readSeen({ getItem() { throw new Error('blocked'); } }, scope), '');
  assert.equal(readSeen({ getItem: () => 'invalid' }, scope), '');
});
test('approve and deny from inbox call only the existing single-use approval endpoint', async () => {
  const calls = [], request = async (...args) => calls.push(args);
  await decideInboxApproval(request, 'id/one', 'approve'); await decideInboxApproval(request, 'id/two', 'deny');
  assert.deepEqual(calls, [['/api/v1/agents/approvals/id%2Fone/approve', { method: 'POST' }], ['/api/v1/agents/approvals/id%2Ftwo/deny', { method: 'POST' }]]);
  await assert.rejects(decideInboxApproval(request, 'id', 'used')); assert.equal(calls.length, 2);
});
test('inbox is a real account section and a searchable task in the API account group', () => {
  assert.equal(sectionFromHash('#inbox'), 'Inbox'); assert.ok(ACCOUNT_GROUPS.find(group => group.title === 'Overview').ids.includes('inbox'));
  const task = TASKS.find(task => task.id === 'inbox'); assert.equal(task.title, 'Check your inbox'); assert.equal(task.group, 'build'); assert.equal(task.href, '/dashboard/#inbox');
});

test('header trigger hides when signed out and renders honest loading, failure, zero and capped count states', () => {
  const render = props => renderToStaticMarkup(h(InboxTrigger, { connected: true, badgeClass: 'badge', ...props }));
  assert.equal(render({ connected: false, count: 5 }), '');
  assert.match(render({}), /Reading count/); assert.match(render({ error: 'unavailable' }), /Count unavailable/);
  assert.doesNotMatch(render({ count: 0 }), /class="badge"/);
  assert.match(render({ count: 1 }), /1 item needs attention/);
  const html = render({ count: 123, open: true }); assert.match(html, /123 items need attention/); assert.match(html, />99\+</); assert.match(html, /aria-haspopup="dialog"/); assert.match(html, /aria-expanded="true"/);
});
