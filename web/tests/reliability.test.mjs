import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reliabilityPath, reliabilityHeadline, reliabilityRate, reliabilityTiming } from '../lib/reliability.js';
import ReliabilityResults from '../components/account/ReliabilityResults.js';
const empty = { calls: '0', succeeded: '0', success_rate: null, route_recorded_calls: '0', fallback_calls: '0', fallback_rate: null, refusals: { decisions: '0', lane: '0', budget: '0', rulebook: '0' } };
const report = totals => ({ scope: 'key', from: '2026-10-03T12:00:00Z', to: '2026-10-10T12:00:00Z', totals, models: [] });
test('headline retains recorded-call and fallback-coverage limits; missing data is not a zero rate', () => {
  assert.equal(reliabilityPath, '/api/v1/account/reliability?days=7');
  assert.equal(reliabilityHeadline(empty), 'No recorded calls this week.');
  assert.equal(reliabilityHeadline({ ...empty, calls: '1000', success_rate: 98.7, fallback_rate: 3 }), '98.7% of your recorded calls succeeded this week; 3.0% with route records used a fallback.');
  assert.match(reliabilityHeadline({ ...empty, calls: '5', success_rate: 100 }), /fallback use was not recorded/);
  assert.equal(reliabilityRate(null), 'Not recorded'); assert.equal(reliabilityRate(0), '0.0%');
  assert.equal(reliabilityTiming({ p95: 385.1 }, 'p95'), '385 ms'); assert.equal(reliabilityTiming(null, 'median'), 'Not recorded');
});
test('empty state shows no invented rates or timing columns and states key scope', () => {
  const html = renderToStaticMarkup(h(ReliabilityResults, { report: report(empty) }));
  assert.match(html, /No recorded calls this week/); assert.match(html, /For this key only/);
  assert.match(html, /will appear here/); assert.doesNotMatch(html, /<table|100%|First token/);
  assert.match(html, /not unique requests/); assert.match(html, /General lane and balance refusals/);
});
test('table keeps counts, conditional timing coverage, accessible bars, escaped models and keyboard scrolling', () => {
  const row = { ...empty, model: '<model>', calls: '4', success_rate: 75, fallback_calls: '1', route_recorded_calls: '3', fallback_rate: 33.3, total_latency_ms: { samples: '4', median: 2500, p95: 3850 } };
  const html = renderToStaticMarkup(h(ReliabilityResults, { report: { ...report(row), scope: 'account', models: [row, { ...empty, model: 'Other model' }] } }));
  assert.match(html, /Across your visible account keys/); assert.match(html, /tabindex="0"/); assert.match(html, /scope="row"/); assert.match(html, /scope="col"/);
  assert.match(html, /aria-hidden="true"/); assert.match(html, /width:75%/); assert.match(html, /&lt;model&gt;/); assert.match(html, /2,500 ms/);
  assert.match(html, /Total time · samples/); assert.doesNotMatch(html, /First token · median/); assert.match(html, /Not recorded/);
  const timed = renderToStaticMarkup(h(ReliabilityResults, { report: { ...report(row), models: [{ ...row, time_to_first_token_ms: { samples: '1', median: 0, p95: 0 } }] } }));
  assert.match(timed, /First token · samples/); assert.match(timed, /0 ms/);
});
test('dashboard uses the account shell Insights section independently of the spend switch and clears on key changes', () => {
  const dashboard = readFileSync(new URL('../components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dashboard, /tab === "Insights" && signedIn && <AccountReliability key=\{apiKey\} apiKey=\{apiKey\}/);
  const component = readFileSync(new URL('../components/account/AccountReliability.jsx', import.meta.url), 'utf8');
  assert.match(component, /controller\.abort\(\)/); assert.match(component, /setReport\(null\)/); assert.match(component, /\[apiKey, revision\]/);
  assert.match(component, /role="alert"/); assert.match(component, /disabled=\{busy\}/);
});
