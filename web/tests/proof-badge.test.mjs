import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROOF_STATES, proofBadges, proofHref } from '../lib/proof-badge.js';
const now = Date.parse('2026-10-01T00:00:00Z');
const first = (source, data, options = {}) => proofBadges({ source, data, ...options }, now)[0]?.key;
const receipt = changes => ({ id: 'gen-example', sig: 'signature', payload: { provider: 'sample-provider', disclosure: 'attested', ...changes } });

test('all combinations of call evidence choose one honest path, with signatures independent', () => {
  for (const hardware of [false, true]) for (const encrypted of [false, true]) for (const unlinkable of [false, true]) for (const cached of [false, true]) for (const signed of [false, true]) {
    const data = receipt({ disclosure: hardware ? 'attested' : 'policy', mode: cached ? 'cache' : unlinkable ? 'blind' : 'prepaid', lane: unlinkable ? 'unlinkable' : 'attested', nullifier: unlinkable ? 'spent-token' : undefined, provider: encrypted ? 'phala-confidential-ai' : 'sample-provider', end_to_end_encrypted: encrypted, e2ee: encrypted ? { version: 2, suite: 'x25519-aes-256-gcm-hkdf-sha256', gateway_attested: true } : undefined });
    if (!signed) delete data.sig;
    const marks = proofBadges({ source: 'receipt', data }, now);
    assert.equal(marks[0].key, cached ? 'cached' : hardware && encrypted ? 'encrypted' : unlinkable ? 'unlinkable' : hardware ? 'hardware' : 'standard');
    assert.equal(marks.some(mark => mark.key === 'signed'), signed);
  }
});

test('receipts never infer hardware or encryption from a lane, private flag or provider name', () => {
  for (const lane of ['public', 'attested', 'unlinkable']) assert.equal(first('receipt', receipt({ lane, private: true, disclosure: undefined })), 'standard');
  for (const field of ['attestation_simulated', 'stale', 'failed']) assert.equal(first('receipt', receipt({ [field]: true })), 'standard');
  for (const upstream_attestation of [{}, { attested: false }, { attested: true, failed: true }, { attested: true, stale: true }]) assert.equal(first('receipt', receipt({ upstream_attestation })), 'standard');
  assert.equal(first('receipt', receipt({ upstream_attestation: { attested: true } })), 'hardware');
  for (const e2ee of [undefined, {}, { version: 2, gateway_attested: true }, { version: 1, suite: 'x25519-aes-256-gcm-hkdf-sha256', gateway_attested: true }]) assert.equal(first('receipt', receipt({ provider: 'phala-confidential-ai', end_to_end_encrypted: true, e2ee })), 'hardware');
  for (const changes of [{ mode: 'prepaid' }, { mode: 'blind' }, { mode: 'blind', nullifier: 'spent-token', payer: 'account-id' }, { mode: 'blind', nullifier: 'spent-token', payment_tx: 'payment-reference' }]) assert.equal(first('receipt', receipt({ lane: 'unlinkable', ...changes })), 'hardware');
  assert.equal(first('receipt', receipt({ lane: 'unlinkable', mode: 'blind', nullifiers: ['spent-token'] })), 'unlinkable');
});

test('every surface maps its own authoritative evidence; stale, failed and expired checks fall back', () => {
  const states = [undefined, 'attested', 'unverified', 'failed', 'stale', 'simulated', 'revoked'];
  for (const attested of [false, true]) for (const status of states) for (const stale of [false, true]) for (const failed of [false, true]) {
    assert.equal(first('host', { id: 'sample-host', attested, attestation: { status, stale, failed } }), attested && status === 'attested' && !stale && !failed ? 'hardware' : 'standard');
    assert.equal(first('attestation', { status, stale, failed }), status === 'attested' && !stale && !failed ? 'hardware' : 'standard');
  }
  for (const source of ['host', 'attestation', 'admission', 'model']) for (const expires_at of ['invalid', new Date(now).toISOString(), new Date(now - 1).toISOString()]) {
    const data = source === 'host' ? { attested: true, attestation: { status: 'attested', expires_at } } : { status: 'attested', attested: true, capabilities: ['attested'], expires_at };
    assert.equal(first(source, data), 'standard');
  }
  for (const source of ['model', 'admission']) for (const field of ['stale', 'failed']) assert.equal(first(source, { attested: true, capabilities: ['attested'], [field]: true }), 'standard');
  assert.equal(first('model', { capabilities: ['attested'], attested_available: false }), 'standard');
  assert.equal(first('model', { capabilities: ['attested'] }), 'hardware');
  assert.equal(first('model', { capabilities: ['encrypted'] }), 'standard');
  assert.match(proofBadges({ source: 'model', data: { capabilities: ['attested'] } })[0].context, /Available endpoint.*another provider/);
  const sealed = { attested: true, agent_image_digest: 'sha256:' + 'a'.repeat(64), expires_at: new Date(now + 1).toISOString() };
  assert.equal(first('sealed', sealed), 'hardware');
  for (const changes of [{ attested: false }, { expires_at: new Date(now).toISOString() }, { agent_image_digest: 'latest' }, { failed: true }, { stale: true }]) assert.equal(first('sealed', { ...sealed, ...changes }), 'standard');
  assert.equal(first('profile', { status: { attested: true, sealed: true } }), 'standard');
  assert.equal(first('generation', { live: true, private: true, signature: 'key-id' }), 'standard');
  assert.equal(proofBadges({ source: 'generation', data: { live: true, signature: 'key-id', id: 'gen-example' } }).at(-1).key, 'signed');
  assert.equal(proofBadges({ source: 'generation', data: { signature: 'key-id' } }).length, 1);
  assert.equal(first('ledger', { receipt_id: 'gen-example' }, { signedOnly: true }), 'signed');
  assert.equal(first('ledger', {}, { signedOnly: true }), undefined);
  assert.equal(first('network', { attested_hosts: 1, as_of: new Date(now - 1).toISOString() }), 'hardware');
  for (const data of [{ attested_hosts: 0, as_of: new Date(now).toISOString() }, { attested_hosts: 1, as_of: new Date(now - 30_000).toISOString() }, { attested_hosts: 1, as_of: new Date(now + 1).toISOString() }, { attested_hosts: 1 }, { attested_hosts: 1, as_of: new Date(now).toISOString(), failed: true }]) assert.equal(first('network', data), 'standard');
  for (const source of ['model', 'host', 'receipt', 'profile', 'sealed', 'generation', 'ledger', 'admission', 'attestation', 'network']) assert.equal(first(source, null), 'standard');
});

