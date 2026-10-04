import { createElement as h } from 'react';
import { fundingDepositView, fundingQuote } from '../../lib/funding-display.js';

export function FundingQuote({ option, amount, now }) {
  const quote = fundingQuote(option, amount, now);
  if (!quote) return null;
  return h('div', { 'aria-label': 'Credit estimate', 'aria-live': 'polite' },
    h('p', null, quote.rate),
    quote.estimate && h('p', null, h('strong', null, quote.estimate)),
    quote.note && h('p', null, quote.note),
    quote.limit && h('p', null, quote.limit),
    quote.freshness && h('p', null, quote.freshness),
    quote.reason && h('p', null, quote.reason),
    quote.warning && h('p', { className: 'error' }, quote.warning));
}

export function FundingDeposits({ deposits, escrow }) {
  return (deposits || []).slice(0, 3).map(deposit => {
    const view = fundingDepositView(deposit, escrow);
    return h('p', { key: deposit.id, role: 'status' },
      `${deposit.amount ?? ''} ${deposit.symbol === 'ANYR' ? '$ANYR' : deposit.symbol || 'token'}: ${view.label}.`,
      view.detail && ` ${view.detail}`, view.note && ` ${view.note}`);
  });
}
