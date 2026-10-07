import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SPEND_GLANCE_PATH, spendPage, spendText, spendBars, lastCallText } from '../lib/spend-glance.js';
import { SpendGlanceLine, withSpendGlance } from '../components/AgentSpendGlance.js';
import { TASKS, menuTasks } from '../lib/site-map.js';
const now = Date.parse('2026-10-07T12:00:00Z');
const daily = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-0${i + 1}`, charged_usd: 0 }));
const empty = { key_hash: 'sample-key', daily, total_usd: 0, top_model: null, last_request_at: null };
const spent = { ...empty, daily: daily.map((day, i) => ({ ...day, charged_usd: i === 6 ? 1.24 : 0 })), total_usd: 1.24, top_model: { id: 'qwen/model', name: 'Qwen', charged_usd: 1.24 }, last_request_at: '2026-10-07T10:00:00Z' };
test('seven-day response is mapped by key and unreadable amounts never become empty-state claims', () => {
  assert.equal(SPEND_GLANCE_PATH, '/api/v1/agents/spend?days=7');
  assert.deepEqual(spendPage({ days: 7, data: [empty, { ...spent, key_hash: 'sample-key-2' }] }), { 'sample-key': empty, 'sample-key-2': { ...spent, key_hash: 'sample-key-2' } });
  for (const response of [{}, { days: 8, data: [] }, { days: 7, data: [{ ...empty, daily: [] }] }, { days: 7, data: [{ ...empty, total_usd: -1 }] }, { days: 7, data: [{ ...empty, daily: daily.map(day => ({ ...day, charged_usd: NaN })) }] }]) assert.throws(() => spendPage(response));
});
test('plain summary covers zero days, free calls, tiny charges and majority versus top-model attribution', () => {
  assert.equal(spendText(empty, now), 'No calls this week');
  assert.equal(spendText({ ...empty, last_request_at: '2026-09-30T12:00:00Z' }, now), 'No calls this week');
  assert.equal(spendText(spent, now), '$1.24 this week · mostly Qwen · last call 2 h ago');
  assert.equal(spendText({ ...empty, last_request_at: spent.last_request_at }, now), '$0.00 this week · last call 2 h ago');
  assert.equal(spendText({ ...empty, total_usd: 1e-12 }, now), 'less than $0.01 this week');
  assert.equal(spendText({ ...spent, top_model: { ...spent.top_model, charged_usd: 0.5 } }, now), '$1.24 this week · top model Qwen · last call 2 h ago');
  assert.equal(spendText({ ...spent, top_model: null }, now), '$1.24 this week · last call 2 h ago');
});
test('relative calls handle minute/hour/day boundaries and missing dates', () => {
  assert.equal(lastCallText(null, now), ''); assert.equal(lastCallText('bad', now), '');
  for (const [elapsed, expected] of [[0, 'just now'], [60_000, '1 min ago'], [3_600_000, '1 h ago'], [86_400_000, '1 day ago'], [2 * 86_400_000, '2 days ago']]) assert.equal(lastCallText(new Date(now - elapsed).toISOString(), now), 'last call ' + expected);
});
test('seven SVG bars stay finite for zero days and scale charged amounts without a chart library', () => {
  assert.equal(spendBars(daily).length, 7);
  assert.ok(spendBars(daily).every(bar => bar.height === 0 && bar.y === 24));
  const bars = spendBars(spent.daily); assert.equal(bars[6].height, 22); assert.equal(bars[6].y, 2);
  assert.equal(bars[0].label, '2026-10-01 UTC: $0.00');
});
test('line exposes dates and values to assistive users, wraps at narrow widths and escapes model text', () => {
  const markup = renderToStaticMarkup(createElement(SpendGlanceLine, { row: spent, now }));
  assert.match(markup, /role="img"/); assert.match(markup, /2026-10-01 UTC: \$0.00/); assert.match(markup, /2026-10-07 UTC: \$1.24/);
  assert.equal((markup.match(/<g>/g) || []).length, 7); assert.match(markup, /flex-wrap:wrap/); assert.match(markup, /min-width:0/);
  assert.match(markup, /\$1.24 this week · mostly Qwen · last call 2 h ago/);
  const unsafe = renderToStaticMarkup(createElement(SpendGlanceLine, { row: { ...spent, top_model: { ...spent.top_model, name: '<script>text</script>' } }, now }));
  assert.doesNotMatch(unsafe, /<script>/); assert.match(unsafe, /&lt;script&gt;/);
  assert.match(renderToStaticMarkup(createElement(SpendGlanceLine, { row: empty, now })), /No calls this week/);
});
test('loading and failed reads remain distinct from no calls, search points to existing Agents', () => {
  assert.match(renderToStaticMarkup(createElement(SpendGlanceLine, { status: 'loading' })), /Reading weekly spend/);
  const error = renderToStaticMarkup(createElement(SpendGlanceLine, { status: 'error' }));
  assert.match(error, /Weekly spend could not be read/); assert.doesNotMatch(error, /No calls this week/);
  assert.equal(TASKS.find(task => task.id === 'agent-spend-glance')?.href, '/agents/');
  assert.ok(!menuTasks('agents').some(task => task.id === 'agent-spend-glance'));
});
test('row wrapper reuses the existing caps component once with its unchanged agent', () => {
  const agent = { key_hash: empty.key_hash, caps: {} };
  let calls = 0;
  const Caps = props => { calls++; assert.equal(props.agent, agent); return createElement('span', null, 'Rolling caps'); };
  const Row = withSpendGlance(Caps, { rows: { [agent.key_hash]: empty }, status: 'ready' });
  const markup = renderToStaticMarkup(createElement(Row, { agent }));
  assert.equal(calls, 1); assert.match(markup, /No calls this week/); assert.match(markup, /Rolling caps/);
});
