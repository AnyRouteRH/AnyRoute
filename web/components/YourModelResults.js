import { createElement as h } from 'react';
import { formatUsd } from '../lib/agents.js';
import { reliabilityRate } from '../lib/reliability.js';
export default function YourModelResults({ row }) {
  return h('div', { className: 'help-text' },
    h('p', null, row.calls + ' calls · ' + formatUsd(row.cost_usd) + ' net spend · ' + reliabilityRate(row.success_rate) + ' success'),
    h('p', null, formatUsd(row.charged_usd) + ' charged · ' + formatUsd(row.refunded_usd) + ' refunded in the last 30 days'));
}
