// Pay another agent, on /agents. Anyroute never holds the money: the page asks the selected agent's rulebook (Agent
// Guard, action pay.agent), shows what to send, and the agent or person sends USDG from their own wallet straight to
// the recipient. The router then checks that transfer on Robinhood Chain and signs a receipt. Pure helpers, no storage.
import { api, validKey } from './api.js';

export const PAY_OFF = 'Paying another agent isn’t switched on at this router yet.';
export const PAY_UNREAD = 'Couldn’t read whether paying another agent is switched on here.';
export const CUSTODY = 'Anyroute never holds the money. You send USDG from your own wallet straight to the recipient; Anyroute checks the transfer on chain afterwards and signs a receipt.';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PROFILE = /^[A-Za-z0-9_-]{24}$/;
const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

/** On only when GET /api/v1/status says agent_pay.enabled is true; an older router without the field is off. */
export const payState = status => status?.agent_pay?.enabled === true ? 'on' : 'off';
export const isTxHash = value => TX.test(String(value ?? '').trim());
export const isWallet = value => ADDRESS.test(String(value ?? '').trim()) && !/^0x0{40}$/.test(String(value).trim());

/** The body for POST /api/v1/agents/pay, or why it can't be sent. `memoSha256` is already a digest. */
export function payBody({ to, amount, memoSha256, approvalId }) {
  const errors = [], recipient = String(to ?? '').trim(), usd = String(amount ?? '').trim();
  if (!isWallet(recipient) && !PROFILE.test(recipient)) errors.push('Choose an agent from the directory, or enter a 0x wallet address.');
  if (!AMOUNT.test(usd) || !/[1-9]/.test(usd)) errors.push('Enter an amount in USDG above zero, with at most 6 decimals.');
  const body = { to: recipient, amount_usd: usd, ...(memoSha256 ? { memo_sha256: memoSha256 } : {}), ...(approvalId ? { approval_id: approvalId } : {}) };
  return { body, errors };
}

/** SHA-256 of a memo in this browser, so only the digest reaches the router. Empty memo: no digest. */
export async function memoDigest(text, subtle = globalThis.crypto?.subtle) {
  const memo = String(text ?? '');
  if (!memo.trim()) return undefined;
  const bytes = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(memo)));
  return 'sha256:' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Profiles in a directory page that published a payout wallet, as choices. */
export const payees = page => (Array.isArray(page?.data) ? page.data : []).filter(card => isWallet(card?.payout_wallet) && PROFILE.test(card?.anyroute?.id || '')).map(card => ({ id: card.anyroute.id, name: card.name, wallet: card.payout_wallet.toLowerCase() }));

export const PAY_STATUS = { awaiting_transfer: 'Waiting for your transfer', seen: 'Seen, waiting for finality', final: 'Final', reversed: 'Reversed: the transfer left the chain' };
export const payStatusLabel = status => PAY_STATUS[status] || 'Status not reported';

/** What to send, as label and value rows. */
export function instructionRows(p) {
  return [
    ['Send', `${p.amount} USDG (${p.amount_units} base units, ${p.token.decimals} decimals)`],
    ['To', p.to],
    ['USDG contract', p.token.address],
    ['Network', `${p.chain_name} (chain id ${p.chain_id})`],
    ['From', p.from?.length ? p.from.join(', ') : 'No wallet is linked to this account yet'],
    ['Reference', p.reference],
  ];
}

/** The confirmed payment and its signed receipt, as label and value rows. */
export function receiptRows(payment) {
  const r = payment.receipt?.payload || {};
  return [
    ['Status', payStatusLabel(payment.status)],
    ['Paid', payment.paid ? `${payment.paid} USDG` : '—'],
    ['Recipient', payment.recipient?.profile_id ? `${payment.recipient.wallet} (agent ${payment.recipient.profile_id})` : payment.recipient?.wallet],
    ['From', payment.payer_wallet || '—'],
    ['Transaction', payment.tx_hash || '—'],
    ['Block', payment.block_number || '—'],
    ['Verified', payment.verified_at || '—'],
    ['Decision', payment.decision_id],
    ['Rulebook', r.policy_sha256 || '—'],
    ...(payment.reason ? [['Reason', payment.reason]] : []),
  ];
}

/** The connected wallet must be one the router will accept as the sender. */
export function senderProblem(address, from) {
  const a = String(address || '').toLowerCase();
  return (from || []).map(w => w.toLowerCase()).includes(a) ? '' : `The connected wallet ${a || 'is unknown and'} is not linked to this account, so the router would not accept its transfer. Use ${from?.length ? from.join(' or ') : 'a linked wallet'}.`;
}

/** The selected agent's own key, checked against the selected agent; never the connected management key. */
export async function agentRequest(keyHash, agentKey, request = api, signal) {
  if (!keyHash) throw new Error('Select an agent first.');
  if (!validKey(agentKey)) throw new Error('Enter the selected agent’s API key.');
  const key = agentKey.trim();
  const me = await request('/api/v1/agents/me', { key, signal });
  if (me?.data?.key_hash !== keyHash) throw new Error('This key belongs to a different agent. Enter the selected agent’s key.');
  return (path, options = {}) => request(path, { ...options, key });
}

export const askPay = (send, body, signal) => send('/api/v1/agents/pay', { method: 'POST', body, signal }).then(r => r.data);
export const confirmPay = (send, decisionId, txHash, signal) => send('/api/v1/agents/pay/' + encodeURIComponent(decisionId) + '/confirm', { method: 'POST', body: { tx_hash: String(txHash).trim() }, signal }).then(r => r.data);
export const readPayment = (send, decisionId, signal) => send('/api/v1/agents/pay/' + encodeURIComponent(decisionId), { signal }).then(r => r.data);
export const checkReceipt = (request, receipt, signal) => request('/api/v1/receipts/verify', { method: 'POST', body: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id }, signal }).then(r => r.data?.valid === true);
