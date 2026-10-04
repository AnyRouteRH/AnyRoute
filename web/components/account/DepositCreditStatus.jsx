import { depositCreditLabel } from '../../lib/fast-credit.js';
export default function DepositCreditStatus({ credits }) {
  const label = depositCreditLabel(credits?.fast_credit);
  if (!label || label === 'Final') return null; // V97B: finality is shown per deposit, not inferred from a zero settling balance.
  if (Number(credits.available) < 0) return <p className="help-text" role="status">Credit reversed. Add funds to cover the negative balance before spending again.</p>;
  return <p className="help-text" role="status" aria-live="polite">{label}{Number(credits.fast_credit.settling_usd) > 0 && ` · $${Number(credits.fast_credit.settling_usd).toFixed(2)} settling. A chain reorganization can reverse this credit.`}</p>;
}
