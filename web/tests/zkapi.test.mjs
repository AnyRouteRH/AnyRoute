import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHAIN, FEED, REVISION, CIRCUIT, checkCap, digest, ethFromUnits, loadManifest, parseEth, validateManifest, validateQuote, walletConfig } from '../lib/zkapi/protocol.js';
import { STORE, emptyWallet, walletStore } from '../lib/zkapi/storage.js';
import { ZkapiClient, publicRequest } from '../lib/zkapi/client.js';
import { DEPOSIT_EVENT, WalletChain, closeData, depositData, word } from '../lib/zkapi/chain.js';
const H = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const vault = '0x' + '12'.repeat(20), destination = '0x' + '34'.repeat(20);
const id = 'zkapi-00000000-0000-4000-8000-000000000000';
const quote = () => ({ asset: 'native_eth', units_per_eth: 1e9, chain_id: CHAIN, feed_address: FEED, round_id: '100', answer: '250000000000', decimals: 8, updated_at: Math.floor(Date.now() / 1000) - 60, expires_at: Math.floor(Date.now() / 1000) - 60 + 4500 });
const manifest = () => ({ protocol_version: 2, chain_id: CHAIN, source_revision: REVISION, circuit_id: CIRCUIT, billing_asset: 'native_eth', billing_unit: 'gwei', contract_address: vault, request_charge_cap: 50_000, admission_enabled: true, state_signing_key: { x: H(1), y: H(2) }, clearance_signing_key: { x: H(3), y: H(4) }, operator_url: 'https://operator.example', indexer_url: 'https://indexer.example', proving_keys: { request: { url: 'https://operator.example/request.pk', sha256: '1'.repeat(64) }, withdrawal: { url: 'https://operator.example/withdrawal.pk', sha256: '2'.repeat(64) } } });
const state = () => ({ protocol_version: 2, chain_id: CHAIN, contract_address: vault, note_id: 0, secret_s: H(42), deposit_amount: 300_000, expiry_ts: Math.floor(Date.now() / 1000) + 86400, current_balance: 300_000, balance_blinding: H(7), current_commitment_x: H(8), current_commitment_y: H(9), current_anchor: H(1), is_genesis: true, state_signature: null });
function memory() { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; }
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
function prepared(args) {
  const p = { protocol_version: 2, chain_id: CHAIN, contract_address: vault, active_root: H(10), state_signing_key_x: H(1), state_signing_key_y: H(2), request_time: Math.floor(Date.now() / 1000), solvency_bound: 50_000, request_nullifier: H(11), authorization_tag: H(12), anonymous_commitment_x: H(13), anonymous_commitment_y: H(14) };
  const request = { client_request_id: args.request.client_request_id, payload: args.request.payload, payload_hash: H(15), public_inputs: p, proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') } };
  return { request, journal: { exists: true, client_request_id: request.client_request_id, nullifier: H(11), payload_hash: H(15), user_rerandomization: H(16), created_at_ms: Date.now(), prepared_request: request } };
}
function fixture(options = {}) {
  const store = walletStore(memory()), m = manifest(), requests = [], operations = [];
  const chain = {
    quote: async q => validateQuote(q), verifyDeployment: async () => {}, active: async () => {}, validatePath: async () => {}, depositCap: async (n, q) => checkCap(n, q, 5),
    send: async (...args) => { operations.push(['send', ...args]); assert.ok(store.read().draft || store.read().state); return H(99); },
    confirmDeposit: async (_, draft) => ({ secret: draft.secret, note_id: 0, amount: draft.amount, expiry_ts: state().expiry_ts }), closed: async () => {},
  };
  const prover = { call: async (op, args) => {
    operations.push([op, args]);
    if (op === 'generate') return { secret: H(42), registration_commitment: H(43) };
    if (op === 'path') return { active_root: H(10), note_id: 0, siblings: Array(32).fill(H(0)) };
    if (op === 'confirm') return { ...state(), deposit_amount: args.deposit.amount, current_balance: args.deposit.amount };
    if (op === 'request') return prepared(args);
    if (op === 'complete') { if (options.invalidSignature) throw new Error('invalid next-state signature'); return { ...args.transition.state, current_balance: args.transition.state.current_balance - 400, is_genesis: false, current_anchor: H(2) }; }
    if (op === 'nullifier') return H(44);
    if (op === 'withdraw') return { mode: 'mutual', siblings: Array(32).fill(H(0)), proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') }, public_inputs: { protocol_version: 2, chain_id: CHAIN, contract_address: vault, active_root: H(10), state_signing_key_x: H(1), state_signing_key_y: H(2), clearance_signing_key_x: H(3), clearance_signing_key_y: H(4), note_id: 0, final_balance: args.state.current_balance, destination: Array(20).fill(0x34), withdrawal_nullifier: H(44), has_clearance: true, withdrawal_tag: H(45) } };
  } };
  const fetcher = async (url, init) => {
    requests.push([url, init]);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    if (url.endsWith('/v2/billing/quote')) return response(quote());
    if (url.endsWith('/v1/tree/snapshot')) return response({ root: H(10), next_note_id: 0, leaves: [] });
    if (url.endsWith('/v2/openrouter/leases')) {
      assert.ok(store.read().journal, 'journal persisted before operator issuance');
      if (options.lostResponse) throw new Error('lost response');
      const r = JSON.parse(init.body);
      return response({ status: 'issued', client_request_id: r.client_request_id, api_key: 'sk-ar-v1-' + 'a'.repeat(64), openrouter_api_base: options.badOrigin ? 'https://wrong.example/api/v1' : 'https://router.example/api/v1', spending_limit_usd: options.cap ?? 0.125, issued_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 300, billing_quote: JSON.parse(r.payload).billing_quote }, 201);
    }
    if (url.endsWith('/credits')) return response({ error: { type: options.badScope ? 'not_restricted' : 'inference_only' } }, 403);
    if (url.includes('/v2/openrouter/leases/')) return response({}, 409);
    if (url.includes('/v2/requests/')) return response(options.pending ? { status: 'pending' } : { request_response: { signed: true } });
    if (url.endsWith('/chat/completions')) { assert.equal(store.read().journal.call_attempted, true); return response({ id: 'gen-receipt', choices: [{ message: { content: 'Hello' } }], usage: { cost: 0.001 } }, 200, { 'x-receipt-id': 'gen-receipt' }); }
    if (url.endsWith('/v2/withdraw/clearance')) return response({ withdrawal_nullifier: H(44), signature: {} });
    throw new Error('unexpected URL ' + url);
  };
  const client = new ZkapiClient({ manifest: m, store, chain, prover, inferenceBase: 'https://router.example/api/v1', fetcher, lock: action => action() });
  return { client, store, requests, operations, chain, prover };
}
function fund(f) { f.store.write({ ...emptyWallet(), deployment: { chain_id: CHAIN, contract_address: vault }, state: state() }); }

test('integer ETH parsing and exact USD ceilings', () => {
  assert.equal(parseEth('0.0003'), 300000); assert.equal(ethFromUnits(300000), '0.000300000');
  for (const bad of ['-1', '1e-3', '0', '0.0000000001', '01', 'Infinity']) assert.throws(() => parseEth(bad));
  checkCap(2_000_000, quote(), 5); assert.throws(() => checkCap(2_000_001, quote(), 5));
  checkCap(400_000, quote(), 1); assert.throws(() => checkCap(400_001, quote(), 1));
});
test('manifest pin, HTTPS, circuit and artifact restrictions fail closed', async () => {
  const m = manifest(), bytes = new TextEncoder().encode(JSON.stringify(m)), hash = await digest(bytes);
  assert.equal((await loadManifest('https://operator.example/config.json', hash, async () => new Response(bytes))).chain_id, CHAIN);
  await assert.rejects(loadManifest('https://operator.example/config.json', 'f'.repeat(64), async () => new Response(bytes)), /hash mismatch/);
  for (const patch of [{ chain_id: 1 }, { source_revision: 'other' }, { operator_url: 'http://operator.example' }, { request_charge_cap: 0 }, { contract_address: H(1) }]) assert.throws(() => validateManifest({ ...manifest(), ...patch }));
  const outside = manifest(); outside.proving_keys.request.url = 'https://other.example/key'; assert.throws(() => validateManifest(outside));
});
test('quote identity, freshness and signed price bounds', () => {
  validateQuote(quote());
  for (const patch of [{ chain_id: 1 }, { answer: '-1' }, { updated_at: 0 }, { expires_at: 1 }, { feed_address: vault }, { decimals: 18 }]) assert.throws(() => validateQuote({ ...quote(), ...patch }));
});
test('ZK8 hosted config resolves its own setup URLs and flattened signer pins', () => {
  const raw = { ...manifest(), protocol_version: undefined, source_commit: REVISION, setup_ceremony: 'single-party', production_audited: false, wei_per_billing_unit: '1000000000', native_price_feed_address: FEED, native_price_feed_decimals: 8, native_price_max_age_seconds: 4500, state_signing_key_x: '1', state_signing_key_y: '2', clearance_signing_key_x: '3', clearance_signing_key_y: '4', setup_provenance: { circuit_revision: REVISION, circuit_id: CIRCUIT, artifacts: { 'request.pk': { sha256: '1'.repeat(64) }, 'withdrawal.pk': { sha256: '2'.repeat(64) } } } };
  const m = validateManifest(raw); assert.equal(m.protocol_version, 2); assert.deepEqual(m.state_signing_key, { x: H(1), y: H(2) }); assert.equal(m.proving_keys.request.url, 'https://operator.example/setup/request.pk');
  assert.throws(() => validateManifest({ ...raw, production_audited: true }));
  assert.throws(() => validateManifest({ ...raw, setup_provenance: { ...raw.setup_provenance, circuit_revision: 'other' } }));
});
test('paused admission blocks new funding and leases but allows a settled note withdrawal', async () => {
  const f = fixture(); f.client.manifest.admission_enabled = false;
  await assert.rejects(f.client.deposit(destination, 300000), /paused/); fund(f); await assert.rejects(f.client.pay(), /paused/);
  await f.client.withdraw(destination, destination); assert.ok(f.store.read().closing);
});
test('complete fake-operator lifecycle saves secrets before signing and verifies settlement before withdrawal', async () => {
  const f = fixture();
  await f.client.deposit(destination, 300000); assert.equal(f.store.read().draft.hash, H(99));
  await f.client.recoverDeposit(); assert.equal(f.store.read().state.current_balance, 300000);
  await f.client.pay(); assert.ok(f.store.read().journal); assert.ok(!JSON.stringify(f.store.read()).includes('api_key'));
  assert.equal((await f.client.chat('meta-llama/llama-3.3-70b-instruct', 'Hello')).receipt, 'gen-receipt');
  await assert.rejects(f.client.chat('meta-llama/llama-3.3-70b-instruct', 'Again'), /one chat attempt/);
  assert.equal((await f.client.retire()).charge, 400); assert.equal(f.store.read().journal, null); assert.equal(f.store.read().state.current_balance, 299600);
  await f.client.withdraw(destination, destination); assert.equal(f.store.read().closing.hash, H(99));
  await f.client.recoverClose(); assert.equal(f.store.read().state, null);
  const operatorBodies = f.requests.filter(([url]) => url.startsWith('https://operator.example')).map(([, init]) => init.body || '').join('\n');
  for (const secret of [H(42), H(7), H(16), 'Hello', destination]) assert.ok(!operatorBodies.includes(secret), 'no witness, prompt or wallet address sent to operator');
  assert.ok(!f.requests.some(([url]) => url.includes('/notes/')));
});
test('over-cap funding never creates a draft or sends a transaction', async () => {
  const f = fixture(); await assert.rejects(f.client.deposit(destination, 2_000_001), /pilot limit/); assert.equal(f.store.read().draft, null); assert.ok(!f.operations.some(([op]) => op === 'send'));
});
test('a rejected deposit can retry its saved secret; an ambiguous submission cannot', async () => {
  for (const rejected of [true, false]) {
    const f = fixture();
    f.chain.send = async () => { const e = new Error('wallet failure'); e.walletRejected = rejected; throw e; };
    await assert.rejects(f.client.deposit(destination, 300000));
    const savedSecret = f.store.read().draft.secret;
    assert.equal(f.store.read().draft.stage, rejected ? 'prepared' : 'submitting');
    f.chain.send = async () => H(99);
    if (rejected) { await f.client.retryDeposit(destination); assert.equal(f.store.read().draft.secret, savedSecret); }
    else await assert.rejects(f.client.retryDeposit(destination), /submission may already exist/);
  }
});
test('storage failure stops funding before wallet signing', async () => {
  const f = fixture(); f.store.write = () => { throw new Error('storage full'); };
  await assert.rejects(f.client.deposit(destination, 300000), /storage full/);
  assert.ok(!f.operations.some(([op]) => op === 'send'));
});
test('new leases stop before expiry without generating or reserving another proof', async () => {
  const f = fixture(); fund(f);
  f.store.write({ ...f.store.read(), state: { ...state(), expiry_ts: Math.floor(Date.now() / 1000) + 599 } });
  await assert.rejects(f.client.pay(), /ten minutes/); assert.equal(f.store.read().journal, null); assert.ok(!f.operations.some(([op]) => op === 'request'));
});
for (const [label, options] of [['lost response', { lostResponse: true }], ['oversized lease', { cap: 2 }], ['wrong inference origin', { badOrigin: true }], ['management-capable key', { badScope: true }]]) {
  test(label + ' preserves the exact saved journal and prevents a fresh lease', async () => {
    const f = fixture(options); fund(f); await assert.rejects(f.client.pay()); assert.ok(f.store.read().journal); assert.equal(f.client.lease, null);
    await assert.rejects(f.client.pay(), /Recover the pending/);
  });
}
test('pending retirement and invalid signatures preserve balances and journals', async () => {
  for (const options of [{ pending: true }, { invalidSignature: true }]) {
    const f = fixture(options); fund(f); await f.client.pay(); await assert.rejects(f.client.retire());
    assert.equal(f.store.read().state.current_balance, 300000); assert.ok(f.store.read().journal); assert.equal(f.client.lease, null);
    await assert.rejects(f.client.withdraw(destination, destination), /Retire/);
  }
});
test('reloading drops the runtime key while the journal remains recoverable', async () => {
  const f = fixture(); fund(f); await f.client.pay(); f.client.lease = null;
  await assert.rejects(f.client.chat('meta-llama/llama-3.3-70b-instruct', 'Hello'), /retire/);
  await f.client.retire(); assert.equal(f.store.read().journal, null);
});
test('an ambiguous withdrawal keeps a pending marker until chain recovery', async () => {
  const f = fixture(); fund(f);
  f.chain.send = async () => { throw new Error('hash response lost'); };
  await assert.rejects(f.client.withdraw(destination, destination), /hash response lost/);
  assert.deepEqual(f.store.read().closing, { hash: null });
  await assert.rejects(f.client.withdraw(destination, destination), /Retire/);
  await f.client.recoverClose(H(99)); assert.equal(f.store.read().state, null);
});
test('backup and restore preserve note and pending journal without overwriting newer state', async () => {
  const f = fixture(); fund(f); await f.client.pay();
  const backup = await f.store.backup(), target = walletStore(memory());
  await target.restore(backup); assert.deepEqual(target.read(), f.store.read()); await assert.rejects(target.restore(backup), /already holds/);
  const damaged = JSON.parse(backup); damaged.wallet.state.current_balance--;
  await assert.rejects(walletStore(memory()).restore(JSON.stringify(damaged)), /checksum/);
  const foreign = JSON.parse(backup); foreign.wallet.state.chain_id = 1;
  await assert.rejects(walletStore(memory()).restore(JSON.stringify(foreign)), /deployment/);
  assert.throws(() => f.store.write({ ...f.store.read(), api_key: 'secret' }), /Unsupported/);
});
test('public proof transport refuses witness-bearing authorization payloads', () => {
  const args = { request: { client_request_id: id, payload: JSON.stringify({ mode: 'openrouter_ephemeral_lease', version: 1, billing_quote: quote() }) } }, journal = prepared(args).journal;
  assert.ok(publicRequest(journal, walletConfig(manifest())).proof);
  journal.prepared_request.payload = JSON.stringify({ ...JSON.parse(args.request.payload), secret: H(42) });
  assert.throws(() => publicRequest(journal, walletConfig(manifest())), /unsupported fields/);
});
test('wallet chain rejects a foreign chain and nonfinalized oracle quote', async () => {
  const wrong = new WalletChain({ request: async () => '0x1' }); await assert.rejects(wrong.requireChain(), /Sepolia/);
  const chain = new WalletChain({ request: async ({ method }) => method === 'eth_chainId' ? '0xaa36a7' : '0x' + [100, 250000000000, 0, quote().updated_at, 99].map(word).join('') });
  await assert.rejects(chain.quote(quote()), /finalized/);
});
test('deposit recovery matches the vault event, saved commitment, amount and active note', async () => {
  const draft = { secret: H(42), registration_commitment: H(43), amount: 300000 };
  const q = quote();
  const chain = new WalletChain({ request: async ({ method, params }) => {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', to: vault, logs: [{ address: vault, topics: [DEPOSIT_EVENT, H(0), H(43)], data: '0x' + [300000, q.updated_at + 86400, 0].map(word).join('') }] };
    if (method === 'eth_call') return '0x' + [43, 300000, q.updated_at + 86400, 1].map(word).join('');
    throw new Error(params);
  } });
  assert.equal((await chain.confirmDeposit(manifest(), draft, H(99))).amount, 300000);
  await assert.rejects(chain.confirmDeposit(manifest(), { ...draft, amount: 1 }, H(99)), /amount/);
});
test('ABI encoding binds native value, static deposit path and mutual-close destination', () => {
  const data = depositData(H(43), 300000, Array(32).fill(H(0))); assert.equal(data.length, 10 + 34 * 64); assert.ok(data.startsWith('0xc588341c'));
  assert.throws(() => depositData(H(43), 300000, []));
  assert.throws(() => closeData({ mode: 'mutual', public_inputs: { chain_id: CHAIN, has_clearance: true, destination: Array(20).fill(0) } }, destination), /destination mismatch/);
});
test('real compiled WASM generates secrets, confirms genesis and rejects malformed private state', async () => {
  const wasm = await import('../public/zkapi/zkapi_browser.js');
  await wasm.default({ module_or_path: fs.readFileSync(new URL('../public/zkapi/zkapi_browser_bg.wasm', import.meta.url)) });
  assert.equal(wasm.browser_circuit_id(), CIRCUIT);
  const params = JSON.parse(wasm.browser_generate_deposit()); assert.ok(params.secret !== H(0));
  const s = JSON.parse(wasm.browser_confirm_deposit(JSON.stringify(walletConfig(manifest())), JSON.stringify({ secret: params.secret, note_id: 0, amount: 300000, expiry_ts: state().expiry_ts })));
  assert.equal(s.current_balance, 300000); assert.equal(s.is_genesis, true);
  assert.throws(() => wasm.browser_confirm_deposit(JSON.stringify(walletConfig(manifest())), JSON.stringify({ secret: H(0), note_id: 0, amount: 0, expiry_ts: state().expiry_ts })));
  assert.throws(() => wasm.browser_prepare_withdrawal(JSON.stringify(walletConfig(manifest())), JSON.stringify({ ...s, current_balance: 0 }), JSON.stringify({ mode: 'mutual', destination, active_root: H(10), merkle_siblings: Array(32).fill(H(0)), clearance: null }), new Uint8Array()), /clearance/);
  const config = { ...walletConfig(manifest()), state_signing_key: { x: s.current_commitment_x, y: s.current_commitment_y } };
  const journal = prepared({ request: { client_request_id: id, payload: '{}' } }).journal;
  journal.user_rerandomization = H(0);
  const transition = { state: s, journal, response: { status: 'ok', client_request_id: id, request_nullifier: journal.nullifier, response_code: 200, response_payload: '', response_hash: '0x11b7bbd8579de9dd90894473155efcd43b7f0b797eac82bdf6c54deb18e6ef1c', charge_applied: 0, next_commitment: { x: s.current_commitment_x, y: s.current_commitment_y }, next_anchor: H(2), blind_delta_srv: H(0), next_state_signature: { r_x: H(0), r_y: H(1), s: H(0) } } };
  assert.throws(() => wasm.browser_complete_response(JSON.stringify(config), JSON.stringify(transition)), /invalid next-state signature/);
  assert.throws(() => wasm.browser_tree_path(JSON.stringify({ root: H(1), next_note_id: 0, leaves: [] }), 0, false), /root verification/);
});
test('page stays search-only, uses site tokens and has no bundled proving keys or remote scripts', async () => {
  const { TASKS } = await import('../lib/site-map.js'); assert.equal(TASKS.find(t => t.id === 'zkapi').menu, false);
  const files = fs.readdirSync(new URL('../public/zkapi/', import.meta.url)); assert.ok(!files.some(f => /\.(pk|vk)$/.test(f)));
  const worker = fs.readFileSync(new URL('../public/zkapi/prover-worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes("import init, * as wasm from './zkapi_browser.js'")); assert.ok(worker.includes('artifact.sha256')); assert.ok(!/eval\(|new Blob/.test(worker));
  const css = fs.readFileSync(new URL('../app/zkapi/zkapi.css', import.meta.url), 'utf8'); assert.ok(css.includes('var(--paper)') || css.includes('var(--paper-2)')); assert.ok(css.includes('@media'));
});
