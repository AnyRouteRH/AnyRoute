export const reliabilityPath = '/api/v1/account/reliability?days=7';
export const reliabilityRate = value => value === null ? 'Not recorded' : value.toFixed(1) + '%';
export const reliabilityTiming = (timing, percentile) => timing ? Math.round(timing[percentile]).toLocaleString('en') + ' ms' : 'Not recorded';
export function reliabilityHeadline(totals) {
  if (totals.calls === '0') return 'No recorded calls this week.';
  const success = `${reliabilityRate(totals.success_rate)} of your recorded calls succeeded this week`;
  return totals.fallback_rate === null ? success + '; fallback use was not recorded.' : success + `; ${reliabilityRate(totals.fallback_rate)} with route records used a fallback.`;
}
