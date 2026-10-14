// H168: presentation only; never add business identity to the signed payload.
export const BUSINESS_FIELDS = [
  ['business_name', 'Business name', 160],
  ['address', 'Address', 1000],
  ['tax_id', 'Tax ID (VAT / GST / EIN)', 120],
  ['reference', 'Reference', 240],
];
export const emptyBusinessDetails = () => Object.fromEntries(BUSINESS_FIELDS.map(([field]) => [field, '']));
export function billedToLines(details) {
  return BUSINESS_FIELDS.flatMap(([field, label]) => details?.[field] ? [[label, details[field]]] : []);
}
// Quote every cell, preserve line breaks and prevent spreadsheet formula execution.
const csvCell = value => {
  const text = String(value ?? '');
  return '"' + (/^[\s]*[=+\-@]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
};
export function statementCsv(statement, details = null) {
  const p = statement.payload;
  const rows = [['Anyroute statement', p.month]];
  const billed = billedToLines(details);
  if (billed.length) rows.push(['Billed to', 'User-entered · outside the signed statement'], ...billed, []);
  rows.push(['Statement amounts', 'Download the signed statement separately to check its signature.'], ['Scope', p.scope], ['From (UTC)', p.from], ['To (UTC, exclusive)', p.to_exclusive], ['Currency', p.currency]);
  for (const [label, field] of [['Opening balance','opening_balance'],['Deposits','deposits'],['Refunds','refunds'],['Usage charged','usage'],['Separate fees','fees'],['Other changes','other_changes'],['Closing balance','closing_balance'],['Calls','calls']]) rows.push([label, p[field]]);
  for (const [label, field] of [['Usage by model','usage_by_model'],['Usage by key / agent','usage_by_key_agent'],['Usage by lane','usage_by_lane'],['Ledger movements','movements_by_kind']]) {
    rows.push([], [label, 'ID', p.currency]);
    for (const row of p[field]) rows.push([row.label || row.id || 'Not recorded', row.id, row.amount]);
  }
  for (const limit of p.limits ?? []) rows.push(['Limit', limit]);
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function downloadStatementCsv(statement, details) {
  const url = URL.createObjectURL(new Blob([statementCsv(statement, details)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `statement-${statement.payload.month}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
