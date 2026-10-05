import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fundingOptions, fundingAmount, escrowFundingTransaction, validateCreditsTransactions, fundingState, initialFunding, fundingError, recoverFundingDraft } from '../lib/add-funds.js';
import { sendTransactions } from '../lib/wallet.js';
import { streamChat } from '../lib/api.js';
import { TASKS, menuTasks, ACCOUNT_GROUPS } from '../lib/site-map.js';
const address = digit => '0x' + digit.repeat(40);
const hash = '0x' + '1'.repeat(64);
const details = () => ({ chain: { chain_id: 4663 }, credits: { deposit: { chain: 4663, token: address('1'), credits_contract: address('2'), key_hash: hash } }, escrow: { enabled: true, chain_id: 4663, address: address('3'), anyr: { address: address('4') }, tokens: [{ symbol: 'ANYR', address: address('4'), decimals: 18, credit_usd_per_token: .1, max_usd_per_deposit: 10, haircut_bps: 0 }, { symbol: 'STOCK', address: address('5'), decimals: 18, credit_usd_per_token: 10 }] }, stock: { wallet: address('6') }, officialAnyr: address('4') });

test('zero balance, pending, dismissed, reopened and credited states preserve tracking', () => {
  assert.equal(initialFunding.phase, 'zero');
  let state = fundingState(initialFunding, { type: 'dismiss' });
  assert.equal(state.phase, 'dismissed');
  state = fundingState(state, { type: 'open' }); assert.equal(state.phase, 'zero');
  state = fundingState(state, { type: 'pending', total: 0 }); assert.equal(state.phase, 'pending');
  state = fundingState(state, { type: 'observed', total: 0, balance: 0 }); assert.equal(state.phase, 'pending');
  state = fundingState(state, { type: 'dismiss' });
  assert.equal(fundingState(state, { type: 'open' }).phase, 'pending');
  state = fundingState(state, { type: 'observed', total: 10, balance: 10 }); assert.equal(state.phase, 'credited');
  assert.equal(fundingState(state, { type: 'observed', total: 10, balance: 0 }).phase, 'zero');
  assert.equal(fundingState(initialFunding, { type: 'failed' }).phase, 'zero');
});

test('addresses and choices come from API values, with chain, session and official ANYR guards', () => {
  const source = details(); const choices = fundingOptions(source);
  assert.deepEqual(choices.map(item => item.symbol), ['USDG', '$ANYR', 'STOCK']);
  assert.equal(choices[0].address, source.credits.deposit.token); assert.equal(choices[0].to, source.credits.deposit.credits_contract);
  assert.equal(choices[1].address, source.escrow.tokens[0].address); assert.equal(choices[1].to, source.escrow.address);
  assert.deepEqual(fundingOptions({ ...source, chain: { chain_id: 1 } }), []);
  assert.deepEqual(fundingOptions({ ...source, credits: { session: 'session' } }), []);
  assert.equal(fundingOptions({ ...source, stock: { wallet: null } }).length, 1);
  assert.equal(fundingOptions({ ...source, officialAnyr: address('9') }).some(item => item.symbol === '$ANYR'), false);
  assert.equal(fundingOptions({ ...source, credits: { deposit: { ...source.credits.deposit, credits_contract: null } } }).some(item => item.symbol === 'USDG'), false);
  for (const file of ['../lib/add-funds.js', '../components/account/AddFunds.jsx', '../components/GetUsdgDocs.jsx']) assert.doesNotMatch(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /0x[0-9a-fA-F]{40,}/);
});

