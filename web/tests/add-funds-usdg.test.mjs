import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { USDG_ESCROW_NOTE, escrowFundingTransaction, escrowTokenChoices, fundingAmount, fundingOptions } from '../lib/add-funds.js';
import { defaultFundingOption, fundingQuote } from '../lib/funding-display.js';
import { depositProgressView } from '../lib/deposit-progress.js';

// Add funds with USDG: escrow lists USDG at par (price_source "par"); GET /api/v1/status escrow.usdg says whether it is on.
const address = digit => '0x' + digit.repeat(40);
const hash = '0x' + '1'.repeat(64);
const usdgToken = { symbol: 'USDG', address: address('7'), decimals: 6, price_source: 'par', price_usd: 1, credit_usd_per_token: 1, haircut_bps: 0, max_usd_per_deposit: 1000, price_reason: null };
const stock = { symbol: 'STOCK', address: address('5'), decimals: 18, price_source: 'chainlink', credit_usd_per_token: 10, haircut_bps: 300, max_usd_per_deposit: null };
const anyr = { symbol: 'ANYR', address: address('4'), decimals: 18, price_source: 'twap', credit_usd_per_token: .1, max_usd_per_deposit: 10, haircut_bps: 0 };
const on = { enabled: true, haircut_bps: 0, max_usd_per_deposit: 1000 };
const details = (usdgEscrow = on, tokens = [stock, anyr, usdgToken]) => ({
  chain: { chain_id: 4663 }, credits: {}, stock: { wallet: address('6') }, officialAnyr: address('4'), usdgEscrow,
  escrow: { enabled: true, chain_id: 4663, address: address('3'), anyr: { address: address('4') }, tokens },
});

test('USDG is the first option when status says it is switched on, sent to the escrow address with the 1:1 copy', () => {
  const choices = fundingOptions(details());
  assert.deepEqual(choices.map(item => item.symbol), ['USDG', 'STOCK', '$ANYR']);
  const [usdg] = choices;
  assert.equal(usdg.kind, 'escrow'); assert.equal(usdg.id, usdgToken.address); assert.equal(usdg.address, usdgToken.address);
  assert.equal(usdg.to, address('3')); assert.equal(usdg.wallet, address('6'));
  assert.equal(usdg.note, 'Send USDG to this address; it’s credited 1:1.'); assert.equal(USDG_ESCROW_NOTE, usdg.note);
  assert.equal(defaultFundingOption(choices, address('4')), usdg);
  assert.equal(choices.slice(1).some(item => item.note), false);
});

test('switched off or absent in status, nothing changes: USDG at par is left out and the other options keep their order', () => {
  const before = fundingOptions(details(on, [stock, anyr]));
  for (const usdgEscrow of [undefined, null, { enabled: false, haircut_bps: null, max_usd_per_deposit: null }, { enabled: 'true' }]) {
    assert.deepEqual(fundingOptions({ ...details(), usdgEscrow }), before);
  }
  assert.deepEqual(before.map(item => item.symbol), ['STOCK', '$ANYR']);
  // Still refused without a signed-in wallet, on another chain, or for a session.
  assert.deepEqual(fundingOptions({ ...details(), stock: { wallet: null } }), []);
  assert.deepEqual(fundingOptions({ ...details(), chain: { chain_id: 1 } }), []);
  assert.deepEqual(fundingOptions({ ...details(), credits: { session: 'session' } }), []);
});

test('a par token that is not 6-decimal USDG is never offered', () => {
  for (const odd of [{ ...usdgToken, symbol: 'USDX' }, { ...usdgToken, decimals: 18 }, { ...usdgToken, address: 'not-an-address' }]) {
    assert.deepEqual(fundingOptions(details(undefined, [stock, anyr, odd])).map(item => item.symbol), ['STOCK', '$ANYR']);
  }
});

test('beside a Credits contract deposit, the escrow USDG route stays first and the two are labelled apart', () => {
  const source = { ...details(), credits: { deposit: { chain: 4663, token: usdgToken.address, credits_contract: address('2'), key_hash: hash } } };
  const choices = fundingOptions(source);
  assert.deepEqual(choices.map(item => [item.kind, item.label || item.symbol]), [['escrow', 'USDG'], ['credits', 'USDG (Credits contract)'], ['escrow', 'STOCK'], ['escrow', '$ANYR']]);
  assert.equal(new Set(choices.map(item => item.id)).size, choices.length);
  assert.equal(defaultFundingOption(choices, address('4')).kind, 'escrow');
  // Without escrow USDG the Credits option keeps its plain label.
  assert.equal(fundingOptions({ ...source, usdgEscrow: { enabled: false } })[0].label, undefined);
});