test('fixed copy distinguishes hardware, ciphertext, transport and signatures', () => {
  assert.deepEqual(Object.values(PROOF_STATES).map(state => state.label), ['Proven hardware', 'Encrypted end to end', 'Unlinkable route', 'Standard provider', 'Stored answer', 'Signed receipt']);
  const copy = JSON.stringify(PROOF_STATES);
  assert.doesNotMatch(copy, /\b(demo|test|mock|simulated|placeholder)\b|local.build|trustless|zero.knowledge|anonymous/i);
  assert.match(PROOF_STATES.hardware.explanation, /does not hide ordinary prompts/);
  assert.match(PROOF_STATES.encrypted.explanation, /ciphertext.*routing and billing details remain visible/);
  assert.match(PROOF_STATES.unlinkable.explanation, /router still reads ordinary prompts/);
  assert.match(PROOF_STATES.signed.explanation, /use the checker to verify/);
});

test('badge links prefill only supported ids and every state has its own explanation and tool', () => {
  assert.equal(proofHref('hardware', { providerId: 'sample-host', receiptId: 'gen-example' }), '/verify/?p=sample-host&r=gen-example#proof-hardware');
  assert.equal(proofHref('signed', { providerId: 'https://invalid', receiptId: '<script>' }), '/verify/#proof-signed');
  const guide = readFileSync(new URL('../components/ProofGuide.jsx', import.meta.url), 'utf8');
  for (const state of Object.keys(PROOF_STATES)) assert.match(guide, new RegExp(`${state}: \\[`));
  assert.match(guide, /id=\{`proof-\$\{key\}`\}/);
  assert.match(guide, /#v-receipt/);
  assert.match(guide, /\/docs\/#e2ee-phala/);
  assert.match(guide, /\/docs\/#private/);
  assert.match(guide, /receipt checker below checks receipts, not track-record certificates/);
});

test('all listed surfaces use the shared component directly or through their shared renderer', () => {
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  for (const path of ['components/Harness.jsx', 'components/harness/PrivateMode.jsx', 'components/ModelCapabilities.jsx', 'app/hosts/Hosts.jsx', 'app/hosts/YourHost.jsx', 'app/network/NetworkStats.jsx', 'app/agents/SealedAgent.jsx', 'app/agents/profile/ProfileCard.jsx', 'app/agents/Activity.jsx', 'components/Dashboard.jsx', 'components/account/ActivityReceipt.jsx', 'components/Verify.jsx']) assert.match(read(path), /import ProofBadge from/);
  for (const [path, component] of [['app/models/page.jsx', 'ModelCatalog'], ['components/ModelCatalog.jsx', 'ModelCapabilities'], ['app/agents/Agents.jsx', 'SealedAgent'], ['app/agents/directory/Directory.jsx', 'ProfileCard'], ['app/agents/profile/Profile.jsx', 'ProfileCard'], ['app/network/NetworkContent.jsx', 'NetworkStats']]) assert.ok(read(path).includes('from') && read(path).includes(component), path);
  const harness = read('components/Harness.jsx');
  assert.doesNotMatch(harness, /title="Attested route available"|DISCLOSURE_LABEL\[/);
  assert.match(harness, /<\/button>\s*<CapTags/);
  assert.match(read('components/harness/PrivateMode.jsx'), /const proven = proofBadges/);
  assert.match(read('app/verify/page.jsx'), /<ProofGuide \/>/);
  assert.match(read('app/agents/Agents.jsx'), /<\/button><SealedBadge/);
});
