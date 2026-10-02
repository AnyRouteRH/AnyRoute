import { verifyReceipt } from './verify.js';
export const statementPath = month => '/api/v1/statements/' + encodeURIComponent(month);
export function parseStatement(text) {
  const value = JSON.parse(text); const statement = value?.data ?? value;
  if (statement?.payload?.type !== 'anyroute.statement.v1' || !statement.sig || !statement.key_id) throw new Error('Choose a signed monthly statement JSON file.');
  return statement;
}
const pico = value => {
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,12})?$/.test(value)) throw new Error('A statement amount is invalid.');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (BigInt(whole) * 1000000000000n + BigInt(fraction.padEnd(12, '0'))) * (value.startsWith('-') ? -1n : 1n);
};
export function statementReconciles(p) {
  try {
    if (pico(p.opening_balance) + pico(p.deposits) + pico(p.refunds) - pico(p.usage) - pico(p.fees) + pico(p.other_changes) !== pico(p.closing_balance)) return false;
    for (const name of ['usage_by_model', 'usage_by_key_agent', 'usage_by_lane']) if (!Array.isArray(p[name]) || p[name].reduce((sum, row) => sum + pico(row.amount), 0n) !== pico(p.usage)) return false;
    return Array.isArray(p.movements_by_kind) && pico(p.opening_balance) + p.movements_by_kind.reduce((sum, row) => sum + pico(row.amount), 0n) === pico(p.closing_balance);
  } catch { return false; }
}
export async function verifyStatement(statement, options) {
  if (statement?.payload?.type !== 'anyroute.statement.v1') throw new Error('This is not a monthly statement.');
  const result = await verifyReceipt(statement, options);
  const reconciled = statementReconciles(statement.payload);
  return { ...result, valid: result.valid && reconciled, checks: [...result.checks, { id: 'reconciliation', status: reconciled ? 'pass' : 'fail', detail: reconciled ? 'The printed amounts and usage groups reconcile.' : 'The statement amounts do not reconcile.' }],
    notChecked: ["A valid signature shows what the router signed. This browser has not read the underlying ledger or checked whether it is complete."] };
}
export function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