test('exact token amounts, rate and limit checks run before wallet transfers', () => {
  const [usdg, anyr] = fundingOptions(details());
  assert.equal(fundingAmount('0.000001', usdg), 1n);
  for (const amount of ['0', '-1', '1e2', '0.0000001']) assert.throws(() => fundingAmount(amount, usdg));
  assert.throws(() => fundingAmount('101', anyr), /limit/);
  assert.throws(() => fundingAmount('1', { ...anyr, credit_usd_per_token: null }), /rate/);
  assert.throws(() => escrowFundingTransaction('10', anyr, address('7')), /wallet that signed in/);
  const tx = escrowFundingTransaction('10', anyr, address('6'));
  assert.equal(tx.to, anyr.address); assert.equal(tx.data.slice(0, 10), '0xa9059cbb');
  assert.equal(tx.data.slice(10, 74), anyr.to.slice(2).padStart(64, '0'));
  assert.equal(BigInt('0x' + tx.data.slice(74)), 10n ** 19n);
  const reply = { chain: 4663, key_hash: hash, amount_usdg_units: '10000000', transactions: [{ to: usdg.address }, { to: usdg.to }] };
  assert.equal(validateCreditsTransactions(reply, usdg, 10000000n), reply.transactions);
  assert.throws(() => validateCreditsTransactions({ ...reply, chain: 1 }, usdg, 10000000n), /changed/);
  assert.throws(() => validateCreditsTransactions({ ...reply, key_hash: 'changed' }, usdg, 10000000n), /changed/);
});

test('402 and insufficient-balance recovery preserve the failed message and newer drafts', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: 'insufficient_credits', message: 'Payment required.' } }), { status: 402 });
  const history = [{ role: 'user', text: 'Keep this message', attachments: [{ id: 'image' }] }];
  try {
    await assert.rejects(streamChat({ key: 'sample-key', body: { messages: history } }), error => {
      assert.equal(fundingError(error), true); assert.equal(recoverFundingDraft('', history), 'Keep this message');
      assert.equal(recoverFundingDraft('New draft', history), 'New draft'); return true;
    });
    assert.equal(history[0].attachments[0].id, 'image');
    assert.equal(fundingError({ type: 'key_budget_exceeded', status: 402 }), false);
    assert.equal(fundingError({ message: 'Insufficient balance' }), true);
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Resumed"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const credited = fundingState(fundingState(initialFunding, { type: 'pending', total: 0 }), { type: 'observed', total: 10, balance: 10 });
    assert.equal(credited.phase, 'credited');
    assert.equal((await streamChat({ key: 'sample-key', body: { messages: history } })).text, 'Resumed');
  } finally { globalThis.fetch = original; }
});

test('the existing wallet sender confirms one escrow transfer and reports rejection', async () => {
  const original = globalThis.window; const calls = []; const statuses = [];
  globalThis.window = { ethereum: { request: async request => { calls.push(request); return request.method === 'eth_sendTransaction' ? 'transaction-id' : { status: '0x1' }; } } };
  try {
    const option = fundingOptions(details())[1];
    const tx = escrowFundingTransaction('10', option, address('6'));
    assert.deepEqual(await sendTransactions(address('6'), [tx], step => statuses.push(step)), ['transaction-id']);
    assert.equal(calls.filter(item => item.method === 'eth_sendTransaction').length, 1);
    assert.ok(statuses.some(item => /waiting for confirmation/.test(item)));
    globalThis.window.ethereum.request = async () => { throw new Error('Wallet rejected'); };
    await assert.rejects(sendTransactions(address('6'), [tx]), /Wallet rejected/);
  } finally { globalThis.window = original; }
});

test('Home, Harness and Playground share funding and explicit retry wiring', () => {
  const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(read('../components/account/AccountHome.jsx'), /<AddFunds key=\{apiKey\}/);
  const harness = read('../components/Harness.jsx');
  assert.match(harness, /fundingError\(err\)/); assert.match(harness, /recoverFundingDraft\(d, history\)/);
  assert.match(harness, /force onResume=\{onRegenerate\}/); assert.match(harness, /lane\.messages\.slice\(0, cut\)/);
  assert.match(read('../components/Dashboard.jsx'), /force onBalance=.*onResume=\{\(\) => run/);
  assert.match(read('../components/account/AddFunds.jsx'), /Number\(available\) > 0/);
  assert.equal(TASKS.find(item => item.id === 'account-payments').title, 'Add funds');
  assert.ok(menuTasks('build').some(item => item.id === 'account-payments')); assert.ok(menuTasks('build').length <= 9);
  assert.equal(TASKS.find(item => item.id === 'get-usdg').menu, false);
  assert.ok(ACCOUNT_GROUPS.find(group => group.title === 'Billing').ids.includes('account-payments'));
});
