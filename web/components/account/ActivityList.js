import { createElement as h } from 'react';
export default function ActivityList({ rows, renderReceipt }) {
  return h('ul', { className: 'activity-list', 'aria-label': 'Account activity' }, rows.map(row => h('li', { key: row.id },
    h('details', null, h('summary', null,
      h('span', { className: 'activity-title' }, h('strong', null, row.title), h('span', null, [row.model, row.key_label].filter(Boolean).join(' · '))),
      h('span', { className: 'activity-amount' }, row.amount, ' USDG'),
      h('time', { dateTime: row.at }, new Date(row.at).toLocaleString()), h('span', null, row.status)),
      h('dl', null, [['Where it ran', row.where], ['Lane recorded', row.lane], ['Reference', row.reference], ['Approval limit', row.approval_limit === null ? null : row.approval_limit + ' USDG']].filter(([, value]) => value).map(([title, value]) => h('div', { key: title }, h('dt', null, title), h('dd', null, value)))),
      row.receipt_id ? h('div', null, h('p', null, 'Receipt ', h('code', null, row.receipt_id)), renderReceipt?.(row), h('a', { className: 'inline-link', href: row.verify_url }, 'Check this receipt')) : h('p', { className: 'help-text' }, 'No signed call receipt recorded for this event.')))));
}
