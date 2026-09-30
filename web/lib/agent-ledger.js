export const ledgerPath = (keyHash, { from = '', to = '', cursor = '', format = 'json' } = {}) => {
  const query = new URLSearchParams({ format });
  for (const [name, value] of Object.entries({ from, to, cursor })) if (value) query.set(name, value);
  return '/api/v1/agents/' + encodeURIComponent(keyHash) + '/ledger?' + query;
};
export const ledgerBounds = (from, to) => ({ from: from ? new Date(from + 'T00:00:00Z').toISOString() : '', to: to ? new Date(to + 'T00:00:00Z').toISOString() : '' });
export function ledgerPage(json) {
  if (!Array.isArray(json?.data?.rows) || !Array.isArray(json?.data?.totals_per_day)) throw new Error('The activity response could not be read.');
  return { rows: json.data.rows, totals: json.data.totals_per_day, next: json.next_cursor ?? null };
}
export async function downloadLedgerPage(request, keyHash, bounds, cursor, format) {
  const path = ledgerPath(keyHash, { ...bounds, cursor, format });
  const text = await request(path, { raw: true });
  return { text, type: format === 'csv' ? 'text/csv' : 'application/json', name: 'agent-ledger.' + format };
}
