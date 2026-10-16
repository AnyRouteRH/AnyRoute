import { createElement as h } from 'react';
import { activityHref, afterInstant, callFilters } from '../lib/charge-links.js';
export function runwayChargeFilters(data, limit) {
  let from = data.today_from;
  if (limit?.source === 'rulebook') from = afterInstant(new Date(Date.parse(data.as_of) - ({ hour: 3600000, day: 86400000, week: 604800000 }[limit.period])).toISOString());
  else if (limit) from = limit.period === 'total' ? null : new Date(Date.parse(limit.resets_at) - ({ day: 86400000, week: 604800000 }[limit.period] || 0)).toISOString();
  if (limit?.period === 'month') { const date = new Date(limit.resets_at); date.setUTCMonth(date.getUTCMonth() - 1); from = date.toISOString(); }
  return callFilters({ from, to: afterInstant(data.as_of) }, { key: data.key_hash, basis: 'charges', ...(limit?.source === 'rulebook' ? { charge_kind: 'rulebook' } : {}) });
}
export default function RunwayChargeLinks({ data }) {
  return h('span', { className: 'button-row' }, h('a', { className: 'inline-link', href: activityHref(runwayChargeFilters(data)) }, 'View today’s charges'),
    data.limits.filter(limit => limit.period !== 'request').map((limit, i) => h('a', { key: i, className: 'inline-link', href: activityHref(runwayChargeFilters(data, limit)) }, 'View ' + (limit.source === 'rulebook' ? 'rolling ' : 'key budget ') + limit.period + ' charges')));
}
