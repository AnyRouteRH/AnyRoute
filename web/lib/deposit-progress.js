import { fundingDepositLabel } from './funding-display.js';
import { api } from './api.js';

const dollars = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const short = address => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
export function depositNextText(info, lane = 'escrow') {
  if (lane === 'usdg') {
    const confirmations = Number(info?.confirmations);
    return Number.isInteger(confirmations) && confirmations > 0
      ? `USDG is credited after ${confirmations} block confirmation${confirmations === 1 ? '' : 's'}, usually seconds.`
      : 'USDG is credited after the required block confirmations, usually seconds.';
  }
  const delay = info?.expected_credit_delay_s;
  const minutes = delay != null && Number(delay) > 0 ? Math.max(1, Math.round(Number(delay) / 60)) : null;
  const timing = minutes ? `, usually about ${minutes} minute${minutes === 1 ? '' : 's'}` : '; timing varies';
  const fast = info?.fast_credit;
  return `Your tokens go to AnyRoute’s deposit address. ${fast?.enabled ? `Eligible credits appear in seconds (up to ${dollars(fast.account_max_usd)}); anything above that is added when` : 'Credits are added when'} Robinhood Chain finalises the transfer${timing}.`;
}
export function depositProgressView(d, now = Date.now()) {
  // Keep the exact base-unit-derived decimal string, including amounts beyond Number's precision.
  const [whole, fraction] = d.amount != null ? String(d.amount).split('.') : [];
  const amount = whole != null ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '') : null;
  const observed = amount != null && !['submitted', 'checking', 'orphaned', 'reversed'].includes(d.stage);
  const confirmation = observed ? `We see ${amount} ${d.symbol}${d.from_address ? ` from ${short(d.from_address)}` : ''}.` : null;
  const worth = observed && d.worth_usd != null ? `Worth ≈ ${dollars(d.worth_usd)} in credits.${d.worth_fixed ? '' : ' The rate is fixed when credited.'}` : null;
  const remaining = d.remaining_s != null && d.remaining_s > 0 ? ` About ${Math.max(1, Math.ceil(d.remaining_s / 60))} min left.` : ' Timing varies.';
  const label = fundingDepositLabel(d.stage);
  let status;
  if (d.stage === 'submitted') status = now - Date.parse(d.submitted_at) >= 180_000 ? 'We have not detected this deposit after a few minutes. Check the transaction and the sending wallet; do not send again while it is pending.' : 'Transaction sent. Watching for the deposit; do not send again while it is pending.';
  else if (d.stage === 'provisional') status = `${label}: ${dollars(d.credited_usd)}. Waiting for chain finality.${remaining} A chain reorganisation can reverse this credit.`;
  else if (d.lane === 'usdg' && d.stage === 'credited') status = `${label}. ${dollars(d.credited_usd)} added to your balance.`;
  else if (d.lane === 'usdg' && d.stage === 'detected') status = `Detected. ${depositNextText(d, 'usdg')}`;
  else if (d.stage === 'final') status = `${label}. ${dollars(d.credited_usd)} added to your balance. The transfer is final.`;
  else if (d.stage === 'awaiting_price') status = `${label}. The transfer is final; credits are added when a current rate is available.`;
  else if (d.stage === 'crediting') status = `${label}. The transfer is final; the router adds the credits on its next check.`;
  else if (d.stage === 'checking') status = 'Checking the transfer against the chain. Its current status is unknown; the next refresh will try again.';
  else if (d.stage === 'orphaned') status = 'The transfer is no longer confirmed on the chain. Check the transaction before sending again.';
  else if (d.stage === 'reversed') status = `${label} after a chain reorganisation. Add funds to cover any negative balance before spending again.`;
  else status = `Detected. ${label}.${remaining}`;
  return { confirmation, worth, status, final: ['final', 'credited'].includes(d.stage) };
}
// Each mounted view shares the same recent API read; account data stays in memory only.
const reads = new Map();
export function readDepositProgress(key) {
  const old = reads.get(key);
  if (old && Date.now() - old.at < 4000) return old.promise;
  const promise = api('/api/v1/credits/deposits', { key }).then(r => r.data);
  reads.set(key, { at: Date.now(), promise });
  promise.then(() => setTimeout(() => { if (reads.get(key)?.promise === promise) reads.delete(key); }, 4000), () => reads.delete(key));
  return promise;
}
export function depositSender(key, lane, onStep) {
  return async (text, sent) => {
    onStep?.(text);
    if (!sent || sent.index !== sent.count - 1) return;
    try {
      await api('/api/v1/credits/deposits', { key, method: 'POST', body: { tx_hash: sent.hash, lane } });
      reads.delete(key);
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('anyroute-deposit-sent'));
    } catch {
      onStep?.(`Transaction sent: ${sent.hash}. Could not save its status. Check your wallet; detected deposits will appear on the next refresh.`);
    }
  };
}
