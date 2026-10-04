export function depositCreditLabel(fastCredit) {
  if (!fastCredit?.enabled) return null;
  const settling = Number(fastCredit.settling_usd);
  if (!Number.isFinite(settling) || settling < 0) return null;
  return settling > 0 ? 'Credited (settling, usually ~20 min)' : 'Final';
}
export function depositWaitText(fastCredit) {
  return fastCredit?.enabled ? 'Eligible deposits can receive credit in seconds after chain inclusion and the required confirmations. Amounts above the early-credit caps wait for finality; timing varies.' : 'Credits wait for chain finality and a current rate.';
}
