import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultFundingOption, fundingDepositView, fundingQuote } from '../lib/funding-display.js';
import { fundingAmount, fundingOptions } from '../lib/add-funds.js';
import { FundingQuote, FundingDeposits } from '../components/account/FundingDetails.js';

const address = digit => '0x' + digit.repeat(40);
const official = address('4');
const usdg = { id: 'usdg', symbol: 'USDG', address: address('1'), decimals: 6, kind: 'credits' };
const stock = { id: address('5'), symbol: 'NVDA', address: address('5'), decimals: 18, kind: 'escrow', credit_usd_per_token: 227.9472054979, haircut_bps: 300, price_source: 'chainlink' };
const anyr = { id: official, symbol: '$ANYR', address: official, decimals: 18, kind: 'escrow', credit_usd_per_token: 0.0008407692307, haircut_bps: 0, max_usd_per_deposit: 250, price_source: 'twap' };
const now = Date.parse('2026-10-03T12:00:00Z');

test('funding defaults prefer USDG, then the official ANYR address, then the first option', () => {
  assert.equal(defaultFundingOption([stock, anyr, usdg], official), usdg);
  assert.equal(defaultFundingOption([stock, anyr], official), anyr);
  assert.equal(defaultFundingOption([{ ...anyr, address: official.toUpperCase() }, stock], official).symbol, '$ANYR');
  const lookalike = { ...anyr, address: address('9') };
  assert.equal(defaultFundingOption([stock, lookalike], official), stock);
  assert.equal(defaultFundingOption([stock], official), stock);
  assert.equal(defaultFundingOption([], official), undefined);
  const options = fundingOptions({ credits: {}, chain: { chain_id: 4663 }, stock: { wallet: address('6') }, officialAnyr: official,
    escrow: { enabled: true, chain_id: 4663, address: address('3'), anyr: { address: official }, tokens: [stock, { ...anyr, symbol: 'ANYR' }, { ...lookalike, symbol: 'ANYR' }] } });
  assert.deepEqual(options.map(option => option.symbol), ['NVDA', '$ANYR']);
  assert.equal(defaultFundingOption(options, official).address, official);
});

test('rates use the existing dollar formatter and mention only positive safety margins', () => {
  assert.equal(fundingQuote(anyr, '13000').rate, '1 $ANYR = $0.0008408 in credits');
  assert.equal(fundingQuote(stock, '1').rate, '1 NVDA = $227.95 in credits (after a 3% safety margin)');
  assert.equal(fundingQuote({ ...anyr, credit_usd_per_token: .00084 }, '1').rate, '1 $ANYR = $0.00084 in credits');
  assert.equal(fundingQuote({ ...anyr, credit_usd_per_token: 1e-7 }, '1').rate, '1 $ANYR = $0.0000001 in credits');
  assert.equal(fundingQuote({ ...stock, credit_usd_per_token: 123456.789 }, '1').rate, '1 NVDA = $123,456.79 in credits (after a 3% safety margin)');
  assert.doesNotMatch(fundingQuote(anyr, '1').rate, /margin|haircut/);
  assert.equal(fundingQuote(usdg, '10').rate, '1 USDG = $1.00 in credits');
});

test('typed amounts estimate credits without applying the safety margin twice, and keep the refusal', () => {
  const quote = fundingQuote(anyr, '13000');
  assert.equal(quote.estimate, '13,000 $ANYR ≈ $10.93 in credits');
  assert.match(quote.note, /priced again when credited, after chain finality/);
  assert.equal(quote.limit, 'Up to $250 per deposit.');
  assert.equal(fundingQuote(stock, '1').estimate, '1 NVDA ≈ $227.95 in credits');
  assert.equal(fundingQuote(stock, '1').limit, '');
  assert.equal(fundingQuote(usdg, '10.5').estimate, '10.5 USDG ≈ $10.50 in credits');
  assert.equal(fundingQuote(usdg, '10').note, '');
  assert.match(fundingQuote(anyr, '1000000').estimate, /\$250.00 in credits \(per-deposit limit\)/);
  assert.match(fundingQuote(anyr, '1000000').warning, /exceeds/);
  assert.throws(() => fundingAmount('1000000', anyr), /per-deposit credit limit/);
  for (const amount of ['', '.', '0', '-1', '1e4', '13,000', 'abc']) assert.equal(fundingQuote(anyr, amount).estimate, '', amount);
  for (const rate of [null, 0]) {
    const unavailable = { ...anyr, credit_usd_per_token: rate };
    assert.equal(fundingQuote(unavailable, '13000').estimate, '');
    assert.match(fundingQuote(unavailable, '13000').rate, /No current credit rate/);
    assert.throws(() => fundingAmount('13000', unavailable), /rate/);
  }
});

