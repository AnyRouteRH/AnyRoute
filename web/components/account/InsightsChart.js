import { createElement as h, useId } from 'react';
import { insightBars } from '../../lib/insights.js';
export default function InsightsChart({ rows, title = 'Spend over time' }) {
  const id = useId(), chart = insightBars(rows);
  return h('div', { className:'insights-chart' },
    h('svg', { viewBox:`0 0 ${chart.width} ${chart.height}`, role:'img', 'aria-labelledby':id, preserveAspectRatio:'xMidYMid meet' },
      h('title',{ id },title+' in USDG. Exact amounts and calls follow in the table.'),
      h('line',{ x1:12,x2:chart.width-12,y1:chart.zero,y2:chart.zero,stroke:'currentColor',opacity:0.3 }),
      ...chart.bars.map(bar => h('rect',{ key:bar.id,x:bar.x,y:bar.y,width:bar.width,height:bar.height,fill:'currentColor' },h('title',null,`${bar.id}: ${bar.amount} USDG`)))),
    h('details',null,h('summary',null,'Read chart as a table'),h('div',{ className:'insights-table-wrap' },h('table',null,
      h('caption',null,title+' · UTC'),h('thead',null,h('tr',null,...['Starting','Net spend (USDG)','Calls'].map(label=>h('th',{ key:label,scope:'col' },label)))),
      h('tbody',null,...rows.map(row=>h('tr',{ key:row.id },h('th',{ scope:'row' },row.id),h('td',null,row.cost_usd),h('td',null,row.calls))))))));
}
