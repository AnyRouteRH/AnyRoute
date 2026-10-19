// K195: reuse the balance alert's dollar validation.
import { alertAmount } from './runway.js';
export const LOW_BALANCE_PAUSE_PATH = '/api/v1/account/low-balance-pause';
export function pauseAmount(enabled, amount) {
  if (!enabled) return null;
  const value = alertAmount(amount);
  if (value === null) throw new Error('Enter the balance amount that should pause your agents.');
  return value;
}
export const readBalancePause = (request, options) => request(LOW_BALANCE_PAUSE_PATH, options);
export const saveBalancePause = (request, enabled, amount, options) => request(LOW_BALANCE_PAUSE_PATH, { ...options, method: 'PATCH', body: { low_balance_usd: pauseAmount(enabled, amount) } });
