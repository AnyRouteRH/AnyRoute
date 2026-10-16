import { createElement as h } from 'react';
import { formatUsd } from '../lib/agents.js';
import { reliabilityRate } from '../lib/reliability.js';
import SavingsResults from './account/SavingsResults.js';
export default function ModelAccountResults({ report }) {
  const { usage, reliability, savings, price_notice: notice } = report;
  return h('div', null,
    h('p', { className: 'help-text' }, report.scope === 'account' ? 'Across your visible account keys.' : 'For this key only.'),
    h('p', null, usage.calls + ' calls · ' + formatUsd(usage.charged_usd) + ' charged in the last 30 days.'),
    h('p', { className: 'help-text' }, formatUsd(usage.refunded_usd) + ' refunded in this period; ' + formatUsd(usage.cost_usd) + ' net spend.'),
    h('p', null, 'Your success rate · last 7 days: ' + reliabilityRate(reliability.success_rate) + ' (' + reliability.calls + ' recorded calls).'),
    h('p', { className: 'help-text' }, 'Failures before a call record are excluded. Success does not establish answer quality.'),
    h('a', { className: 'inline-link', href: '/dashboard/#insights' }, 'Open your reliability report'),
    savings && h('div', null, h('h3', null, 'Ways to save'), h(SavingsResults, { report: { scope: report.scope, days: 30, models: [savings] } })),
    h('h3', null, 'Recent price notices'),
    notice ? h('p', null, notice.title + ' ', h('time', { dateTime: notice.at }, new Date(notice.at).toLocaleDateString('en-GB', { timeZone: 'UTC' })))
      : h('p', null, report.price_notices_visible ? 'No recent notice for this model in your retained inbox history.' : 'Price notices follow your account permissions and notification settings.'),
    notice && h('a', { className: 'inline-link', href: '/dashboard/#inbox' }, 'Open your inbox'));
}
