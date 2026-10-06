// B123: estimates expire; only the API can say a transfer is final.
export function depositCountdown(deposit, now = Date.now()) {
  if (deposit.lane === 'usdg' || !['detected', 'confirming', 'provisional'].includes(deposit.stage || deposit.status)) return null;
  const seconds = deposit.expected_final_at !== undefined
    ? (Date.parse(deposit.expected_final_at) - now) / 1000 : Number(deposit.remaining_s);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return `About ${Math.max(1, Math.ceil(seconds / 60))} min until final`;
}
