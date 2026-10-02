import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { insightsPath, initialInsightRange, insightSeries, insightBars, provenShare } from '../lib/insights.js';
import InsightsChart from '../components/account/InsightsChart.js';
test('insight queries use UTC dates and Monday weeks fill missing buckets',()=>{
  assert.deepEqual(initialInsightRange(new Date('2026-10-01T23:59:00-04:00')),{from:'2026-09-03',to:'2026-10-03',bucket:'day'});
  assert.match(insightsPath({from:'2026-09-01',to:'2026-09-30',bucket:'week'}),/from=2026-09-01T00%3A00%3A00Z/);
  const report={from:'2026-09-27T00:00:00Z',to:'2026-09-30T00:00:00Z',bucket:'day',series:[{id:'2026-09-28',cost_usd:'1.000000000001',calls:'3'}]};
  const rows=insightSeries(report);assert.deepEqual(rows.map(r=>r.id),['2026-09-27','2026-09-28','2026-09-29']);assert.equal(rows[1].cost_usd,'1.000000000001');assert.equal(rows[0].calls,'0');
  assert.deepEqual(insightSeries({...report,bucket:'week',series:[]}).map(r=>r.id),['2026-09-21','2026-09-28']);
});
test('SVG maps positive, negative, zero, single and empty data without losing exact table values',()=>{
  const rows=[{id:'a',cost_usd:'3.000000000001',calls:'2'},{id:'b',cost_usd:'-1',calls:'0'},{id:'c',cost_usd:'0',calls:'0'}], chart=insightBars(rows);
  assert.ok(chart.bars[0].y<chart.zero);assert.equal(chart.bars[1].y,chart.zero);assert.equal(chart.bars[2].height,0);
  for(const data of [[],[rows[2]],rows]){const c=insightBars(data);assert.ok(Number.isFinite(c.zero));for(const b of c.bars)assert.ok(Number.isFinite(b.height)&&b.width>0);}
  const html=renderToStaticMarkup(h(InsightsChart,{rows}));assert.match(html,/role="img"/);assert.match(html,/aria-labelledby=/);assert.match(html,/<table>/);assert.match(html,/3\.000000000001/);assert.match(html,/scope="col"/);assert.match(html,/Read chart as a table/);
});
test('proof share uses integer ratios',()=>{
  assert.equal(provenShare({calls:'3',proven_calls:'1'}),'33.3%');assert.equal(provenShare({calls:'0',proven_calls:'0'}),'No calls');
});
