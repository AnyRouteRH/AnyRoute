import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { savingsMoney, savingsPath } from '../lib/savings.js';
import SavingsResults from '../components/account/SavingsResults.js';
const report = { scope: 'account', days: 30, models: [{ model: 'source', name: 'Model A', calls: '2', tokens_in: '1000000', tokens_out: '1000000', charged_usd: '7.4',
  alternative: { model: 'author/model-b', name: 'Model B', estimated_cost_usd: '3.1', estimated_saving_usd: '4.3' } }] };
test('exact decimal rounding keeps dollars and cents without losing integer precision', () => {
  assert.equal(savingsPath, '/api/v1/account/savings?days=30');
  assert.equal(savingsMoney('3.1'), '$3.10'); assert.equal(savingsMoney('7.4'), '$7.40');
  assert.equal(savingsMoney('9.995'), '$10.00'); assert.equal(savingsMoney('0'), '$0.00');
  assert.equal(savingsMoney('9007199254740993.125'), '$9,007,199,254,740,993.13');
});
test('comparison labels estimates at current prices and gives model-page and Chat links', () => {
  const html = renderToStaticMarkup(h(SavingsResults, { report }));
  assert.match(html, /Same tokens on Model B: about \$3.10 instead of \$7.40/);
  assert.match(html, /Estimate at current catalogue prices; no claim of equal quality/);
  assert.match(html, /href="\/models\/model\/\?id=author%2Fmodel-b"/);
  assert.match(html, /href="\/harness\/\?model=author%2Fmodel-b"/); assert.match(html, /Try in Chat/);
  assert.match(html, /Across your visible account keys/); assert.match(html, /last 30 days/);
  assert.match(html, /Call records do not keep a list of abilities used/); assert.match(html, /Refunds, cache discounts, royalties, account fees/);
  assert.doesNotMatch(html, /estimated_cost_usd|tokens_in|<code|<pre/);
});
test('empty report remains honest and key-scoped; model names are escaped', () => {
  const empty = renderToStaticMarkup(h(SavingsResults, { report: { ...report, scope: 'key', models: [] } }));
  assert.match(empty, /For this key only/); assert.match(empty, /No cheaper match found with enough information/);
  assert.doesNotMatch(empty, /Try in Chat|<ul/);
  const html = renderToStaticMarkup(h(SavingsResults, { report: { ...report, models: [{ ...report.models[0], name: '<script>private</script>', alternative: { ...report.models[0].alternative, name: '<Model B>' } }] } }));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;Model B&gt;/); assert.doesNotMatch(html, /<script>/);
});
test('Insights integrates independently of spend switch and clears state on key change, with keyboard and mobile styles', () => {
  const dashboard = readFileSync(new URL('../components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dashboard, /tab === "Insights" && signedIn && <AccountSavings key=\{apiKey\} apiKey=\{apiKey\}/);
  const component = readFileSync(new URL('../components/account/AccountSavings.jsx', import.meta.url), 'utf8');
  assert.match(component, /controller\.abort\(\)/); assert.match(component, /setReport\(null\)/); assert.match(component, /\[apiKey, revision\]/);
  assert.match(component, /disabled=\{busy\}/); assert.match(component, /role="alert"/); assert.match(component, /role="status"/);
  const css = readFileSync(new URL('../components/account/Savings.module.css', import.meta.url), 'utf8');
  assert.match(css, /focus-visible/); assert.match(css, /max-width:400px/); assert.match(css, /var\(--line\)/);
});
test('docs anchor, search index and complete authenticated endpoint schema are connected', () => {
  assert.match(readFileSync(new URL('../components/SavingsFinderDocs.jsx', import.meta.url), 'utf8'), /id="savings-finder"/);
  assert.match(readFileSync(new URL('../components/DocsFeatureIndex.jsx', import.meta.url), 'utf8'), /\["savings-finder", "Ways to save"\]/);
  assert.match(readFileSync(new URL('../lib/site-map.js', import.meta.url), 'utf8'), /task\('savings-finder'/);
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8')).paths['/api/v1/account/savings'].get;
  assert.deepEqual(spec.security, [{ BearerAuth: [] }]); assert.equal(spec.parameters[0].schema.default, 30);
  assert.equal(spec.parameters[0].schema.maximum, 30);
  const schema = spec.responses['200'].content['application/json'].schema;
  assert(schema.properties.models.items.properties.alternative.properties.estimated_cost_usd);
  assert(spec.responses['401']); assert(spec.responses['403']);
});
