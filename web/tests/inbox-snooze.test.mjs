// K187
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snoozeUntil, snoozeUrl, snoozedSelected, snoozedInboxPage, snoozeNotice, unsnoozeNotice } from '../lib/inbox-snooze.js';
import { applyInboxReadTime } from '../lib/inbox-read-state.js';
import { projectInbox } from '../lib/inbox-filters.js';
import { TASKS } from '../lib/site-map.js';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('calendar choices use local 9:00, next Monday, and an elapsed hour', () => {
  const now = new Date(2026, 9, 16, 21, 30);
  assert.equal(Date.parse(snoozeUntil('hour', now)) - now.getTime(), 3600000);
  const tomorrow = new Date(snoozeUntil('tomorrow', now)); assert.equal(tomorrow.getDate(), 17); assert.equal(tomorrow.getHours(), 9); assert.equal(tomorrow.getMinutes(), 0);
  const monday = new Date(snoozeUntil('monday', now)); assert.equal(monday.getDay(), 1); assert.equal(monday.getDate(), 19); assert.equal(monday.getHours(), 9);
  assert.equal(new Date(snoozeUntil('monday', new Date(2026, 9, 19, 10))).getDate(), 26);
  assert.throws(() => snoozeUntil('invalid', now)); assert.equal(now.getHours(), 21);
});
test('Snoozed composes with kind chips and preserves unrelated URL state', () => {
  const href = 'https://anyroute.tech/dashboard/?kinds=money&tab=1#inbox';
  assert.equal(snoozeUrl(href, true), '/dashboard/?kinds=money&tab=1&snoozed=true#inbox');
  assert.equal(snoozeUrl('https://anyroute.tech' + snoozeUrl(href, true), false), '/dashboard/?kinds=money&tab=1#inbox');
  assert(snoozedSelected('?snoozed=true&kinds=money')); assert(!snoozedSelected('?snoozed=false'));
});
test('requests encode ids and send only until; failures propagate', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { capped: true }; }, item = { id: 'approval:a/b' };
  assert.deepEqual(await snoozeNotice(request, item, '2026-10-19T09:00:00Z'), { capped: true }); await unsnoozeNotice(request, item);
  assert.deepEqual(calls, [['/api/v1/inbox/approval%3Aa%2Fb/snooze', { method: 'POST', body: { until: '2026-10-19T09:00:00Z' } }], ['/api/v1/inbox/approval%3Aa%2Fb/snooze', { method: 'DELETE' }]]);
  await assert.rejects(snoozeNotice(async () => { throw new Error('Unauthorized'); }, item, 'time'), /Unauthorized/);
});
test('wake clocks make previously read approvals unread in both page and bell projection', () => {
  const page = { data: [{ id: 'approval:1', kind: 'approval', at: '2026-10-19T12:00:00Z', reminder_at: '2026-10-19T12:00:00Z', unread: true }], count: 1 };
  assert.equal(applyInboxReadTime(page, '2026-10-19T11:00:00Z').count, 1);
  assert.equal(projectInbox(page, '2026-10-19T11:00:00Z', ['approvals']).data[0].unread, true);
  assert.equal(applyInboxReadTime(page, '2026-10-19T12:00:00Z').count, 0);
});
test('the Snoozed read preserves the original mark-all snapshot and refuses changed visibility', () => {
  const snapshot = { seen_scope: 'scope', as_of: '2026-10-19T11:00:00Z' };
  const waiting = { seen_scope: 'scope', as_of: '2026-10-19T11:00:01Z', data: [{ id: 'notice', snoozed_until: '2026-10-19T12:00:00Z', unread: false }], count: 0 };
  const result = snoozedInboxPage(snapshot, waiting);
  assert.equal(result.as_of, snapshot.as_of); assert.equal(result.data, waiting.data);
  assert.equal(projectInbox(result, '', []).filters.snapshot.as_of, snapshot.as_of);
  assert.throws(() => snoozedInboxPage(snapshot, { ...waiting, seen_scope: 'other' }), /view changed/);
});
test('shared account controls, keyboard access, phone wrapping and discoverability', () => {
  const ui = source('../components/account/InboxSnooze.jsx'), css = source('../components/account/InboxSnooze.module.css');
  assert.match(ui, /aria-pressed=/); assert.match(ui, /<summary>Snooze/); assert.match(ui, /type="button"/); assert.match(ui, /role="alert"/); assert.match(ui, /role="status"/); assert.match(ui, /currentKey.current === key/);
  assert.match(css, /flex-wrap: wrap/); assert.match(css, /min-height: 44px/); assert.match(css, /focus-visible/); assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(source('../components/account/AccountInbox.jsx'), /<InboxSnooze item={item}/); assert.match(source('../components/account/InboxFilters.jsx'), /<SnoozedChip/);
  assert.equal(TASKS.find(task => task.id === 'snooze').href, '/docs/#snooze'); assert.match(source('../components/SnoozeDocs.jsx'), /id="snooze"/);
  const spec = JSON.parse(source('../public/openapi.json')); assert(spec.paths['/api/v1/inbox/{id}/snooze'].post.security.length); assert(spec.paths['/api/v1/inbox/{id}/snooze'].delete.security.length); assert(spec.paths['/api/v1/inbox'].get.parameters.some(p => p.name === 'snoozed'));
});
