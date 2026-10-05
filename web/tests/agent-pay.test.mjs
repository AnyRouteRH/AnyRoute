import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CUSTODY, PAY_OFF, agentRequest, askPay, checkReceipt, confirmPay, instructionRows, isTxHash, memoDigest, payBody, payState, payees, readPayment, receiptRows, senderProblem } from '../lib/agent-pay.js';
import { TASKS } from '../lib/site-map.js';
import { profilePayload } from '../lib/agent-profiles.js';

const WALLET = '0xabababababababababababababababababababab';
const PROFILE = 'AbCdEfGhIjKlMnOpQrStUv_-';
const KEY = 'sk-ar-v1-' + 'a'.repeat(64);

test('the section is on only when the status says agent_pay.enabled is true', () => {
  assert.equal(payState({ agent_pay: { enabled: true } }), 'on');
  for (const data of [{ agent_pay: { enabled: false } }, {}, null, { agent_pay: { enabled: 'yes' } }]) assert.equal(payState(data), 'off');
  assert.match(PAY_OFF, /isn’t switched on/);
  assert.match(CUSTODY, /^Anyroute never holds the money\./);
});

test('the request names a profile or a wallet and a positive USDG amount; a memo is sent only as its digest', async () => {
  assert.deepEqual(payBody({ to: ` ${PROFILE} `, amount: ' 20.5 ' }), { body: { to: PROFILE, amount_usd: '20.5' }, errors: [] });
  assert.deepEqual(payBody({ to: WALLET, amount: '1', memoSha256: 'sha256:' + 'c'.repeat(64), approvalId: 'approval-1' }).body, { to: WALLET, amount_usd: '1', memo_sha256: 'sha256:' + 'c'.repeat(64), approval_id: 'approval-1' });
  for (const to of ['', 'someone', '0x1234', '0x' + '0'.repeat(40)]) assert.equal(payBody({ to, amount: '1' }).errors.length, 1, to);
  for (const amount of ['', '0', '0.000000', '1.1234567', '-1', '1e3', 'ten']) assert.equal(payBody({ to: WALLET, amount }).errors.length, 1, amount);
  assert.equal(await memoDigest('  '), undefined);
  assert.equal(await memoDigest('invoice 42'), 'sha256:' + createHash('sha256').update('invoice 42').digest('hex'));
  assert.ok(isTxHash(' 0x' + 'f'.repeat(64) + ' ')); assert.ok(!isTxHash('0x' + 'f'.repeat(63)));
});

test('directory choices are only agents that publish a wallet', () => {
  const page = { data: [{ name: 'Seller', payout_wallet: WALLET.toUpperCase().replace('0X', '0x'), anyroute: { id: PROFILE } }, { name: 'No wallet', anyroute: { id: PROFILE.replace('A', 'B') } }, { name: 'Bad', payout_wallet: '0x12', anyroute: { id: PROFILE.replace('A', 'C') } }] };
  assert.deepEqual(payees(page), [{ id: PROFILE, name: 'Seller', wallet: WALLET }]);
  assert.deepEqual(payees(null), []);
  assert.deepEqual(profilePayload({ name: 'A', description: '', homepage: '', payout_wallet: ` ${WALLET} `, tags: '', show: [], claims: '' }).payout_wallet, WALLET);
  assert.equal(profilePayload({ name: 'A', description: '', homepage: '', payout_wallet: '', tags: '', show: [], claims: '' }).payout_wallet, undefined);
});

test('instructions and receipts read as plain rows; a wallet the router would refuse is caught before sending', () => {
  const p = { amount: '20', amount_units: '20000000', token: { address: '0x5fc5', decimals: 6 }, to: WALLET, chain_name: 'Robinhood Chain', chain_id: 4663, from: ['0x1111'], reference: 'pay-abcdefgh' };
  assert.deepEqual(Object.fromEntries(instructionRows(p)), { Send: '20 USDG (20000000 base units, 6 decimals)', To: WALLET, 'USDG contract': '0x5fc5', Network: 'Robinhood Chain (chain id 4663)', From: '0x1111', Reference: 'pay-abcdefgh' });
  assert.equal(Object.fromEntries(instructionRows({ ...p, from: [] })).From, 'No wallet is linked to this account yet');
  const rows = Object.fromEntries(receiptRows({ status: 'seen', paid: '25', recipient: { wallet: WALLET, profile_id: PROFILE }, payer_wallet: '0x1111', tx_hash: '0xabc', block_number: '90', verified_at: '2026-10-05T00:00:00.000Z', decision_id: 'd1', receipt: { payload: { policy_sha256: 'digest' } } }));
  assert.equal(rows.Status, 'Seen, waiting for finality'); assert.equal(rows.Paid, '25 USDG'); assert.equal(rows.Recipient, `${WALLET} (agent ${PROFILE})`); assert.equal(rows.Rulebook, 'digest');
  assert.equal(Object.fromEntries(receiptRows({ status: 'reversed', recipient: { wallet: WALLET }, decision_id: 'd1', reason: 'the transaction is no longer on the canonical chain' })).Reason, 'the transaction is no longer on the canonical chain');
  assert.equal(senderProblem('0x1111', ['0x1111']), '');
  assert.match(senderProblem('0x2222', ['0x1111']), /not linked to this account/);
});

