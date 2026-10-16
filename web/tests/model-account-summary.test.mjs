import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { modelSummaryPath } from '../lib/model-account-summary.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ModelAccountResults from '../components/ModelAccountResults.js';
const report = { scope: 'key', usage: { calls: '3', charged_usd: '0.003', refunded_usd: '0.0001', cost_usd: '0.0029' }, reliability: { calls: '2', success_rate: 50 }, savings: null, price_notice: null, price_notices_visible: true };
test('model ids remain one path segment', () => {
  assert.equal(modelSummaryPath('sample/model'), '/api/v1/account/models/sample%2Fmodel/summary');
  assert.equal(modelSummaryPath('sample/a?b#c'), '/api/v1/account/models/sample%2Fa%3Fb%23c/summary');
});
test('results show distinct windows, scoped precise money, unknown rate and retained notice limits', () => {
  const html = renderToStaticMarkup(h(ModelAccountResults, { report }));
  for (const text of ['For this key only', '3 calls', '$0.003', 'last 30 days', 'last 7 days', '50.0%', '2 recorded calls', 'No recent notice', 'retained inbox history', 'answer quality']) assert(html.includes(text), text);
  const empty = renderToStaticMarkup(h(ModelAccountResults, { report: { ...report, scope: 'account', reliability: { calls: '0', success_rate: null }, usage: { ...report.usage, cost_usd: '-0.0001' }, price_notices_visible: false } }));
  assert(empty.includes('Not recorded')); assert(!empty.includes('100.0%')); assert(empty.includes('$-0.0001')); assert(empty.includes('notification settings'));
  const notice = renderToStaticMarkup(h(ModelAccountResults, { report: { ...report, price_notice: { at: '2026-10-15T00:00:00Z', title: 'Input rate changed' } } }));
  assert(notice.includes('Input rate changed')); assert(notice.includes('/dashboard/#inbox'));
});
test('signed-out model markup is byte-identical to the page without the new component', () => {
  const result = spawnSync('bun', ['-e', `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ModelPageView } from './components/ModelPage.jsx';
    const source = readFileSync('./components/ModelPage.jsx','utf8').split('\\n').filter(line => !line.includes('// J178') && !line.includes('{/* J178 */}')).join('\\n');
    const file = './components/.j178-baseline.jsx';
    try {
      writeFileSync(file, source);
      const { ModelPageView: Baseline } = await import(file);
      const props = { model: {id:'sample/model',name:'Sample model'}, providers:[] };
      const current = renderToStaticMarkup(<ModelPageView {...props}/>);
      assert.equal(current, renderToStaticMarkup(<Baseline {...props}/>));
      assert(!current.includes('You and this model'));
    } finally { unlinkSync(file); }
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('panel reuses account/watch/compare controls, gates requests and clears account state', () => {
  const source = readFileSync(new URL('../components/ModelAccountSummary.jsx', import.meta.url), 'utf8');
  for (const pattern of [/useAccountKey/, /return key \? <ConnectedSummary/, /key=\{key \+ model.id\}/, /controller.abort\(\)/, /ModelWatchButton/, /ModelCompareButton/, /Try in Chat/]) assert.match(source, pattern);
  const docs = readFileSync(new URL('../components/ModelAccountDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /id="your-view-of-a-model"/);
});
