import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { YOUR_MODELS_PATH, yourModelsFromUrl, yourModelsUrl, yourModelsInCatalog } from '../lib/your-models.js';
import { filterModels } from '../lib/model-catalog.js';
import YourModelResults from '../components/YourModelResults.js';

test('URL selection preserves sort, other query state and hash; invalid filters stay off', () => {
  assert.equal(YOUR_MODELS_PATH, '/api/v1/account/models/used');
  const original = 'https://anyroute.tech/models/?sort=priceIn&other=keep#catalogue';
  const selected = yourModelsUrl(original, true);
  assert.equal(selected, '/models/?sort=priceIn&other=keep&filter=your-models#catalogue');
  assert.equal(yourModelsFromUrl(selected), true);
  assert.equal(yourModelsFromUrl(original), false);
  assert.equal(yourModelsFromUrl('/models/?filter=unknown'), false);
  assert.equal(yourModelsUrl(selected, false), '/models/?sort=priceIn&other=keep#catalogue');
  assert.equal(yourModelsUrl('/models/?filter=other', false), '/models/?filter=other');
});
test('personal models retain server spend order through catalogue searches and filters', () => {
  const models = [{ id: 'sample/a', name: 'Alpha' }, { id: 'sample/b', name: 'Beta' }, { id: 'sample/c', name: 'Gamma' }];
  const report = { data: [{ model: 'sample/b' }, { model: 'sample/a' }, { model: 'sample/removed' }] };
  assert.deepEqual(yourModelsInCatalog(filterModels(models), report).map(m => m.id), ['sample/b', 'sample/a']);
  assert.deepEqual(yourModelsInCatalog(filterModels(models, { query: 'Alpha' }), report), [models[0]]);
  assert.deepEqual(yourModelsInCatalog(models, null), []);
});
test('card results show the common window, precise net spend, refunds and recorded success', () => {
  const row = { calls: '4', charged_usd: '0.004', refunded_usd: '0.0002', cost_usd: '0.0038', success_rate: 50 };
  const html = renderToStaticMarkup(h(YourModelResults, { row }));
  for (const text of ['4 calls', '$0.0038 net spend', '50.0% success', '$0.004 charged', '$0.0002 refunded', 'last 30 days']) assert(html.includes(text), text);
  const unknown = renderToStaticMarkup(h(YourModelResults, { row: { ...row, success_rate: null, cost_usd: '-0.001' } }));
  assert(unknown.includes('Not recorded')); assert(unknown.includes('$-0.001')); assert(!unknown.includes('100.0%'));
});
test('signed-out additions render nothing; signed-in controls reuse Watch and model-page links', () => {
  const result = spawnSync('bun', ['-e', `
    import assert from 'node:assert/strict';
    import { renderToStaticMarkup as render } from 'react-dom/server';
    import { YourModelsFilter, YourModelsStatus, YourModelStats } from './components/YourModels.jsx';
    const off = { signedIn:false, active:false };
    assert.equal(render(<><YourModelsFilter state={off}/><YourModelsStatus state={off}/><YourModelStats/></>), '');
    const state = {signedIn:true, active:true, report:{scope:'key',data:[]}};
    const html = render(<><YourModelsFilter state={state}/><YourModelsStatus state={state}/><YourModelStats model={{id:'sample/a',name:'Alpha'}} row={{calls:'1',cost_usd:'0.001',charged_usd:'0.001',refunded_usd:'0',success_rate:100,cheaper_option:{model:'sample/b',name:'Beta',estimated_cost_usd:'0.0001'}}}/></>);
    for (const text of ['aria-pressed="true"','For this key only','last 30 days','highest net spend first','Cheaper option','/models/model/?id=sample%2Fb','equal quality','Sign in to watch']) assert(html.includes(text),text);
    assert(render(<YourModelsStatus state={{...state,error:'Connection failed'}}/>).includes('Retry'));
    assert(render(<YourModelsStatus state={{...state,report:null}}/>).includes('Reading your models'));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('signed-out catalogue markup remains byte-identical to its earlier view', () => {
  const result = spawnSync('bun', ['-e', `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
    import { renderToStaticMarkup as render } from 'react-dom/server';
    import ModelCatalog from './components/ModelCatalog.jsx';
    const original = [
      '  const visible = useMemo(() => filterModels(models || [], { query, tags, sort }), [models, query, tags, sort]);',
      '  const counts = useMemo(() => modelTagCounts(models || [], { query, tags }), [models, query, tags]);',
      '      <label className="select-label"><span className="sr-only">Sort models</span><select aria-label="Sort models" value={sort} onChange={e => changeSort(e.target.value)}>{CATALOG_SORTS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>',
      '        <ModelWatchMenu model={raw} /> {/* G159 */}',
      '    {!visible.length && models && !error && <div className="empty"><h3>No matching models</h3><p>{!models.length ? "No providers are serving models yet." : "Try a different search or clear the filters."}</p><Button secondary onClick={() => { setQuery(""); setTags([]); }}>Clear filters</Button></div>}',
    ];
    const source = readFileSync('./components/ModelCatalog.jsx','utf8').split('\\n').flatMap(line => {
      if (!line.includes('K192')) return [line];
      const marker = ['const visible =', 'const counts =', '<label className="select-label">', '<ModelWatchMenu model=', '<h3>{your.active'].findIndex(text => line.includes(text));
      return marker < 0 ? [] : [original[marker]];
    }).join('\\n');
    const file = './components/.k192-baseline.jsx';
    try {
      writeFileSync(file, source);
      const { default: Baseline } = await import(file);
      assert.equal(render(<ModelCatalog/>), render(<Baseline/>));
    } finally { unlinkSync(file); }
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
