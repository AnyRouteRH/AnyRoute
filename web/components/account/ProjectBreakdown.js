import { createElement as h } from 'react';
export default function ProjectBreakdown({ rows }) {
  if (!rows) return null;
  return h('section', { className: 'control-panel' }, h('h3', null, 'By project'), h('div', { className: 'insights-table-wrap' }, h('table', null,
    h('caption', null, 'By project · USDG'), h('thead', null, h('tr', null, ...['Project', 'Net spend', 'Calls'].map(label => h('th', { key: label, scope: 'col' }, label)))),
    h('tbody', null, ...rows.map((row, index) => h('tr', { key: row.id ?? index }, h('th', { scope: 'row' }, row.id ?? 'No project'), h('td', null, row.cost_usd), h('td', null, row.calls)))))));
}
