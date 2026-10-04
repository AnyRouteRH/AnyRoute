// V96: API-derived credit estimates and deposit progress, shared by funding views.
import { creditEstimate, formatUnits, formatUsd, stageOf } from './anyr-pay.js';
import { relativeTime } from './verify.js';

export function defaultFundingOption(options, officialAnyr) {
  return options.find(item => item.symbol === 'USDG')
    || options.find(item => item.address?.toLowerCase() === officialAnyr?.toLowerCase())
    || options[0];
}

export function fundingQuote(option, amount, now = Date.now()) {
  if (!option) return null;
  const rate = option.kind === 'credits' ? 1 : Number(option.credit_usd_per_token);
  const margin = Number(option.haircut_bps) > 0 ? ` (after a ${Number(option.haircut_bps) / 100}% safety margin)` : '';
  const limit = option.max_usd_per_deposit;
  const estimate = creditEstimate({ amountText: amount, decimals: option.decimals, rate, limit });
  const when = option.price_source === 'chainlink' ? relativeTime(option.price_updated_at, now) : '';
  return {
    rate: rate > 0 ? `1 ${option.symbol} = ${formatUsd(rate)} in credits${margin}` : 'No current credit rate: wait before sending.',
    estimate: estimate.ok && estimate.credit != null
      ? `${formatUnits(estimate.raw, option.decimals, option.decimals)} ${option.symbol} ≈ ${formatUsd(estimate.credit)} in credits${estimate.capped ? ' (per-deposit limit)' : ''}` : '',
    note: option.kind === 'escrow' ? 'This is an estimate. The deposit is priced again when credited, after chain finality. The rate can change.' : '',
    limit: limit != null ? `Up to ${formatUsd(limit).replace(/\.00$/, '')} per deposit.` : '',
    freshness: when ? `Stock price from ${when}.` : '',
    reason: option.price_reason?.message || '',
    warning: estimate.capped ? 'This amount exceeds the per-deposit credit limit. Choose a smaller amount.' : '',
  };
}

export function fundingDepositView(deposit, escrow) {
  const stage = stageOf(deposit);
  const delay = Number(escrow?.expected_credit_delay_s);
  const minutes = Math.max(1, Math.round(delay / 60));
  const wait = Number.isFinite(delay) && delay > 0 ? ` Chain finality usually takes about ${minutes} minute${minutes === 1 ? '' : 's'}; it can take longer.` : '';
  const labels = {
    confirming: 'Waiting for chain finality', awaiting_price: 'Waiting for a price',
    crediting: 'Adding credits to your balance', credited: 'Credited',
    orphaned: 'Dropped by the chain · not credited', reversed: 'Credit reversed',
  };
  return {
    label: labels[stage] || 'Checking deposit status',
    detail: stage === 'confirming' ? wait.trim()
      : stage === 'credited' && deposit.credited_usd != null ? `${formatUsd(deposit.credited_usd)} added to your balance.`
      : stage === 'awaiting_price' ? 'The transfer is final. Credits wait for an available price.' : '',
    note: deposit.note || '',
  };
}
