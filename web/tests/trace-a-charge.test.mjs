import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { activityFilters, activityHref, afterInstant, callFilters, chargeLinks, chatCharges, glanceFilters, modelFilter, replyChargeModel } from '../lib/charge-links.js';
import { activityPath, exportActivity } from '../lib/activity.js';
import { TraceInsights, TraceStatementRows, TraceChatFooter, useLinkedBreakdown, RecordedChargeLinks } from '../components/TraceChargeLinks.js';
import RunwayChargeLinks, { runwayChargeFilters } from '../components/RunwayChargeLinks.js';
import ActivityList from '../components/account/ActivityList.js';
import ProjectBreakdown from '../components/account/ProjectBreakdown.js';
import SavingsResults from '../components/account/SavingsResults.js';
import ReliabilityResults from '../components/account/ReliabilityResults.js';
import { SpendGlanceLine } from '../components/AgentSpendGlance.js';
import { TASKS } from '../lib/site-map.js';
const range = { from: '2026-10-01T12:00:00.123456Z', to: '2026-10-02T15:00:00.654321Z' };
const hash = 'a'.repeat(64), model = 'catalog/model & variant';
const markup = node => renderToStaticMarkup(node);
const hrefs = html => [...html.matchAll(/href="([^"]+)"/g)].map(m => new URL(m[1].replaceAll('&amp;', '&'), 'https://anyroute.tech'));
const activityLinks = html => hrefs(html).filter(url => url.hash === '#activity');

test('Activity URL round trips every filter, preserves exact instants and applies them to all export pages', async () => {
  const filters = callFilters(range, { key: hash, model, project: 'research', basis: 'charges', charge_kind: 'usage', paid: 'true', lane: 'public' });
  assert.deepEqual(activityFilters(activityHref(filters)), filters);
  const api = new URL(activityPath(activityFilters(activityHref(filters))), 'https://anyroute.tech');
  for (const [name, value] of Object.entries(filters)) assert.equal(api.searchParams.get(name), value);
  const requests = [];
  await exportActivity(async path => { requests.push(new URL(path, api)); return { data: [], scope: 'account', next_cursor: requests.length === 1 ? 'next' : null }; }, filters, 'json');
  for (const request of requests) for (const [name, value] of Object.entries(filters)) assert.equal(request.searchParams.get(name), value);
  assert.equal(requests[1].searchParams.get('cursor'), 'next');
  assert.deepEqual(activityFilters('/dashboard/?unrelated=value#activity'), {});
  assert.equal(afterInstant('2026-10-01T23:59:59.999999Z'), '2026-10-02T00:00:00.000000Z');
});

test('Activity and Chat charge adapters link signed amounts and exact model pages, with honest missing evidence', () => {
  const html = markup(h(ActivityList, { rows: [{ id: 'call:one', kind: 'call', at: range.from, title: 'AI call', amount: '-0.12', receipt_id: 'receipt/one', model, verify_url: '/verify/?r=receipt%2Fone' }] }));
  assert.ok(hrefs(html).some(url => url.pathname === '/verify/' && url.searchParams.get('r') === 'receipt/one'));
  assert.ok(hrefs(html).some(url => url.pathname === '/models/model/' && url.searchParams.get('id') === model));
  assert.match(html, /Check receipt for -0.12 USDG/);
  const chat = markup(h(TraceChatFooter, { receiptId: 'receipt/one', model }, h('span', { title: 'Charged for this call' }, '$0.12')));
  assert.match(chat, /<a[^>]+href="\/verify\/\?r=receipt%2Fone"[^>]*>\$0.12<\/a>/);
  assert.equal(chargeLinks(null, null).receipt, null);
  assert.equal(replyChargeModel({ model: 'route/preset', servedModel: model }), model);
  const multiple = markup(h(TraceChatFooter, { receiptId: 'second', model, calls: [{ receiptId: 'first' }, { receiptId: 'second' }] }, h('span', { title: 'Charged for this call' }, '$0.30')));
  assert.match(multiple, /<span title="Charged for this call">\$0.30<\/span>/);
  assert.match(multiple, /Call 1 receipt/); assert.match(multiple, /Call 2 receipt/);
  const rows = chatCharges([{ modelId: model, messages: [{ id: 'one', role: 'assistant', receiptId: 'receipt/one', usage: { cost: .12 } }] }, { messages: [{ id: 'one', role: 'assistant' }] }]);
  const continued = chatCharges([{ modelId: model, messages: [{ id: 'continued', role: 'assistant', continuationCalls: [{ receiptId: 'first', cost: .1 }, { callId: 'next', receiptId: 'second', cost: .2 }] }] }]);
  assert.deepEqual(continued.map(row => row.receipt), ['first', 'second']);
  assert.equal(rows.length, 1); assert.equal(rows[0].model, model); assert.equal(rows[0].receipt, 'receipt/one');
});

test('Insights model/agent and project numbers link through the existing table renderers with the report range', () => {
  function Breakdown({ title, rows }) { return h('div', null, useLinkedBreakdown(title, rows).map(row => h('span', { key: row.id }, row.cost_usd, row.calls))); }
  const rows = [{ id: model, cost_usd: '0.12', calls: '2' }];
  const html = markup(h(TraceInsights, { report: range, project: 'research' },
    h(Breakdown, { title: 'By model', rows }), h(Breakdown, { title: 'By key or agent', rows: [{ ...rows[0], id: hash }] }),
    h(ProjectBreakdown, { rows: [{ ...rows[0], id: 'research' }, { ...rows[0], id: null }] })));
  const links = activityLinks(html);
  assert.ok(links.some(url => url.searchParams.get('model') === model && url.searchParams.get('project') === 'research'));
  assert.ok(links.some(url => url.searchParams.get('key') === hash));
  assert.ok(links.some(url => url.searchParams.get('missing_project') === 'true' && !url.searchParams.has('project')));
  assert.ok(links.every(url => url.searchParams.get('from') === range.from && url.searchParams.get('to') === range.to));
});

