// J182: one URL vocabulary for every existing spending view. Never put credentials in links.
import { modelPageHref } from './model-page.js';
export const TRACE_FILTERS = ['kind', 'key', 'model', 'project', 'from', 'to', 'basis', 'charge_kind', 'paid', 'missing_project', 'missing_model', 'lane'];
export function activityFilters(input) {
  const query = input instanceof URLSearchParams ? input : new URL(input, 'https://anyroute.tech').searchParams;
  return Object.fromEntries(TRACE_FILTERS.filter(name => query.get(name)).map(name => [name, query.get(name)]));
}
export function activityHref(filters = {}) {
  const query = new URLSearchParams();
  for (const name of TRACE_FILTERS) if (filters[name]) query.set(name, filters[name]);
  return '/dashboard/' + (query.size ? '?' + query : '') + '#activity';
}
export const callFilters = (range, extra = {}) => ({ kind: 'call', from: range.from, to: range.to, ...extra });
export const modelFilter = model => model == null ? { missing_model: 'true' } : { model };
export const projectFilter = project => project == null ? { missing_project: 'true' } : { project };
export const chargeLinks = (receipt, model) => ({ receipt: receipt ? '/verify/?r=' + encodeURIComponent(receipt) : null, model: model ? modelPageHref(model) : null });
export function afterInstant(value) {
  const date = new Date(value);
  const micros = BigInt(date.getTime()) * 1000n + BigInt((value.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0').slice(3, 6)) + 1n;
  return new Date(Number(micros / 1000n)).toISOString().replace(/\d{3}Z$/, String(micros % 1000000n).padStart(6, '0') + 'Z');
}
export function glanceFilters(row, asOf) {
  const to = asOf || row.as_of;
  return callFilters({ from: row.daily[0].date + 'T00:00:00.000Z', to: to ? afterInstant(to) : new Date(Date.parse(row.daily.at(-1).date) + 86400000).toISOString() }, { key: row.key_hash, basis: 'charges' });
}
export function replyChargeModel(message, fallback) {
  const recorded = message.receipt?.payload?.model || message.receipt?.claims?.model?.id;
  return message.servedModel || (typeof recorded === 'string' ? recorded : recorded?.id) || message.model || fallback;
}
export function chatCharges(lanes = []) {
  const seen = new Set(), rows = [];
  for (const lane of lanes) for (const message of lane.messages || []) {
    if (message.role !== 'assistant') continue;
    const model = replyChargeModel(message, lane.modelId || lane.model?.id);
    const calls = message.continuationCalls || [{ receiptId: message.receipt?.id || message.receiptId, cost: message.usage?.cost ?? message.receipt?.payload?.cost }];
    calls.forEach((call, index) => {
      const id = index === 0 ? message.id || call.receiptId : call.callId || call.receiptId;
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      rows.push({ id: id || String(rows.length), model, receipt: call.receiptId, cost: call.cost });
    });
  }
  return rows;
}