test('stock freshness stays visible and the API decides when pricing is unavailable', () => {
  const aged = { ...stock, price_updated_at: '2026-09-29T12:00:00Z' };
  assert.equal(fundingQuote(aged, '1', now).freshness, 'Stock price from 4 d ago.');
  assert.equal(fundingQuote({ ...stock, price_updated_at: '2026-10-02T12:00:00Z' }, '1', now).freshness, 'Stock price from 1 d ago.');
  assert.equal(fundingQuote({ ...anyr, price_updated_at: aged.price_updated_at }, '1', now).freshness, '');
  for (const date of [null, 'invalid']) assert.equal(fundingQuote({ ...stock, price_updated_at: date }, '1', now).freshness, '');
  // The current API withholds both the rate and timestamp once the configured feed-age guard refuses it.
  const unavailable = { ...stock, credit_usd_per_token: null, price_updated_at: null,
    price_reason: { code: 'feed_stale', message: 'The price feed is unreadable or too old. Equity feeds pause while markets are closed.' } };
  const html = renderToStaticMarkup(h(FundingQuote, { option: unavailable, amount: '1', now }));
  assert.match(html, /No current credit rate/);
  assert.match(html, /Equity feeds pause while markets are closed/);
  assert.doesNotMatch(html, /≈|\$227/);
});

test('deposit stages use chain timing only as an estimate and display credited dollars', () => {
  const escrow = { expected_credit_delay_s: 420 };
  assert.equal(fundingDepositView({ stage: 'confirming' }, escrow).label, 'Waiting for chain finality');
  assert.match(fundingDepositView({ status: 'pending_finality' }, escrow).detail, /usually takes about 7 minutes; it can take longer/);
  assert.match(fundingDepositView({ stage: 'confirming' }, { expected_credit_delay_s: 60 }).detail, /about 1 minute;/);
  for (const delay of [0, null, undefined, NaN]) assert.equal(fundingDepositView({ stage: 'confirming' }, { expected_credit_delay_s: delay }).detail, '');
  assert.equal(fundingDepositView({ stage: 'awaiting_price', status: 'pending' }, escrow).label, 'Waiting for a price');
  assert.equal(fundingDepositView({ stage: 'crediting' }, escrow).label, 'Adding credits to your balance');
  assert.equal(fundingDepositView({ status: 'pending' }, escrow).label, 'Adding credits to your balance');
  assert.equal(fundingDepositView({ stage: 'credited', credited_usd: 10.930000023 }, escrow).detail, '$10.93 added to your balance.');
  assert.equal(fundingDepositView({ status: 'orphaned' }, escrow).label, 'Dropped by the chain · not credited');
  assert.equal(fundingDepositView({ status: 'reversed' }, escrow).label, 'Credit reversed');
  const html = renderToStaticMarkup(h(FundingDeposits, { escrow, deposits: [
    { id: '1', amount: '13000', symbol: 'ANYR', stage: 'confirming' },
    { id: '2', amount: '1', symbol: 'NVDA', stage: 'awaiting_price', note: 'Markets are closed.' },
    { id: '3', amount: '13000', symbol: 'ANYR', stage: 'credited', credited_usd: 10.93 },
  ] }));
  for (const text of ['Waiting for chain finality', 'Waiting for a price', 'Credited', 'Markets are closed.', '$10.93 added']) assert.ok(html.includes(text));
  assert.equal((html.match(/role="status"/g) || []).length, 3);
  assert.doesNotMatch(html, /within a minute|will take|13000 ANYR/);
});

test('rendered quotes omit raw rate decimals and both selectors share the default rule', () => {
  for (const option of [anyr, stock]) {
    const html = renderToStaticMarkup(h(FundingQuote, { option, amount: '13000', now }));
    assert.ok(html.includes('in credits'));
    assert.doesNotMatch(html, /\d+\.\d{10,}|haircut|USDG per token/);
    assert.match(html, /aria-live="polite"/);
  }
  const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const card = read('../components/account/AddFunds.jsx');
  assert.match(card, /options.find\(item => item.id === selected\) \|\| defaultFundingOption\(options, ANYR_CA\)/);
  assert.match(card, /<FundingQuote option=\{option\} amount=\{amount\}/);
  assert.match(card, /<FundingDeposits deposits=\{data\?\.stock\?\.deposits\} escrow=\{data\?\.escrow\}/);
  assert.doesNotMatch(card, /Current credit rate:|USDG per token|haircut/);
  assert.match(read('../components/Dashboard.jsx'), /useState\(defaultFundingOption\(tokens, ANYR_CA\)\?\.symbol/);
});