test('statement model/key usage links select posted usage only; unrelated ledger movements stay untouched', () => {
  const payload = { from: range.from, to_exclusive: range.to, usage_by_model: [{ id: model, amount: '.12' }], usage_by_key_agent: [{ id: hash, amount: '.12' }] };
  const section = (title, label) => h('section', { key: title }, h('h3', null, title), h('table', null, h('tbody', null, [h('tr', { key: 'row' }, h('td', null, label), h('td', null, '.12'))])));
  const html = markup(h(TraceStatementRows, { payload }, [section('Usage by model', model), section('Usage by key / agent', 'Agent'), section('Ledger movements', 'Deposit')]));
  const links = activityLinks(html); assert.equal(links.length, 2);
  assert.ok(links.every(url => url.searchParams.get('basis') === 'charges' && url.searchParams.get('charge_kind') === 'usage' && url.searchParams.get('to') === range.to));
});

test('agent glance and each runway window retain key, settlement basis and the precise range', () => {
  const row = { key_hash: hash, as_of: '2026-10-07T12:00:00.123Z', daily: Array.from({ length: 7 }, (_, i) => ({ date: '2026-10-0' + (i + 1), charged_usd: .1 })), total_usd: .7, top_model: { id: model, name: 'Model', charged_usd: .7 } };
  assert.equal(glanceFilters(row).to, '2026-10-07T12:00:00.123001Z');
  const glance = activityLinks(markup(h(SpendGlanceLine, { row })));
  assert.ok(glance.some(url => url.searchParams.get('model') === model)); assert.ok(glance.every(url => url.searchParams.get('key') === hash));
  const data = { key_hash: hash, today_from: '2026-10-07T00:00:00Z', as_of: row.as_of, limits: [{ source: 'rulebook', period: 'hour' }, { source: 'key_budget', period: 'month', resets_at: '2026-11-01T00:00:00Z' }] };
  const rolling = runwayChargeFilters(data, data.limits[0]);
  assert.equal(rolling.from, '2026-10-07T11:00:00.123001Z'); assert.equal(rolling.charge_kind, 'rulebook');
  assert.equal(runwayChargeFilters(data, data.limits[1]).from, '2026-10-01T00:00:00.000Z');
  assert.equal(activityLinks(markup(h(RunwayChargeLinks, { data }))).length, 3);
});

test('savings and reliability link to the source model calls, rather than estimated alternative usage', () => {
  const html = markup(h(SavingsResults, { report: { ...range, days: 30, scope: 'key', models: [{ model, name: 'Source', charged_usd: '.12', alternative: { model: 'other/model', name: 'Other', estimated_cost_usd: '.06' } }] } }));
  const saving = activityLinks(html)[0]; assert.equal(saving.searchParams.get('model'), model); assert.equal(saving.searchParams.get('paid'), 'true');
  const refusals = { decisions: '0', lane: '0', budget: '0', rulebook: '0' };
  const counts = { calls: '2', fallback_calls: '0', route_recorded_calls: '0', success_rate: 100, fallback_rate: null, refusals };
  const reliability = markup(h(ReliabilityResults, { report: { ...range, scope: 'key', totals: counts, models: [{ ...counts, model }] } }));
  assert.equal(activityLinks(reliability)[0].searchParams.get('model'), model);
  assert.deepEqual(modelFilter(null), { missing_model: 'true' });
});

test('documentation, OpenAPI and search expose the feature; Activity restores state without adding storage', () => {
  assert.equal(TASKS.find(task => task.id === 'trace-a-charge').href, '/docs/#trace-a-charge');
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url)));
  const parameters = spec.paths['/api/v1/activity'].get.parameters;
  for (const name of ['model', 'key', 'project', 'from', 'to', 'basis', 'paid', 'lane', 'missing_project', 'missing_model']) assert.ok(parameters.some(p => p.name === name));
  const hook = readFileSync(new URL('../lib/trace-activity.js', import.meta.url), 'utf8');
  assert.match(hook, /popstate/); assert.match(hook, /replaceState/); assert.doesNotMatch(hook, /localStorage|sessionStorage/);
});


test('older per-call tools reuse receipt-checker and model links alongside their existing evidence', () => {
  const html = markup(h(RecordedChargeLinks, { receiptId: 'signed-call', model }));
  assert.ok(hrefs(html).some(url => url.pathname === '/verify/' && url.searchParams.get('r') === 'signed-call'));
  assert.ok(hrefs(html).some(url => url.pathname === '/models/model/' && url.searchParams.get('id') === model));
  assert.equal(markup(h(RecordedChargeLinks, {})), '');
  for (const file of ['Arena.jsx', 'Dashboard.jsx', 'features/AgentSessions.jsx', 'features/BatchStudio.jsx', 'features/EvalLab.jsx', 'harness/PrintChat.jsx']) {
    assert.match(readFileSync(new URL('../components/' + file, import.meta.url), 'utf8'), /<RecordedChargeLinks/);
  }
  for (const file of ['Ask.jsx', 'harness/SavedAnswers.jsx']) assert.match(readFileSync(new URL('../components/' + file, import.meta.url), 'utf8'), /<ChargeModelLink/);
});
