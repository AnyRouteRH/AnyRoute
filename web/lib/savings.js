export const savingsPath = '/api/v1/account/savings?days=30';
// Round exact decimal amounts to cents with integers, including values beyond Number's precision.
export function savingsMoney(value) {
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(3, '0').slice(0, 2)) + (fraction.padEnd(3, '0')[2] >= '5' ? 1n : 0n);
  return '$' + (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (cents % 100n).toString().padStart(2, '0');
}
