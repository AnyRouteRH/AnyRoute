export const BREAKER_FIELDS = [
  ['max_spend_usd_per_minute', 'Spend per minute (USD)'],
  ['max_requests_per_minute', 'Requests per minute'],
  ['max_denials_per_10min', 'Denials per ten minutes'],
  ['max_distinct_models_per_hour', 'Distinct models per hour'],
];
export const breakerForm = policy => Object.fromEntries(BREAKER_FIELDS.map(([name]) => [name, policy?.breakers?.[name] == null ? '' : String(policy.breakers[name])]));
export function buildBreakers(form, policy, errors) {
  if (!form) return;
  const limits = {};
  for (const [name, label] of BREAKER_FIELDS) {
    const raw = form[name];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(raw), money = name === 'max_spend_usd_per_minute';
    if (!Number.isFinite(n) || n <= 0 || n > (money ? 1_000_000 : Number.MAX_SAFE_INTEGER) || (!money && !Number.isSafeInteger(n))) errors.push(`${label}: enter a positive ${money ? 'USD amount up to 1,000,000' : 'safe whole number'}.`);
    limits[name] = n;
  }
  if (Object.keys(limits).length) policy.breakers = limits;
}
export function trippedBy(record, agent) {
  const reason = record?.killed && record.killed_reason?.startsWith('breaker:') ? record.killed_reason : agent?.policies?.find(p => p.killed && p.killed_reason?.startsWith('breaker:'))?.killed_reason;
  return reason ? reason.slice('breaker:'.length) : null;
}
export const breakerReasonText = code => BREAKER_FIELDS.find(([name]) => code === 'breaker:'+name)?.[1];
