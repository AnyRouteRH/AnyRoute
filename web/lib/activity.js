export const ACTIVITY_KINDS = ['call', 'approval', 'alert', 'deposit', 'agreement', 'policy', 'balance'];
export const ACTIVITY_LABELS = { call: 'Calls', approval: 'Approvals', alert: 'Alerts', deposit: 'Deposits', agreement: 'Agreements', policy: 'Agent rules', balance: 'Balance changes' };
export function activityPath(filters = {}, cursor = '', format = 'json', limit = 50) {
  const query = new URLSearchParams({ format, limit: String(limit) });
  for (const name of ['kind', 'key', 'model', 'from', 'to']) if (filters[name]) query.set(name, filters[name]);
  if (cursor) query.set('cursor', cursor);
  return '/api/v1/activity?' + query;
}
export function activityPage(json) {
  if (!Array.isArray(json?.data) || !['account', 'key'].includes(json.scope)) throw new Error('The activity response could not be read.');
  return { rows: json.data, next: json.next_cursor ?? null, scope: json.scope };
}
export function activityBounds(from, to) {
  return { from: from ? new Date(from + 'T00:00:00Z').toISOString() : '', to: to ? new Date(to + 'T00:00:00Z').toISOString() : '' };
}
export function activityChips(filters) {
  return Object.entries(filters).filter(([, value]) => value).map(([name, value]) => ({ name, label: name === 'kind' ? ACTIVITY_LABELS[value] : name === 'key' ? 'Selected key or agent' : `${name === 'model' ? 'Model' : name === 'from' ? 'From' : 'Before'}: ${value}` }));
}
export async function exportActivity(request, filters, format, signal) {
  let cursor = '', scope, rows = [], csv = '', seen = new Set();
  do {
    let next;
    if (format === 'csv') {
      const text = await request(activityPath(filters, cursor, format, 100), { raw: true, signal, onResponse: response => { next = response.headers.get('x-next-cursor'); } });
      csv += csv ? text.slice(text.indexOf('\r\n') + 2) : text;
    } else {
      const page = activityPage(await request(activityPath(filters, cursor, format, 100), { signal }));
      rows.push(...page.rows); next = page.next; scope = page.scope;
    }
    if (next && seen.has(next)) throw new Error('The activity cursor did not advance.');
    if (next) seen.add(next);
    cursor = next || '';
  } while (cursor);
  return { text: format === 'csv' ? csv : JSON.stringify({ data: rows, scope, next_cursor: null }, null, 2), type: format === 'csv' ? 'text/csv' : 'application/json', name: 'activity.' + format };
}