test('every call uses the selected agent’s own key, checked first, never the connected management key', async () => {
  const calls = [];
  const request = async (path, options) => { calls.push([path, options.key, options.method || 'GET', options.body]); return path === '/api/v1/agents/me' ? { data: { key_hash: 'agent-hash' } } : { data: { ok: path } }; };
  await assert.rejects(agentRequest('agent-hash', 'not-a-key', request), /selected agent’s API key/);
  await assert.rejects(agentRequest('other-hash', KEY, request), /different agent/);
  const send = await agentRequest('agent-hash', ` ${KEY} `, request);
  assert.deepEqual(await askPay(send, { to: WALLET, amount_usd: '1' }), { ok: '/api/v1/agents/pay' });
  assert.deepEqual(await confirmPay(send, 'id/1', ' 0xabc '), { ok: '/api/v1/agents/pay/id%2F1/confirm' });
  assert.deepEqual(await readPayment(send, 'id/1'), { ok: '/api/v1/agents/pay/id%2F1' });
  assert.ok(calls.every(([, key]) => key === KEY));
  assert.deepEqual(calls.slice(-3).map(c => [c[0], c[2], c[3]]), [['/api/v1/agents/pay', 'POST', { to: WALLET, amount_usd: '1' }], ['/api/v1/agents/pay/id%2F1/confirm', 'POST', { tx_hash: '0xabc' }], ['/api/v1/agents/pay/id%2F1', 'GET', undefined]]);
  const verified = [];
  assert.equal(await checkReceipt(async (path, o) => { verified.push([path, o.body]); return { data: { valid: true } }; }, { payload: { a: 1 }, sig: 's', key_id: 'k', alg: 'Ed25519' }), true);
  assert.deepEqual(verified, [['/api/v1/receipts/verify', { payload: { a: 1 }, sig: 's', key_id: 'k' }]]);
});

test('the /agents section, docs, Labs and search say Anyroute never holds the money and keep public wording', () => {
  const section = readFileSync('app/agents/PayAgent.jsx', 'utf8'), docs = readFileSync('components/AgentPayDocs.jsx', 'utf8');
  assert.match(section, /id="pay-agent"/); assert.match(section, /payState\(r\.data\)/); assert.match(section, /agentRequest\(agent\.key_hash, secret\)/);
  assert.match(section, /sendTransactions\(address/); assert.match(section, /senderProblem\(address, p\.from\)/);
  assert.match(readFileSync('app/agents/Agents.jsx', 'utf8'), /<PayAgent agent=\{key && !off \? agent : null\}\/>/);
  assert.match(docs, /id="agent-pay"/); assert.match(docs, /Anyroute never holds the money\./); assert.match(docs, /AGENT_PAY_ENABLED \(default false\)/);
  assert.doesNotMatch(docs, /x402/);
  const task = TASKS.find(t => t.id === 'pay-agent');
  assert.equal(task.href, '/agents/#pay-agent'); assert.equal(task.menu, false); assert.equal(task.group, 'agents');
  const banned = new RegExp(String.raw`\b(?:${['de' + 'mo', 'te' + 'st', 'te' + 'sted', 'lo' + 'cal', 'mo' + 'ck', 'simu' + 'lated', 'place' + 'holder', 'fix' + 'ture', 'ea' + 'rn', 'yi' + 'eld', 'A' + 'PY', 'ret' + 'urns', 'pri' + 'vate', 'bo' + 'nds?'].join('|')})\b|no lo` + 'gs', 'i');
  for (const [name, text] of [['section', section.replace(/^import[^\n]*\n/gm, '')], ['docs', docs.replace(/^import[^\n]*\n/gm, '')], ['lib', readFileSync('lib/agent-pay.js', 'utf8').replace(/\.test\(/g, '(')]]) assert.doesNotMatch(text, banned, name);
});
