import { CHAIN, FEED, checkCap, field, hexAddress, requireValue, validateQuote } from './protocol.js';
export const word = value => {
  const n = BigInt(value);
  requireValue(n >= 0n && n < 2n ** 256n, 'Invalid ABI word.');
  return n.toString(16).padStart(64, '0');
};
export function words(data) {
  requireValue(/^0x(?:[\da-f]{64})+$/i.test(data), 'Malformed chain response.');
  return data.slice(2).match(/.{64}/g).map(w => BigInt('0x' + w));
}
export function depositData(commitment, amount, siblings) {
  requireValue(field(commitment) && siblings?.length === 32 && siblings.every(field), 'Invalid deposit path.');
  return '0xc588341c' + [commitment, amount, ...siblings].map(word).join('');
}
export function closeData(plan, destination) {
  const p = plan.public_inputs;
  requireValue(hexAddress(destination) && plan.mode === 'mutual' && p.has_clearance === true && p.chain_id === CHAIN, 'Invalid mutual-close plan.');
  requireValue(Array.isArray(p.destination) && p.destination.length === 20 && '0x' + p.destination.map(b => b.toString(16).padStart(2, '0')).join('') === destination.toLowerCase(), 'Withdrawal destination mismatch.');
  requireValue(plan.siblings?.length === 32 && plan.siblings.every(field) && plan.proof?.backend === 'groth16_bn254', 'Invalid withdrawal proof.');
  const proof = Array.from(Uint8Array.from(atob(plan.proof.proof), c => c.charCodeAt(0)), b => b.toString(16).padStart(2, '0')).join('');
  requireValue(proof.length === 512, 'Invalid Groth16 proof length.');
  const inputs = [p.protocol_version, p.chain_id, p.contract_address, p.active_root, p.state_signing_key_x, p.state_signing_key_y, p.clearance_signing_key_x, p.clearance_signing_key_y, p.note_id, p.final_balance, destination, p.withdrawal_nullifier, 1, p.withdrawal_tag];
  // Static tuple (14 words), dynamic proof offset, static array (32 words).
  return '0x7fca9c82' + [...inputs, 47 * 32, ...plan.siblings, 256].map(word).join('') + proof;
}
export const DEPOSIT_EVENT = '0x7c83dba8534bea9e30d6444f9ca6462dc906897f9938d220dbbe4358c1f7a063';
export const CLOSE_EVENT = '0x1f43fa4711ca18e1d26398f26bf598bd3a62992cdd0e84f055f2bb506e9d7031';
export class WalletChain {
  constructor(provider) { this.provider = provider; }
  rpc(method, params = []) { return this.provider.request({ method, params }); }
  async requireChain() { requireValue(BigInt(await this.rpc('eth_chainId')) === BigInt(CHAIN), 'Switch your wallet to Sepolia before continuing.'); }
  async call(to, data, block = 'latest') { await this.requireChain(); return words(await this.rpc('eth_call', [{ to, data }, block])); }
  async verifyDeployment(m) {
    await this.requireChain();
    requireValue((await this.rpc('eth_getCode', [m.contract_address, 'finalized'])).length > 2, 'The pinned vault is not deployed.');
    const pins = [['0x15fa2a9a', m.state_signing_key.x], ['0x230e2a24', m.state_signing_key.y], ['0xdc41d636', m.clearance_signing_key.x], ['0x112cd6bc', m.clearance_signing_key.y], ['0xf6e01367', m.request_charge_cap], ['0x631b2f10', 0], ['0x4d1352fd', 1e9]];
    for (const [selector, expected] of pins) requireValue((await this.call(m.contract_address, selector, 'finalized'))[0] === BigInt(expected), 'The vault does not match the operator manifest.');
  }
  async quote(q) {
    validateQuote(q);
    const data = await this.call(FEED, '0xfeaf968c', 'finalized');
    requireValue(data.length === 5 && data[0] === BigInt(q.round_id) && data[1] === BigInt(q.answer) && data[3] === BigInt(q.updated_at) && data[4] >= data[0], 'The quote is not the latest finalized ETH/USD round.');
    return q;
  }
  async send(from, to, data, value = 0n) {
    await this.requireChain();
    requireValue(hexAddress(from) && hexAddress(to) && (await this.rpc('eth_accounts')).some(a => a.toLowerCase() === from.toLowerCase()), 'Reconnect the selected funding wallet.');
    try { return await this.rpc('eth_sendTransaction', [{ from, to, data, value: '0x' + value.toString(16), chainId: '0xaa36a7' }]); }
    catch (cause) {
      const error = new Error(cause?.code === 4001 ? 'You declined the wallet transaction. The saved note can be retried.' : 'The wallet did not return a transaction hash. Keep the saved note and check wallet activity before recovering.');
      error.walletRejected = cause?.code === 4001;
      throw error;
    }
  }
  async receipt(hash) {
    await this.requireChain();
    requireValue(/^0x[\da-f]{64}$/i.test(hash), 'Enter the full transaction hash from your wallet.');
    const receipt = await this.rpc('eth_getTransactionReceipt', [hash]);
    requireValue(receipt, 'The transaction is still awaiting confirmation. Keep the saved note and try again.');
    requireValue(receipt.status === '0x1', 'The transaction reverted. The saved note is retained for recovery.');
    return receipt;
  }
  async confirmDeposit(m, draft, hash) {
    const receipt = await this.receipt(hash);
    requireValue(receipt.to?.toLowerCase() === m.contract_address.toLowerCase(), 'Transaction was sent to a different vault.');
    const log = receipt.logs.find(l => l.address.toLowerCase() === m.contract_address.toLowerCase() && l.topics[0] === DEPOSIT_EVENT && BigInt(l.topics[2]) === BigInt(draft.registration_commitment));
    requireValue(log, 'No matching note deposit was found in this transaction.');
    const [amount, expiry] = words(log.data);
    requireValue(amount === BigInt(draft.amount), 'The deposited amount does not match the saved note.');
    const noteId = Number(BigInt(log.topics[1]));
    const note = await this.call(m.contract_address, '0x9f18e4ed' + word(noteId));
    requireValue(note.length === 4 && note[0] === BigInt(draft.registration_commitment) && note[1] === amount && note[2] === expiry && note[3] === 1n, 'The on-chain note is not active or has different terms.');
    return { secret: draft.secret, note_id: noteId, amount: Number(amount), expiry_ts: Number(expiry) };
  }
  async active(m, state) {
    const note = await this.call(m.contract_address, '0x9f18e4ed' + word(state.note_id));
    requireValue(note.length === 4 && note[1] === BigInt(state.deposit_amount) && note[2] === BigInt(state.expiry_ts) && note[3] === 1n, 'The on-chain note is not active.');
    requireValue(state.expiry_ts > Math.floor(Date.now() / 1000), 'This note has expired. Do not request another lease.');
  }
  async validatePath(m, path) {
    requireValue((await this.call(m.contract_address, '0xfdab463d'))[0] === BigInt(path.active_root), 'The indexer is behind the vault. Wait for it to catch up.');
  }
  async depositCap(amount, quote) { await this.quote(quote); checkCap(amount, quote, 5); }
  async closed(m, state, hash) {
    const receipt = await this.receipt(hash);
    requireValue(receipt.to?.toLowerCase() === m.contract_address.toLowerCase(), 'Withdrawal transaction was sent to a different vault.');
    const log = receipt.logs.find(l => l.address.toLowerCase() === m.contract_address.toLowerCase() && l.topics[0] === CLOSE_EVENT && BigInt(l.topics[1]) === BigInt(state.note_id));
    requireValue(log && words(log.data)[1] === BigInt(state.current_balance), 'No matching mutual-close payout was found in this transaction.');
    const note = await this.call(m.contract_address, '0x9f18e4ed' + word(state.note_id));
    requireValue(note[3] === 3n, 'The note is not closed on-chain yet.');
  }
}
