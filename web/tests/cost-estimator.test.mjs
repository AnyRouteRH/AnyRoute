import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateTokens } from '../lib/arena.js';
import { MODEL_CAPABILITIES } from '../lib/model-capabilities.js';
import { menuTasks, TASKS } from '../lib/site-map.js';
import { decimalUsd, perMillionRate, modelCost, formatCost, costState, costHref, readCostState, costInputTokens, costRows } from '../lib/cost-estimator.js';

test('catalogue per-token decimals convert exactly to per-million rates and request totals', () => {
  const cost = modelCost({ pricing: { prompt: '0.000000123456', completion: '0.000000987654', request: '0.001234567891' } }, 12345, 6789, 137);
  assert.equal(perMillionRate('0.000000123456'), decimalUsd('0.123456'));
  assert.equal(cost.input, decimalUsd('0.00152406432'));
  assert.equal(cost.output, decimalUsd('0.006705183006'));
  assert.equal(cost.total, decimalUsd('0.009463815217'));
  assert.equal(cost.monthly, cost.total * 4110n);
  assert.equal(formatCost(cost.monthly, 2), '$38.90');
  assert.equal(modelCost({ pricing: { prompt: '0.000002', completion: '0.000005' } }, 1000000, 1000000, 1).total, decimalUsd('7'));
  assert.equal(decimalUsd(1e-7), decimalUsd('0.0000001'));
});

test('round half up only for display; monthly cost uses the unrounded request total', () => {
  assert.equal(formatCost(decimalUsd('0.000000499999')), '<$0.000001');
  assert.equal(formatCost(decimalUsd('0.0000005')), '$0.000001');
  assert.equal(formatCost(decimalUsd('1.2345675')), '$1.234568');
  assert.equal(formatCost(decimalUsd('1.005'), 2), '$1.01');
  assert.equal(formatCost(decimalUsd('1.004999'), 2), '$1.00');
  assert.equal(formatCost(0n), '$0');
  assert.equal(formatCost(decimalUsd('0.000000000001'), 2), '<$0.01');
  const cost = modelCost({ pricing: { prompt: '0.00000049', completion: '0' } }, 1, 0, 1000000);
  assert.equal(formatCost(cost.total), '<$0.000001');
  assert.equal(formatCost(cost.monthly, 2), '$14.70');
});

test('missing, malformed or unlisted prices remain unknown, never free; zero volume works', () => {
  for (const value of [null, undefined, '', '-1', 'NaN', 'Infinity', 'free', {}, '1e99999', '0.0000000000000000001']) assert.equal(decimalUsd(value), null);
  const missing = modelCost({ pricing: { prompt: '0' } }, 0, 0, 0);
  assert.equal(missing.total, null);
  assert.equal(missing.monthly, null);
  assert.equal(formatCost(null), 'Price unavailable');
  // No token prices and no fee means priced some other way, not free.
  const unlisted = modelCost({ pricing: { prompt: '0', completion: '0' } }, 1000, 1000, 100);
  assert.equal(unlisted.total, null);
  assert.equal(unlisted.monthly, null);
  assert.equal(modelCost({ pricing: { prompt: '0.1', completion: '0.2' } }, 0, 0, 100).total, 0n);
  assert.equal(modelCost({ pricing: { prompt: '0.1', completion: '0.2' } }, 10, 10, 0).monthly, 0n);
  assert.throws(() => modelCost({}, -1, 1, 1), RangeError);
  assert.throws(() => modelCost({}, 1, 0.5, 1), RangeError);
});

test('shared state round-trips tags, size, output, volume and sort without either text field', () => {
  for (const size of ['question', 'document', 'code', 'prompt']) {
    const state = costState({ size, pages: 27, input: 4567, systemTokens: 83, output: 892, volume: 0, sort: 'totalDesc', tags: ['tools', 'vision', 'tools'], prompt: 'private prompt text', system: 'private system text' });
    const href = costHref(state);
    assert.doesNotMatch(href, /private|prompt=|system=/);
    const restored = readCostState(href.split('?')[1]);
    for (const key of ['tags', 'size', 'output', 'volume', 'sort']) assert.deepEqual(restored[key], state[key]);
    if (size === 'document') assert.equal(restored.pages, state.pages);
    if (size === 'prompt') assert.equal(restored.input, state.input);
    assert.equal(costInputTokens(restored), costInputTokens(state));
    assert.equal(costHref(restored), href);
  }
  const state = readCostState('?tags=tools,unknown,tools&size=invalid&output=-1&volume=Infinity&pages=0&input=0&sort=invalid&prompt=discard&system=discard');
  assert.deepEqual(state.tags, ['tools']);
  assert.equal(state.size, 'question');
  assert.equal(state.output, 512);
  assert.equal(state.volume, 100);
  assert.equal(state.pages, 1);
  assert.equal(state.input, 0);
  assert.equal(state.sort, 'total');
  assert.doesNotMatch(costHref(state), /discard|prompt=|system=/);
});

