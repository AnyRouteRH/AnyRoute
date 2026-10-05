import test from 'node:test';
import assert from 'node:assert/strict';
import { depositNextText, depositProgressView, depositSender } from '../lib/deposit-progress.js';
import { sendTransactions } from '../lib/wallet.js';
import { depositView, stageOf } from '../lib/anyr-pay.js';
const base = { amount: '13000', symbol: '$ANYR', from_address: '0xabcd000000000000000000000000000000001234', worth_usd: 10.93, remaining_s: 600, credited_usd: 0 };
test('detected amount and worth precede status; the delay is from API block progress', () => {
  const v = depositProgressView({ ...base, stage: 'detected' });
  assert.equal(v.confirmation, 'We see 13,000 $ANYR from 0xabcd…1234.');
  assert.match(v.worth, /Worth ≈ \$10.93 in credits/);
  assert.match(v.status, /Detected.*About 10 min left/);
  assert.match(depositProgressView({ ...base, stage: 'detected', remaining_s: null }).status, /Timing varies/);
  assert.match(depositProgressView({ ...base, stage: 'detected', amount: '9007199254740993.123456789012345678901' }).confirmation, /9,007,199,254,740,993.123456789012345678901/);
});
test('settling, final, price wait, indexing wait, unknown, orphan and reversal states are distinct', () => {
  assert.match(depositProgressView({ ...base, stage: 'provisional', credited_usd: 10.93 }).status, /Credited \(settling\): \$10.93.*10 min left.*reverse/);
  const final = depositProgressView({ ...base, stage: 'final', credited_usd: 10.93 });
  assert.equal(final.status, 'Credited. $10.93 added to your balance. The transfer is final.'); assert.equal(final.final, true);
  assert.match(depositProgressView({ ...base, stage: 'awaiting_price' }).status, /Waiting for a price.*current rate/);
  assert.match(depositProgressView({ ...base, stage: 'crediting' }).status, /next check/);
  assert.match(depositProgressView({ ...base, stage: 'checking' }).status, /unknown/);
  assert.match(depositProgressView({ ...base, stage: 'orphaned' }).status, /no longer confirmed/);
  assert.match(depositProgressView({ ...base, stage: 'reversed' }).status, /Credit reversed/);
});
test('the existing ANYR tracker recognises provisional credits instead of calling them lost', () => {
  assert.equal(stageOf({ status: 'provisional' }), 'provisional');
  assert.equal(depositView({ status: 'provisional', credited_usd: 10.93 }).label, 'Credited (settling)');
});
test('submitted has no amount claim and becomes an actionable warning after three minutes', () => {
  const d = { stage: 'submitted', submitted_at: new Date(0).toISOString() };
  assert.equal(depositProgressView(d, 1000).confirmation, null);
  assert.match(depositProgressView(d, 1000).status, /Watching for the deposit/);
  assert.match(depositProgressView(d, 180_000).status, /not detected.*few minutes.*Check the transaction/);
});
test('send copy uses API delay and caps; fast-credit-off copy never promises seconds', () => {
  assert.equal(depositNextText({ expected_credit_delay_s: 1200 }), 'Your tokens go to Anyroute’s deposit address. Credits are added when Robinhood Chain finalises the transfer, usually about 20 minutes.');
  assert.match(depositNextText({ expected_credit_delay_s: 780, fast_credit: { enabled: true, account_max_usd: 25 } }), /seconds \(up to \$25.00\).*about 13 minutes/);
  assert.doesNotMatch(depositNextText({ fast_credit: { enabled: false }, expected_credit_delay_s: null }), /seconds|20 minutes/);
  assert.match(depositNextText(), /timing varies/);
});
test('wallet persists only the actual deposit hash before waiting for its receipt, never approval or form amounts', async () => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch; const calls = [], statuses = [];
  let n = 0;
  globalThis.window = { dispatchEvent() {}, ethereum: { request: async ({ method }) => {
    if (method === 'eth_sendTransaction') return `0x${String(++n).repeat(64)}`;
    if (method === 'eth_getTransactionReceipt') { if (n === 2) assert.equal(calls.length, 1); return { status: '0x1' }; }
  } } };
  globalThis.fetch = async (_, init) => { calls.push(JSON.parse(init.body)); return new Response('{"data":{"stage":"submitted"}}', { status: 202 }); };
  try {
    await sendTransactions('sample-wallet', [{ to: 'token', data: 'approve' }, { to: 'credits', data: 'deposit' }], depositSender('sample-key', 'usdg', s => statuses.push(s)));
    assert.deepEqual(calls, [{ tx_hash: `0x${'2'.repeat(64)}`, lane: 'usdg' }]);
    assert.ok(statuses.some(s => /waiting for confirmation/.test(s)));
  } finally { globalThis.window = oldWindow; globalThis.fetch = oldFetch; }
});

test('USDG copy and status use API confirmations with either escrow fast-credit setting', () => {
  for (const enabled of [false, true]) {
    const info = { confirmations: 3, expected_credit_delay_s: 1200, fast_credit: { enabled, account_max_usd: 25 } };
    assert.equal(depositNextText(info, 'usdg'), 'USDG is credited after 3 block confirmations, usually seconds.');
    const detected = depositProgressView({ ...base, lane: 'usdg', symbol: 'USDG', stage: 'detected', confirmations: 3 });
    assert.match(detected.status, /Detected.*3 block confirmations, usually seconds/);
    assert.doesNotMatch(detected.status, /finality|minute|settling|final/);
    const credited = depositProgressView({ ...base, lane: 'usdg', symbol: 'USDG', stage: 'credited', credited_usd: 13 });
    assert.equal(credited.status, 'Credited. $13.00 added to your balance.');
    assert.equal(credited.final, true);
  }
  assert.equal(depositNextText({ confirmations: 1 }, 'usdg'), 'USDG is credited after 1 block confirmation, usually seconds.');
});
