// B119: the API is the source of the estimate; never infer days from a rounded daily amount.
export function runwayText(report) {
  const days = report?.days_left;
  if (days === null || !Number.isSafeInteger(days) || days < 0) return '';
  return days === 0 ? 'Less than a day at your 7-day pace' : `Lasts about ${days} ${days === 1 ? 'day' : 'days'} at your 7-day pace`;
}
export function alertAmount(value) {
  if (value.trim() === '') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > 1_000_000) throw new Error('Enter an amount from $0 to $1,000,000, with up to two decimal places.');
  return Number(value);
}