test('text estimates reuse the Harness helper including optional system text and preset pages', () => {
  const prompt = 'Explain how this function works.', system = 'Be concise.';
  assert.equal(costInputTokens({ size: 'prompt' }, prompt, system), estimateTokens(system + '\n' + prompt));
  assert.equal(costInputTokens({ size: 'prompt' }, '', ''), 0);
  assert.equal(costInputTokens({ size: 'prompt', input: 4321 }), 4321);
  assert.equal(costInputTokens({ size: 'question' }), 100);
  assert.equal(costInputTokens({ size: 'code' }), 1500);
  assert.equal(costInputTokens({ size: 'document', pages: 15 }, undefined, system), 7500 + estimateTokens(system));
  const shared = readCostState(costHref({ size: 'document', pages: 15, systemTokens: estimateTokens(system) }).split('?')[1]);
  assert.equal(costInputTokens(shared), 7500 + estimateTokens(system));
  assert.equal(costInputTokens(shared, undefined, ''), 7500);
});

const models = [
  { id: 'b', name: 'Beta', provider_names: ['Provider Two'], capabilities: ['tools'], pricing: { prompt: '0.000002', completion: '0.000001' } },
  { id: 'a', name: 'Alpha', provider_names: ['Provider One'], capabilities: ['tools', 'vision'], pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'c', name: 'Gamma', provider_name: 'Provider One', capabilities: ['vision'], pricing: { prompt: '0.000001', completion: '0.000001' } },
  { id: 'd', name: 'Delta', capabilities: ['tools'], pricing: {} },
  { id: 'e', name: 'Epsilon', capabilities: ['tools'], pricing: { prompt: '0.000003', completion: '0.000001' } },
];
test('search and capability intersection use the shared catalogue vocabulary', () => {
  assert.deepEqual(costRows(models, { query: 'PROVIDER one', tags: ['tools', 'vision'] }).map(row => row.model.id), ['a']);
  assert.deepEqual(costRows(models, { query: 'beta' }).map(row => row.model.id), ['b']);
  assert.deepEqual(costRows(models, { tags: ['encrypted'] }), []);
  assert.equal(MODEL_CAPABILITIES.length, 8);
});
test('cost sorting uses exact totals, stable name ties and unknowns last in either direction', () => {
  const ids = options => costRows(models, { input: 1000, output: 1000, ...options }).map(row => row.model.id);
  assert.deepEqual(ids({}), ['c', 'a', 'b', 'e', 'd']);
  assert.deepEqual(ids({ sort: 'totalDesc' }), ['e', 'a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ sort: 'name' }), ['a', 'b', 'd', 'e', 'c']);
  const rows = costRows(models, { input: 1000, output: 1000, sort: 'totalDesc' });
  assert.deepEqual(rows.filter(row => row.cheapest).map(row => row.model.id), ['a', 'b', 'c']);
  assert.deepEqual(models.map(model => model.id), ['b', 'a', 'c', 'd', 'e']);
  assert.deepEqual(costRows(models, { tags: ['tools'], input: 1000, output: 1000 }).filter(row => row.cheapest).map(row => row.model.id), ['a', 'b', 'e']);
  const close = ['0.000000000002', '0.000000000001'].map((rate, i) => ({ id: String(i), pricing: { prompt: rate, completion: '0' } }));
  assert.deepEqual(costRows(close, { input: 1, output: 0 }).map(row => row.model.id), ['1', '0']);
});

test('page exposes catalogue-only estimates and links, with a bounded menu registration', () => {
  const source = readFileSync(new URL('../components/CostEstimator.jsx', import.meta.url), 'utf8');
  assert.match(source, /Your prompt and system prompt never leave this browser on this page/);
  assert.match(source, /Prices from the live catalogue; routing may pick another provider/);
  assert.match(source, /api\('\/api\/v1\/models', \{ signal: controller.signal \}\)/);
  assert.equal([...source.matchAll(/\bapi\(/g)].length, 1);
  assert.doesNotMatch(source, /localStorage|sessionStorage|sendBeacon|streamChat/);
  assert.match(source, /<CapabilityChips model=\{model\}/);
  assert.match(source, /\/harness\/\?model=/);
  assert.match(source, /href="\/models\/"/);
  const harness = readFileSync(new URL('../components/Harness.jsx', import.meta.url), 'utf8');
  assert.match(harness, /byId.get\(new URLSearchParams\(window.location.search\).get\("model"\)\)/);
  assert.ok(menuTasks('build').some(task => task.id === 'cost'));
  assert.equal(menuTasks('build').length, 9);
  assert.equal(TASKS.find(task => task.id === 'cost').featured, false);
});

test('a model with no listed token prices is shown as unavailable, never as $0 or among the cheapest', async () => {
  const { modelCost, costRows } = await import('../lib/cost-estimator.js');
  const unpriced = { id: 'x/clip', name: 'Clip', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['audio'] } };
  const priced = { id: 'y/text', name: 'Text', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } };
  assert.equal(modelCost(unpriced, 100, 100, 1).total, null);
  const rows = costRows([unpriced, priced], { input: 100, output: 100, volume: 1 });
  assert.equal(rows[0].model.id, 'y/text');
  assert.equal(rows.find(r => r.model.id === 'x/clip').cheapest, false);
});
