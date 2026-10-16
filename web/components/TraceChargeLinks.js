'use client';
// J182: small adapters around the existing account tables, without a second spending view.
import { Children, cloneElement, createContext, createElement as h, isValidElement, useContext } from 'react';
import { activityHref, callFilters, chargeLinks, glanceFilters, modelFilter, projectFilter } from '../lib/charge-links.js';
const TraceRange = createContext({});
export function TraceInsights({ report, project, children }) {
  return h(TraceRange.Provider, { value: report ? { from: report.from, to: report.to, ...(project ? { project } : {}) } : {} }, children);
}
const link = (href, value, label) => h('a', { className: 'inline-link', href, ...(label ? { 'aria-label': label } : {}) }, value);
export function useLinkedBreakdown(title, rows) {
  const range = useContext(TraceRange);
  const dimension = title === 'By key or agent' ? 'key' : title === 'By lane' ? 'lane' : 'model';
  return rows.map(row => {
    if (dimension === 'key' && !row.id) return row;
    const extra = dimension === 'model' ? modelFilter(row.id) : { [dimension]: row.id || 'unknown' };
    const href = activityHref(callFilters(range, { project: range.project, ...extra }));
    return { ...row, cost_usd: link(href, row.cost_usd, 'View calls for ' + (row.label || row.id || 'unrecorded model')), calls: link(href, row.calls) };
  });
}
export function useLinkedProjects(rows) {
  const range = useContext(TraceRange);
  return rows?.map(row => {
    const href = activityHref(callFilters(range, projectFilter(row.id)));
    return { ...row, cost_usd: link(href, row.cost_usd, 'View calls for ' + (row.id || 'No project')), calls: link(href, row.calls) };
  });
}
export function linkedActivityRows(rows) {
  return rows.map(row => ({ ...row, amount: row.receipt_id ? link(chargeLinks(row.receipt_id).receipt, row.amount, 'Check receipt for ' + row.amount + ' USDG') : row.amount }));
}
export function ChargeModelLink({ model }) {
  return model ? link(chargeLinks(null, model).model, 'View model') : null;
}
export function GlanceChargeLink({ row }) {
  return row ? h('span', null, link(activityHref(glanceFilters(row)), 'View calls'), row.top_model ? h('span', null, ' · ', link(activityHref({ ...glanceFilters(row), model: row.top_model.id }), 'View top model calls'), ' · ', h(ChargeModelLink, { model: row.top_model.id })) : null) : null;
}
// Sections/rows here are the existing rendered statement elements. Only the usage amount cells change.
export function TraceStatementRows({ payload, children }) {
  return Children.map(children, section => {
    if (!isValidElement(section)) return section;
    const parts = Children.toArray(section.props.children), title = parts.find(part => part.type === 'h3')?.props.children;
    const dimension = { 'Usage by model': 'model', 'Usage by key / agent': 'key', 'Usage by lane': 'lane' }[title];
    if (!dimension) return section;
    const groups = payload[{ model: 'usage_by_model', key: 'usage_by_key_agent', lane: 'usage_by_lane' }[dimension]];
    return cloneElement(section, {}, parts.map(part => part.type !== 'table' ? part : cloneElement(part, {}, Children.map(part.props.children, body => body.type !== 'tbody' ? body : cloneElement(body, {}, Children.map(body.props.children, (row, i) => {
      const group = groups[i];
      if (!group || dimension === 'key' && !group.id) return row;
      const extra = dimension === 'model' ? modelFilter(group.id) : { [dimension]: group.id || 'unknown' };
      const href = activityHref(callFilters({ from: payload.from, to: payload.to_exclusive }, { basis: 'charges', charge_kind: 'usage', ...extra }));
      return cloneElement(row, {}, Children.map(row.props.children, (cell, index) => index === 1 ? cloneElement(cell, {}, link(href, cell.props.children, 'View calls for ' + (group.label || group.id || 'unrecorded model'))) : cell));
    }))))));
  });
}
export function TraceChatFooter({ receiptId, model, calls, children }) {
  const href = chargeLinks(receiptId, model).receipt;
  return h('div', { style: { display: 'contents' } }, Children.map(children, child => isValidElement(child) && child.props.title === 'Charged for this call' && href && !(calls?.length > 1) ? link(href, child.props.children, 'Check receipt for this charge') : child), calls?.length > 1 ? calls.map((call, index) => call.receiptId ? h('span', { key: call.callId || call.receiptId }, link(chargeLinks(call.receiptId).receipt, 'Call ' + (index + 1) + ' receipt')) : h('span', { key: index }, 'Call ' + (index + 1) + ': no receipt recorded')) : null, h(ChargeModelLink, { model }));
}
export function linkedReliability(report) {
  return { ...report, models: report.models.map(row => ({ ...row, calls: link(activityHref(callFilters(report, modelFilter(row.model))), row.calls, 'View recorded calls for ' + (row.model || 'unrecorded model')) })) };
}
export function SavingsChargeLink({ report, row }) {
  return link(activityHref(callFilters(report, { ...modelFilter(row.model), paid: 'true' })), 'View charged calls');
}

export function RecordedChargeLinks({ receiptId, model }) {
  const links = chargeLinks(receiptId, model);
  return links.receipt || links.model ? h('span', { className: 'button-row' }, links.receipt ? link(links.receipt, 'Check receipt') : null, h(ChargeModelLink, { model })) : null;
}
