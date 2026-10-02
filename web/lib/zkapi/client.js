import { CHAIN, MAX_LEASE_USD, MAX_NOTE_USD, checkCap, hexAddress, jsonRequest, requireValue, usdFromUnits, validateQuote, walletConfig } from './protocol.js';
import { closeData, depositData } from './chain.js';

// Select only public wire fields, including when recovering an imported journal.
export function publicRequest(journal, config) {
  const r = journal.prepared_request;
  const p = r.public_inputs;
  requireValue(p.protocol_version === 2 && p.chain_id === CHAIN && BigInt(p.contract_address) === BigInt(config.contract_address) && BigInt(p.state_signing_key_x) === BigInt(config.state_signing_key.x) && BigInt(p.state_signing_key_y) === BigInt(config.state_signing_key.y) && p.solvency_bound === config.request_charge_cap, 'Saved request belongs to a different deployment.');
  const payload = JSON.parse(r.payload);
  requireValue(payload.mode === 'openrouter_ephemeral_lease' && payload.version === 1 && Object.keys(payload).sort().join(',') === 'billing_quote,mode,version', 'Saved authorization contains unsupported fields.');
  const quoteKeys = 'answer,asset,chain_id,decimals,expires_at,feed_address,round_id,units_per_eth,updated_at';
  requireValue(Object.keys(payload.billing_quote).sort().join(',') === quoteKeys, 'Saved quote contains unsupported fields.');
  validateQuote(payload.billing_quote, payload.billing_quote.updated_at);
  const inputKeys = ['protocol_version', 'chain_id', 'contract_address', 'active_root', 'state_signing_key_x', 'state_signing_key_y', 'request_time', 'solvency_bound', 'request_nullifier', 'authorization_tag', 'anonymous_commitment_x', 'anonymous_commitment_y'];
  requireValue(r.proof?.backend === 'groth16_bn254' && typeof r.proof.proof === 'string' && r.proof.proof.length === 344 && /^[A-Za-z0-9+/]+={0,2}$/.test(r.proof.proof), 'Invalid saved proof.');
  requireValue(typeof r.client_request_id === 'string' && /^zkapi-[\da-f-]{36}$/i.test(r.client_request_id), 'Invalid saved request identifier.');
  return { client_request_id: r.client_request_id, payload: r.payload, payload_hash: r.payload_hash, public_inputs: Object.fromEntries(inputKeys.map(k => [k, p[k]])), proof: { backend: r.proof.backend, proof: r.proof.proof } };
}
export class ZkapiClient {
  constructor({ manifest, store, prover, chain, inferenceBase, fetcher = fetch, lock = callback => navigator.locks.request('anyroute-zkapi-private-wallet', { mode: 'exclusive', ifAvailable: true }, acquired => { requireValue(acquired, 'Another tab is using your private wallet.'); return callback(); }) }) {
    this.manifest = manifest; this.config = walletConfig(manifest); this.store = store; this.prover = prover; this.chain = chain;
    this.inferenceBase = inferenceBase.replace(/\/$/, ''); this.fetcher = fetcher; this.lock = lock;
    this.lease = null; this.spend = 0;
  }
  current() {
    const wallet = this.store.read();
    if (wallet.deployment) requireValue(wallet.deployment.chain_id === CHAIN && wallet.deployment.contract_address.toLowerCase() === this.manifest.contract_address.toLowerCase(), 'This note belongs to a different vault. Use its original operator to recover it.');
    return wallet;
  }
  operator(path, body) { return jsonRequest(this.manifest.operator_url, path, body, this.fetcher); }
  async quote() { return this.chain.quote(await this.operator('/v2/billing/quote')); }
  async path(noteId, existing) {
    // Whole-tree reads avoid disclosing which note belongs to this browser.
    const snapshot = await jsonRequest(this.manifest.indexer_url, '/v1/tree/snapshot', undefined, this.fetcher);
    const path = await this.prover.call('path', { snapshot, noteId: existing ? noteId : snapshot.next_note_id, existing });
    await this.chain.validatePath(this.manifest, path);
    return path;
  }
  deposit(from, amount) { return this.lock(async () => {
    requireValue(this.manifest.admission_enabled, 'Operator funding is paused. Existing notes can still be recovered and withdrawn.');
    const w = this.current();
    requireValue(!w.state && !w.draft && !w.journal && !w.closing, 'Finish or recover the current note before making another deposit.');
    const quote = await this.quote(); checkCap(amount, quote, MAX_NOTE_USD); checkCap(this.config.request_charge_cap, quote, MAX_LEASE_USD);
    requireValue(amount >= this.config.request_charge_cap, 'Deposit at least the displayed proof solvency minimum.');
    await this.chain.verifyDeployment(this.manifest);
    const params = await this.prover.call('generate');
    const next = { ...w, deployment: { chain_id: CHAIN, contract_address: this.manifest.contract_address }, draft: { ...params, amount, hash: null, stage: 'prepared' } };
    this.store.write(next); // Save the secret before even opening the signing prompt.
    return this.submitDraft(next, from, quote);
  }); }
  retryDeposit(from) { return this.lock(async () => {
    requireValue(this.manifest.admission_enabled, 'Operator funding is paused. Keep the saved note.');
    const w = this.current();
    requireValue(w.draft?.stage === 'prepared' && !w.draft.hash, 'A submission may already exist. Recover its transaction hash instead of retrying.');
    return this.submitDraft(w, from, await this.quote());
  }); }
  async submitDraft(next, from, quote) {
    const { draft } = next;
    checkCap(draft.amount, quote, MAX_NOTE_USD); checkCap(this.config.request_charge_cap, quote, MAX_LEASE_USD);
    await this.chain.verifyDeployment(this.manifest);
    const path = await this.path(null, false);
    await this.chain.depositCap(draft.amount, quote);
    this.store.write({ ...next, draft: { ...draft, stage: 'submitting' } });
    let hash;
    try { hash = await this.chain.send(from, this.manifest.contract_address, depositData(draft.registration_commitment, draft.amount, path.siblings), BigInt(draft.amount) * 1_000_000_000n); }
    catch (e) { if (e.walletRejected) this.store.write(next); throw e; }
    this.store.write({ ...next, draft: { ...next.draft, hash, stage: 'submitted' } });
    return hash;
  }
  recoverDeposit(hash) { return this.lock(async () => {
    const w = this.current(); requireValue(w.draft, 'No deposit is awaiting confirmation.');
    const deposit = await this.chain.confirmDeposit(this.manifest, w.draft, hash || w.draft.hash);
    const state = await this.prover.call('confirm', { config: this.config, deposit });
    return this.store.write({ ...w, state, draft: null });
  }); }
  pay() { return this.lock(async () => {
    requireValue(this.manifest.admission_enabled, 'New leases are paused. Recover or withdraw your existing note.');
    const w = this.current(); requireValue(w.state && !w.journal && !w.closing, 'Recover the pending lease or withdrawal first.');
    requireValue(w.state.expiry_ts > Math.floor(Date.now() / 1000) + 600, 'New leases stop ten minutes before note expiry. Withdraw the remaining balance.');
    await this.chain.active(this.manifest, w.state);
    await this.chain.verifyDeployment(this.manifest);
    const quote = await this.quote(); checkCap(this.config.request_charge_cap, quote, MAX_LEASE_USD);
    const path = await this.path(w.state.note_id, true);
    const prepared = await this.prover.call('request', { config: this.config, state: w.state, artifact: this.manifest.proving_keys.request, request: { payload: JSON.stringify({ mode: 'openrouter_ephemeral_lease', version: 1, billing_quote: quote }), active_root: path.active_root, merkle_siblings: path.siblings, client_request_id: 'zkapi-' + crypto.randomUUID(), request_time: Math.floor(Date.now() / 1000), created_at_ms: Date.now() } });
    this.store.write({ ...w, journal: prepared.journal }); // Durable journal BEFORE issuance; ambiguous errors never clear it.
    const issued = await this.operator('/v2/openrouter/leases', publicRequest(prepared.journal, this.config));
    const max = usdFromUnits(this.config.request_charge_cap, quote);
    requireValue(issued.client_request_id === prepared.journal.client_request_id && /^sk-ar-v1-[\da-f]{64}$/.test(issued.api_key) && issued.openrouter_api_base?.replace(/\/$/, '') === this.inferenceBase && Number.isFinite(issued.spending_limit_usd) && issued.spending_limit_usd > 0 && issued.spending_limit_usd <= MAX_LEASE_USD && issued.spending_limit_usd <= max && Number.isSafeInteger(issued.issued_at) && Number.isSafeInteger(issued.expires_at) && issued.expires_at > Date.now() / 1000 && issued.expires_at <= issued.issued_at + 300 && issued.expires_at < w.state.expiry_ts && Object.keys(quote).every(k => issued.billing_quote?.[k] === quote[k]), 'The returned lease does not match the proof, inference origin, quote, cap or expiry. Retire the saved lease.');
    const scope = await this.fetcher(this.inferenceBase + '/credits', { headers: { Authorization: 'Bearer ' + issued.api_key }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    const result = await scope.json();
    requireValue(scope.status === 403 && result.error?.type === 'inference_only', 'The returned key is not inference-only. Retire the saved lease.');
    this.lease = issued; this.spend = 0;
    return { cap: issued.spending_limit_usd, expires_at: issued.expires_at };
  }); }
  chat(model, prompt) { return this.lock(async () => {
    const w = this.current();
    requireValue(this.lease && w.journal?.client_request_id === this.lease.client_request_id && this.lease.expires_at > Date.now() / 1000, 'Start a fresh lease, or retire the saved lease after reloading.');
    requireValue(!w.journal.call_attempted, 'This pilot allows one chat attempt per lease. Retire it before starting another.');
    requireValue(typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 4000 && model === 'meta-llama/llama-3.3-70b-instruct', 'Enter up to 4,000 characters for the pilot model.');
    this.store.write({ ...w, journal: { ...w.journal, call_attempted: true } });
    const response = await this.fetcher(this.inferenceBase + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.lease.api_key }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 64, stream: false }), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    requireValue(response.ok, `Chat was refused (${response.status}). The lease and recovery journal remain saved.`);
    const answer = await response.json();
    const cost = Number(answer.usage?.cost);
    if (Number.isFinite(cost) && cost >= 0) this.spend += cost;
    return { text: answer.choices?.[0]?.message?.content || 'No text answer was returned.', spend: this.spend, receipt: response.headers.get('x-receipt-id') || answer.id || null };
  }); }
  retire() { return this.lock(async () => {
    this.lease = null; // Stop local admission even when network retirement is pending.
    const w = this.current(); requireValue(w.journal, 'No lease needs retirement.');
    const request = publicRequest(w.journal, this.config);
    // Stock operator uses 409 for retirement awaiting settlement. It is pending, never success.
    const response = await this.fetcher(this.manifest.operator_url + '/v2/openrouter/leases/' + encodeURIComponent(request.client_request_id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    requireValue(response.ok || response.status === 409, `Retirement is unavailable (${response.status}). Keep your backup and retry.`);
    return this.recoverSuccessor();
  }); }
  async recoverSuccessor() {
    const w = this.current(); requireValue(w.journal, 'No successor is awaiting recovery.');
    const result = await this.operator('/v2/requests/' + encodeURIComponent(w.journal.client_request_id));
    if (!result.request_response) throw new Error('Settlement is pending. Retry retire / recover after the operator has captured usage.');
    const state = await this.prover.call('complete', { config: this.config, transition: { state: w.state, journal: w.journal, response: result.request_response } });
    requireValue(state.current_balance <= w.state.current_balance && state.current_balance >= 0, 'Invalid successor balance.');
    this.store.write({ ...w, state, journal: null });
    return { charge: w.state.current_balance - state.current_balance, balance: state.current_balance };
  }
  withdraw(from, destination) { return this.lock(async () => {
    const w = this.current(); requireValue(w.state && !w.journal && !w.closing && hexAddress(destination) && BigInt(destination) !== 0n, 'Retire the lease and choose a nonzero withdrawal address first.');
    await this.chain.active(this.manifest, w.state); await this.chain.verifyDeployment(this.manifest);
    const nullifier = await this.prover.call('nullifier', { state: w.state });
    const clearance = await this.operator('/v2/withdraw/clearance', { withdrawal_nullifier: nullifier });
    const path = await this.path(w.state.note_id, true);
    const plan = await this.prover.call('withdraw', { config: this.config, state: w.state, artifact: this.manifest.proving_keys.withdrawal, withdrawal: { mode: 'mutual', destination, active_root: path.active_root, merkle_siblings: path.siblings, clearance } });
    await this.chain.validatePath(this.manifest, path);
    const data = closeData(plan, destination);
    this.store.write({ ...w, closing: { hash: null } });
    let hash;
    try { hash = await this.chain.send(from, this.manifest.contract_address, data); }
    catch (e) { if (e.walletRejected) this.store.write(w); throw e; }
    this.store.write({ ...w, closing: { hash } });
    return hash;
  }); }
  recoverClose(hash) { return this.lock(async () => {
    const w = this.current(); requireValue(w.state && !w.journal, 'No settled note can be recovered.');
    await this.chain.closed(this.manifest, w.state, hash || w.closing?.hash);
    // Clear the browser note only after a confirmed transaction and on-chain Closed status.
    return this.store.write({ ...w, closing: null, state: null, deployment: null });
  }); }
}