test('USDG amounts are exact 6-decimal units, checked against the per-deposit limit before the wallet opens', () => {
  const [usdg] = fundingOptions(details());
  assert.equal(fundingAmount('0.000001', usdg), 1n);
  assert.equal(fundingAmount('1000', usdg), 1_000_000_000n);
  assert.throws(() => fundingAmount('1000.000001', usdg), /per-deposit credit limit/);
  assert.throws(() => fundingAmount('0.0000001', usdg), /6 decimal/);
  assert.throws(() => fundingAmount('0', usdg));
  const tx = escrowFundingTransaction('25.5', usdg, address('6'));
  assert.equal(tx.to, usdgToken.address); assert.equal(tx.data.slice(0, 10), '0xa9059cbb');
  assert.equal(tx.data.slice(10, 74), address('3').slice(2).padStart(64, '0'));
  assert.equal(BigInt('0x' + tx.data.slice(74)), 25_500_000n);
  assert.match(tx.description, /Send 25\.5 USDG to escrow/);
  assert.throws(() => escrowFundingTransaction('1', usdg, address('8')), /wallet that signed in/);
});

test('the quote is $1 per USDG with no repricing note, and shows the per-deposit limit', () => {
  const [usdg] = fundingOptions(details());
  const q = fundingQuote(usdg, '40');
  assert.equal(q.rate, '1 USDG = $1.00 in credits');
  assert.match(q.estimate, /^40(\.0+)? USDG ≈ \$40\.00 in credits$/);
  assert.equal(q.note, ''); assert.equal(q.freshness, ''); assert.equal(q.warning, '');
  assert.equal(q.limit, 'Up to $1,000 per deposit.');
  assert.match(fundingQuote(usdg, '1500').warning, /exceeds the per-deposit credit limit/);
  assert.match(fundingQuote({ ...usdg, haircut_bps: 100, credit_usd_per_token: .99 }, '10').rate, /\$0\.99 in credits \(after a 1% safety margin\)/);
  // Priced tokens keep their estimate note.
  assert.match(fundingQuote(fundingOptions(details())[1], '1').note, /priced again when credited/);
});

test('escrow token choices put USDG first only while status says it is on', () => {
  assert.deepEqual(escrowTokenChoices([stock, anyr, usdgToken], { enabled: true }).map(t => t.symbol), ['USDG', 'STOCK', 'ANYR']);
  assert.deepEqual(escrowTokenChoices([stock, anyr, usdgToken], { enabled: false }).map(t => t.symbol), ['STOCK', 'ANYR']);
  assert.deepEqual(escrowTokenChoices([stock, anyr, usdgToken], undefined).map(t => t.symbol), ['STOCK', 'ANYR']);
  assert.deepEqual(escrowTokenChoices(undefined, { enabled: true }), []);
});

test('deposit progress shows a USDG escrow deposit with its worth fixed at par', () => {
  const d = { lane: 'escrow', symbol: 'USDG', amount: '1250.5', from_address: '0xabab000000000000000000000000000000000001', worth_usd: 1250.5, worth_fixed: true, credited_usd: 0, remaining_s: 600, stage: 'detected' };
  const v = depositProgressView(d);
  assert.equal(v.confirmation, 'We see 1,250.5 USDG from 0xabab…0001.');
  assert.equal(v.worth, 'Worth ≈ $1,250.50 in credits.');
  assert.match(depositProgressView({ ...d, stage: 'provisional', credited_usd: 25 }).status, /Credited \(settling\): \$25\.00/);
  assert.equal(depositProgressView({ ...d, stage: 'final', credited_usd: 1250.5 }).status, 'Credited. $1,250.50 added to your balance. The transfer is final.');
});

test('the add-funds screen reads USDG from status and the docs say when it is credited', () => {
  const source = fs.readFileSync(new URL('../components/account/AddFunds.jsx', import.meta.url), 'utf8');
  assert.match(source, /usdgEscrow: status\.data\?\.escrow\?\.usdg/);
  const docs = fs.readFileSync(new URL('../components/GetUsdgDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /credited 1:1 at anyroute\.tech once switched on/);
});
