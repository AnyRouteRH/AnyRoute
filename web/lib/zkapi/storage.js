import { CHAIN, digest, field, hexAddress, requireValue } from './protocol.js';
export const STORE = 'anyroute-zkapi-private-wallet-v1';
export const emptyWallet = () => ({ version: 1, deployment: null, state: null, draft: null, journal: null, closing: null });
export function validateWallet(w) {
  requireValue(w && w.version === 1 && !Object.keys(w).some(k => !['version', 'deployment', 'state', 'draft', 'journal', 'closing'].includes(k)), 'Unsupported wallet backup.');
  if (w.deployment) requireValue(w.deployment.chain_id === CHAIN && hexAddress(w.deployment.contract_address), 'Invalid wallet deployment.');
  if (w.state) {
    const s = w.state;
    requireValue(w.deployment && s.chain_id === CHAIN && s.protocol_version === 2 && BigInt(s.contract_address) === BigInt(w.deployment.contract_address), 'Wallet deployment mismatch.');
    requireValue(field(s.secret_s) && BigInt(s.secret_s) !== 0n && field(s.balance_blinding) && field(s.current_anchor) && field(s.current_commitment_x) && field(s.current_commitment_y), 'Invalid private note state.');
    requireValue(Number.isSafeInteger(s.note_id) && s.note_id >= 0 && s.note_id <= 0xffffffff && Number.isSafeInteger(s.expiry_ts) && s.expiry_ts > 0 && Number.isSafeInteger(s.deposit_amount) && s.deposit_amount > 0 && Number.isSafeInteger(s.current_balance) && s.current_balance >= 0 && s.current_balance <= s.deposit_amount && typeof s.is_genesis === 'boolean', 'Invalid private note balance or expiry.');
  }
  if (w.draft) requireValue(w.deployment && !w.state && field(w.draft.secret) && field(w.draft.registration_commitment) && Number.isSafeInteger(w.draft.amount) && w.draft.amount > 0, 'Invalid deposit recovery state.');
  if (w.journal) requireValue(w.state && w.journal.exists === true && field(w.journal.nullifier) && field(w.journal.user_rerandomization) && w.journal.prepared_request?.client_request_id === w.journal.client_request_id && w.journal.prepared_request?.public_inputs?.request_nullifier === w.journal.nullifier && Number.isSafeInteger(w.journal.prepared_request?.public_inputs?.solvency_bound), 'Invalid lease recovery state.');
  if (w.closing) requireValue(w.state && !w.journal && (w.closing.hash === null || /^0x[\da-f]{64}$/i.test(w.closing.hash)), 'Invalid withdrawal recovery state.');
  // Backups are private wallet material, never containers for runtime API keys.
  requireValue(!/"(?:api_key|runtime_key)"\s*:/.test(JSON.stringify(w)), 'Runtime keys cannot be saved in a wallet backup.');
  return w;
}
export function walletStore(storage) {
  return {
    read: () => validateWallet(JSON.parse(storage.getItem(STORE) || JSON.stringify(emptyWallet()))),
    write: w => { validateWallet(w); storage.setItem(STORE, JSON.stringify(w)); return w; },
    async backup() {
      const wallet = this.read();
      const data = JSON.stringify(wallet);
      return JSON.stringify({ format: 'anyroute-zkapi-wallet-v1', wallet, sha256: await digest(new TextEncoder().encode(data)) }, null, 2);
    },
    async restore(text) {
      requireValue(text.length < 2_000_000, 'Wallet backup is too large.');
      const backup = JSON.parse(text);
      requireValue(backup.format === 'anyroute-zkapi-wallet-v1', 'Unsupported backup format.');
      validateWallet(backup.wallet);
      requireValue(await digest(new TextEncoder().encode(JSON.stringify(backup.wallet))) === backup.sha256, 'Backup checksum mismatch.');
      const existing = this.read();
      requireValue(!existing.state && !existing.draft && !existing.journal && !existing.closing, 'This browser already holds a note. Do not overwrite it with an older backup.');
      return this.write(backup.wallet);
    },
  };
}
