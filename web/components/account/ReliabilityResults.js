import { createElement as h } from 'react';
import { reliabilityHeadline, reliabilityRate, reliabilityTiming } from '../../lib/reliability.js';
const cell = (value, key) => h('td', { key }, value);
export default function ReliabilityResults({ report }) {
  const ttft = report.models.some(row => row.time_to_first_token_ms), total = report.models.some(row => row.total_latency_ms);
  const headings = ['Model', 'Recorded calls', 'Succeeded', 'Fallback calls', 'Route records', 'Fallback use', ...(ttft ? ['First token · median', 'First token · 95th percentile', 'First token · samples'] : []), ...(total ? ['Total time · median', 'Total time · 95th percentile', 'Total time · samples'] : []), 'Lane refusals', 'Budget refusals', 'Other rulebook refusals'];
  return h('div', null,
    h('p', { className: 'reliability-headline' }, reliabilityHeadline(report.totals)),
    h('p', { className: 'help-text' }, `${report.scope === 'account' ? 'Across your visible account keys.' : 'For this key only.'} Last 7 days, ending ${new Date(report.to).toLocaleString('en', { timeZone: 'UTC' })} UTC. Refresh to include newer calls.`),
    h('p', { className: 'help-text' }, `${report.totals.calls} recorded calls; ${report.totals.route_recorded_calls} have route records; ${report.totals.fallback_calls} used a fallback. ${report.totals.refusals.decisions} recorded refusal decisions.`),
    h('p', { className: 'help-text' }, 'Success means a recorded call was neither cancelled nor marked as an error. Failures before a call record are missing. Fallback percentages cover only calls with route records. Refusals count inference decisions, not unique requests; one decision can count in several reasons. Approval requests are excluded. General lane and balance refusals are not recorded here.'),
    report.models.length ? h('div', { className: 'reliability-table', tabIndex: 0, role: 'region', 'aria-label': 'Reliability by model, scroll for all columns' }, h('table', null,
      h('caption', null, 'Your recorded calls and refusal reasons by model'),
      h('thead', null, h('tr', null, headings.map(title => h('th', { key: title, scope: 'col' }, title)))),
      h('tbody', null, report.models.map((row, index) => h('tr', { key: row.model ?? index },
        h('th', { scope: 'row' }, row.model || 'Model not recorded'), cell(row.calls, 'calls'),
        h('td', null, h('span', null, reliabilityRate(row.success_rate)), row.success_rate !== null ? h('span', { className: 'reliability-bar', 'aria-hidden': true }, h('span', { style: { width: `${row.success_rate}%` } })) : null),
        cell(row.fallback_calls, 'fallback'), cell(row.route_recorded_calls, 'routes'), cell(reliabilityRate(row.fallback_rate), 'share'),
        ...(ttft ? [cell(reliabilityTiming(row.time_to_first_token_ms, 'median'), 'ttft-median'), cell(reliabilityTiming(row.time_to_first_token_ms, 'p95'), 'ttft-p95'), cell(row.time_to_first_token_ms?.samples ?? '0', 'ttft-samples')] : []),
        ...(total ? [cell(reliabilityTiming(row.total_latency_ms, 'median'), 'total-median'), cell(reliabilityTiming(row.total_latency_ms, 'p95'), 'total-p95'), cell(row.total_latency_ms?.samples ?? '0', 'total-samples')] : []),
        cell(row.refusals.lane, 'lane'), cell(row.refusals.budget, 'budget'), cell(row.refusals.rulebook, 'rulebook')))))) : h('p', { role: 'status' }, 'Your calls and recorded refusal reasons will appear here.'),
    h('p', { className: 'help-text' }, 'First-token times cover recorded streams. Total time covers calls with a recorded total. Timing includes errors and cancelled calls when recorded. Missing timings are left out; timings are rounded to milliseconds.'),
    h('a', { className: 'inline-link', href: '/docs/#reliability-report' }, 'How this report is counted'));
}
