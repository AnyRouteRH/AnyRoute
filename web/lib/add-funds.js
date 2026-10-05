// ON1: account funding state and API-derived deposit instructions.
import { depositCreditLabel } from './fast-credit.js';
import { isAddress, toRawAmount, erc20TransferData } from './anyr-pay.js';
export const fundingError = error => error?.type !== 'key_budget_exceeded' && (error?.status === 402 || ['insufficient_credits', 'insufficient_balance'].includes(error?.type) || /insufficient (?:balance|credits)/i.test(error?.message || ''));
export const recoverFundingDraft = (draft, history) => draft || history.findLast(message => message.role === 'user')?.text || '';
export const initialFunding = { phase: 'zero', baseline: null, status: '' };
export function fundingState(state, event) {
  if (event.type === 'dismiss') return { ...state, phase: 'dismissed', resumePhase: state.phase };
  if (event.type === 'open') return { ...state, phase: state.resumePhase || 'zero' };
  if (event.type === 'pending') return { phase: 'pending', baseline: event.total, status: event.status || 'Waiting for confirmation…' };
  if (event.type === 'failed') return { ...state, phase: 'zero', status: '' };
  if (event.type === 'observed') {
    if (state.phase === 'credited' && event.fastCredit?.enabled) return { ...state, status: Number(event.balance) < 0 ? 'Credit reversed. Cover the negative balance before spending again.' : depositCreditLabel(event.fastCredit) || state.status };
    if (state.phase === 'credited' && Number(event.balance) === 0) return initialFunding;
    if (state.baseline != null && Number(event.total) > state.baseline) return { ...state, phase: 'credited', baseline: null, status: depositCreditLabel(event.fastCredit) || 'Credited. Your balance has been updated.' };
    return state;
  }
  return state;
}
// USDG sent to escrow is credited at par; GET /api/v1/status escrow.usdg.enabled says whether the router takes it.
export const USDG_ESCROW_NOTE = 'Send USDG to this address; it’s credited 1:1.';
export function fundingOptions({ credits, escrow, stock, chain, officialAnyr, usdgEscrow }) {
  if (credits?.session || Number(chain?.chain_id) !== 4663) return [];
  const deposit = credits?.deposit;
  const options = [];
  if (Number(deposit?.chain) === 4663 && isAddress(deposit.token) && isAddress(deposit.credits_contract) && /^0x[0-9a-fA-F]{64}$/.test(deposit.key_hash || '')) options.push({ id: 'usdg', symbol: 'USDG', address: deposit.token, to: deposit.credits_contract, decimals: 6, kind: 'credits', keyHash: deposit.key_hash });
  if (escrow?.enabled && Number(escrow.chain_id) === 4663 && isAddress(escrow.address) && isAddress(stock?.wallet)) {
    for (const token of escrow.tokens || []) {
      const anyr = token.symbol === 'ANYR' || token.address?.toLowerCase() === escrow.anyr?.address?.toLowerCase();
      const par = token.price_source === 'par';
      if (!isAddress(token.address) || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) continue;
      if (anyr && token.address.toLowerCase() !== officialAnyr?.toLowerCase()) continue;
      // USDG at par is offered only while status says it is switched on, and then first.
      if (par && (usdgEscrow?.enabled !== true || token.symbol !== 'USDG' || token.decimals !== 6)) continue;
      const option = { ...token, id: token.address, symbol: anyr ? '$ANYR' : token.symbol, to: escrow.address, kind: 'escrow', wallet: stock.wallet, fast_credit: escrow.fast_credit, ...(par ? { note: USDG_ESCROW_NOTE } : {}) };
      if (par) options.unshift(option); else options.push(option);
    }
  }
  // Two USDG routes (escrow and the Credits contract) get distinct labels.
  return options.map(item => item.kind === 'credits' && options.some(o => o.symbol === 'USDG' && o.kind === 'escrow') ? { ...item, label: 'USDG (Credits contract)' } : item);
}
/** Escrow tokens in the order offered: USDG at par first while status says it is switched on, otherwise left out. */
export function escrowTokenChoices(tokens, usdgEscrow) {
  const list = (tokens || []).filter(t => t.price_source !== 'par' || usdgEscrow?.enabled === true);
  return [...list.filter(t => t.price_source === 'par'), ...list.filter(t => t.price_source !== 'par')];
}
export function fundingAmount(amount, option) {
  if (!option) throw new Error('Choose an available payment option.');
  if (option.kind === 'credits' && !/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('Enter a USDG amount with up to 6 decimals.');
  const raw = toRawAmount(amount, option.decimals);
  if (raw <= 0n || raw >= 1n << 256n) throw new Error('Enter an amount above zero within the token limit.');
  if (option.kind === 'escrow') {
    if (!(Number(option.credit_usd_per_token) > 0)) throw new Error('There is no current credit rate. Wait for a rate before sending.');
    if (option.max_usd_per_deposit != null && Number(amount) * Number(option.credit_usd_per_token) > Number(option.max_usd_per_deposit)) throw new Error('This amount exceeds the per-deposit credit limit. Choose a smaller amount.');
  }
  return raw;
}
export function escrowFundingTransaction(amount, option, from) {
  if (from.toLowerCase() !== option.wallet?.toLowerCase()) throw new Error('Use the wallet that signed in. Escrow credits the sending wallet.');
  return { to: option.address, data: erc20TransferData(option.to, fundingAmount(amount, option)), description: `Send ${amount} ${option.symbol} to escrow` };
}
export function validateCreditsTransactions(data, option, raw) {
  // Refuse stale or changed instructions before opening the wallet.
  if (Number(data?.chain) !== 4663 || data.key_hash !== option.keyHash || data.amount_usdg_units !== raw.toString() || data.transactions?.length !== 2 || data.transactions[0].to?.toLowerCase() !== option.address.toLowerCase() || data.transactions[1].to?.toLowerCase() !== option.to.toLowerCase()) throw new Error('Deposit instructions changed. Refresh the payment options before sending.');
  return data.transactions;
}
