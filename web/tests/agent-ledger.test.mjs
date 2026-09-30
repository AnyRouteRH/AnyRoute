import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { downloadLedgerPage, ledgerBounds, ledgerPage, ledgerPath } from '../lib/agent-ledger.js';
test('ledger date bounds are UTC and opaque cursor is encoded', () => {
  const bounds = ledgerBounds('2026-09-29', '2026-09-30');
  assert.deepEqual(bounds, { from: '2026-09-29T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' });
  const url = new URL(ledgerPath('key/hash', { ...bounds, cursor: 'cursor&1', format: 'csv' }), 'https://router.invalid');
  assert.equal(url.pathname, '/api/v1/agents/key%2Fhash/ledger'); assert.equal(url.searchParams.get('cursor'), 'cursor&1'); assert.equal(url.searchParams.get('format'), 'csv');
});
test('ledger pages preserve request order, totals, and continuation', () => {
  const rows = [{ id: 'new' }, { id: 'old' }], totals = [{ day: '2026-09-29' }];
  assert.deepEqual(ledgerPage({ data: { rows, totals_per_day: totals }, next_cursor: 'next' }), { rows, totals, next: 'next' });
  assert.throws(() => ledgerPage({ data: [] }));
});
test('downloads request only the selected bounded page with authenticated adapter', async () => {
  const calls = []; const request = async (...args) => { calls.push(args); return 'body'; };
  for (const format of ['csv','json']) {
    const file = await downloadLedgerPage(request, 'hash', {}, 'next', format);
    assert.equal(file.name, 'agent-ledger.' + format); assert.equal(file.text, 'body');
    assert.deepEqual(calls.at(-1), [`/api/v1/agents/hash/ledger?format=${format}&cursor=next`, { raw: true }]);
  }
});
test('activity tab reports receipt limits and lives beside the rulebook', () => {
  const workspace = readFileSync(new URL('../app/agents/AgentWorkspace.jsx', import.meta.url), 'utf8');
  const activity = readFileSync(new URL('../app/agents/Activity.jsx', import.meta.url), 'utf8');
  assert.match(workspace, /role="tab"/); assert.match(workspace, /Activity &amp; receipts/);
  for (const text of ['Download JSON page','Download CSV page','Unlinked record','No receipt','Policy SHA-256','Daily totals','reads request text in memory']) assert.ok(activity.includes(text));
  assert.match(activity, /AbortController/);
});
