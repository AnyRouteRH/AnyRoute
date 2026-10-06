import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyProofPack as offline, canonicalJson, keccak256, laneReportProblems } from '../../scripts/verify-proof-pack.mjs';
import { verifyProofPack, proofPackResultLines, proofPackFailureText } from '../lib/proof-pack-verify.js';

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('hex').slice(0, 16);
  const keys = { keys: [{ ...jwk, kid }] };
  const signed = payload => ({ payload, key_id: kid, sig: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64') });
  const leaf = bytes => '0x' + keccak256(keccak256(bytes)).toString('hex');
  const cbor = value => {
    const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
    if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
    if (typeof value === 'number') return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
    if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
    const entries = value instanceof Map ? [...value] : Object.entries(value);
    return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  };
  const tag = 'sha256:' + 'ab'.repeat(32);
  const calls = ['public', 'attested'].map((lane, i) => {
    const id = `call-${i}`, provider = 'sample-provider', model = 'sample-model';
    const receipt = { id, ...signed({ id, lane, provider, model, decision_tag: tag }) };
    receipt.leaf = leaf(Buffer.concat([Buffer.from(canonicalJson(receipt.payload)), Buffer.from(receipt.sig, 'base64')]));
    receipt.anchor = { root: receipt.leaf, proof: [] };
    const claims = { rid: id, lane, node: { provider }, model: { id: model }, decision_tag: tag };
    const protectedHeader = cbor(new Map([[1, -8], [4, Buffer.from(kid, 'hex')]]));
    const payload = cbor(claims);
    const signature = sign(null, cbor(['Signature1', protectedHeader, Buffer.alloc(0), payload]), privateKey);
    const bytes = cbor([protectedHeader, new Map(), payload, signature]);
    receipt.v2 = { cose: bytes.toString('base64'), claims, leaf: leaf(bytes), anchor: { root: leaf(bytes), proof: [] } };
    return { id, lane, provider, model, cost: '1', receipt };
  });
  const lane_report = {
    totals: { calls: 2, spend: '2' },
    lanes: ['public', 'attested', 'unlinkable'].map(lane => ({ lane, calls: lane === 'unlinkable' ? 0 : 1, spend: lane === 'unlinkable' ? '0' : '1', share_of_calls: lane === 'unlinkable' ? 0 : 0.5, share_of_spend: lane === 'unlinkable' ? 0 : 0.5, proven: lane !== 'public' })),
    proven: { lanes: ['attested', 'unlinkable'], calls: 1, spend: '1', share_of_calls: 0.5, share_of_spend: 0.5 },
    providers: [{ lane: 'attested', provider: 'sample-provider', model: 'sample-model', calls: 1, spend: '1', evidence_url: '/verify/?p=sample-provider', attestation_url: '/api/v1/attestation/sample-provider' }],
  };
  assert.deepEqual(laneReportProblems(lane_report, calls), []);
  const statement = signed({ type: 'anyroute.statement.v1', month: '2026-09', opening_balance: '5', deposits: '0', refunds: '1', usage: '2', fees: '0', other_changes: '0', closing_balance: '4', usage_by_model: [{ amount: '2' }], usage_by_key_agent: [{ amount: '2' }], usage_by_lane: [{ amount: '2' }], movements_by_kind: [{ amount: '-2' }, { amount: '1' }] });
  const refund = { id: 'refund-one', ...signed({ kind: 'refund', id: 'refund-one' }) };
  refund.leaf = leaf(Buffer.concat([Buffer.from(canonicalJson(refund.payload)), Buffer.from(refund.sig, 'base64')]));
  refund.anchor = { root: refund.leaf, proof: [] };
  const pack = { type: 'anyroute.proof-pack.v1', range: { from: '2026-09-01', to: '2026-09-30' }, scope: 'account', key_hash: null, part: 1, truncated: false, next_cursor: null, generated_at: '2026-10-01T00:00:00Z', router: 'https://router.example', calls, refunds: [refund], statements: [statement], keys, lane_report, decision_tags: calls.map(c => ({ id: c.id, decision_tag: tag })) };
  function seal(p) {
    p.manifest = signed({ type: 'anyroute.proof-pack.manifest.v1', range: p.range, scope: p.scope, key_hash: p.key_hash, part: p.part, truncated: p.truncated, next_cursor: p.next_cursor, generated_at: p.generated_at, router: p.router, calls: p.calls.map(c => ({ id: c.id, leaf: c.receipt?.leaf ?? null, leaf_v2: c.receipt?.v2?.leaf ?? null })), refunds: p.refunds.map(r => ({ id: r.id, leaf: r.leaf ?? null })), statements: p.statements.map(s => ({ month: s.payload.month, key_id: s.key_id, sig: s.sig })), key_ids: p.keys.keys.map(k => k.kid), lane_report: p.lane_report, decision_tags: p.decision_tags });
  }
  seal(pack);
  return { pack, keys, signed, seal };
}

test('browser and independent script agree on every summary count, using a fresh test signer', async () => {
  const { pack, keys } = fixture();
  const script = offline(pack), browser = await verifyProofPack({ data: pack }, { keys });
  assert.equal(script.ok, true, script.failures.join('\n'));
  assert.equal(browser.ok, true, browser.failures.join('\n'));
  assert.equal(browser.signedByAnyroute, true);
  assert.deepEqual(browser.summary, script.summary);
  assert.deepEqual(browser.failures, script.failures);
  assert.deepEqual(proofPackResultLines(browser), ['2 calls · 2 receipts checked ✓', '1 statements ✓', '1 of 1 refund receipts checked.', 'Lane report: 50% on proven hardware']);
});

test('script and browser reject altered signatures, paths, keys, statements, tags, lanes and manifest', async () => {
  const { pack, keys, signed, seal } = fixture();
  const cases = [
    p => { p.calls[0].receipt.payload.model = 'changed'; },
    p => { p.calls[0].receipt.v2.cose = 'not-a-receipt'; },
    p => { p.calls[0].receipt.v2.claims.model.id = 'changed'; },
    p => { p.calls[0].receipt.anchor.root = '0x' + 'aa'.repeat(32); },
    p => { p.calls[0].receipt.v2.leaf = '0x' + 'aa'.repeat(32); },
    p => { p.calls[0].provider = 'changed'; },
    p => { p.keys.keys[0].kid = 'bad-id'; },
    p => { p.refunds[0].payload.kind = 'changed'; },
    p => { p.statements[0].payload.usage = '999'; },
    p => { p.statements[0] = signed({ ...p.statements[0].payload, closing_balance: '99' }); seal(p); },
    p => { p.lane_report.proven.calls = 0; seal(p); },
    p => { p.decision_tags = []; seal(p); },
    p => { p.calls.pop(); },
    p => { p.calls.push(p.calls[0]); },
    p => { p.manifest.sig = 'AA=='; },
  ];
  for (const mutate of cases) {
    const p = structuredClone(pack); mutate(p);
    const script = offline(p), browser = await verifyProofPack(p, { keys });
    assert.equal(script.ok, false); assert.equal(browser.ok, false);
    assert.deepEqual(browser.summary, script.summary);
    assert.deepEqual(browser.failures, script.failures);
  }
});

test('a pack self-signed by an unpublished key cannot claim Anyroute identity', async () => {
  const { pack } = fixture();
  const { keys } = fixture();
  const result = await verifyProofPack(pack, { keys });
  assert.equal(result.ok, false);
  assert.equal(result.signedByAnyroute, false);
  assert.match(result.failures.join('\n'), /not in Anyroute’s published/);
  assert.equal((await verifyProofPack(pack)).signedByAnyroute, false);
});

test('older and empty packs, missing receipts and multi-part files are counted honestly', async () => {
  const { pack, keys, seal } = fixture();
  delete pack.lane_report; delete pack.decision_tags;
  pack.calls[0].receipt = null;
  pack.calls[1].receipt.v2 = null;
  pack.truncated = true; pack.next_cursor = 'next-part'; seal(pack);
  const result = await verifyProofPack(pack, { keys });
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.deepEqual(result.summary, offline(pack).summary);
  assert.ok(proofPackResultLines(result).includes('1 calls have no signed receipt to check.'));
  pack.calls = []; pack.refunds = []; pack.statements = []; seal(pack);
  assert.equal((await verifyProofPack(pack, { keys })).ok, true);
  assert.equal((await verifyProofPack({})).ok, false);
});

test('long packs yield between items and report progress', async () => {
  const { pack, keys, seal } = fixture();
  pack.calls = Array.from({ length: 100 }, (_, i) => ({ id: `unsigned-${i}`, cost: '0' }));
  delete pack.lane_report; pack.decision_tags = []; seal(pack);
  let yielded = 0; const progress = [];
  const result = await verifyProofPack(pack, { keys, yieldUI: async () => { yielded++; }, onProgress: n => progress.push(n) });
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(yielded, 5); assert.deepEqual(progress, [20, 40, 60, 80, 100]);
});

test('Verify integrates an accessible file picker; only public keys are requested and parsing uses a worker', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const ui = read('components/ProofPackVerify.jsx'), worker = read('lib/proof-pack-worker.js');
  assert.match(read('components/Verify.jsx'), /<ProofPackVerify\/>/);
  assert.match(ui, /htmlFor="proof-pack-file"/); assert.match(ui, /onDrop=/);
  assert.match(ui, /new FileReader\(/); assert.match(ui, /new Worker\(/);
  assert.match(worker, /JSON.parse\(data.text\)/);
  assert.equal([...ui.matchAll(/fetch\(/g)].length, 1);
  assert.match(ui, /fetch\(API_BASE \+ KEYS_PATH, \{ method: 'GET', credentials: 'omit'/);
  assert.doesNotMatch(ui, /FormData|localStorage|sessionStorage|Authorization|JSON\.parse/);
  assert.match(ui, /never uploaded/); assert.match(ui, /remaining parts separately/);
  assert.match(read('components/ProofPackDocs.jsx'), /verify\/#v-proof-pack/);
  assert.match(read('components/DocsFeatureIndex.jsx'), /\["proof-pack", "Proof pack"\]/);
  assert.match(read('lib/site-map.js'), /'proof-pack-check'/);
});


test('failures identify the item using plain words rather than file-format field names', () => {
  assert.equal(proofPackFailureText('call call-1: v1 needs payload, sig and key_id'), 'call call-1: first receipt the signed contents, signature or signing key is missing');
  assert.equal(proofPackFailureText('manifest: the signed manifest does not match this file (key_ids, lane_report)'), 'pack contents list: the signed pack contents list does not match this file (signing keys, lane report)');
  assert.equal(proofPackFailureText('not an Anyroute proof pack (type unknown)'), 'This file is not an Anyroute proof pack.');
});

test('worker checks files without a network request and reports unreadable files and remaining parts', async () => {
  const messages = [];
  const original = globalThis.self;
  globalThis.self = { postMessage: message => messages.push(message) };
  try {
    await import('../lib/proof-pack-worker.js');
    const { pack, keys, seal } = fixture();
    pack.truncated = true; pack.next_cursor = 'next-part';
    pack.statements_unavailable = [{ month: '2026-08', reason: 'No account existed in this month.' }];
    seal(pack);
    await globalThis.self.onmessage({ data: { text: JSON.stringify({ data: pack }), keys } });
    assert.equal(messages.at(-1).result.ok, true);
    assert.equal(messages.at(-1).result.signedByAnyroute, true);
    assert.equal(messages.at(-1).moreParts, true);
    assert.equal(messages.at(-1).unavailableStatements, 1);
    await globalThis.self.onmessage({ data: { text: '{broken', keys } });
    assert.match(messages.at(-1).error, /could not be read/);
    await globalThis.self.onmessage({ data: { text: JSON.stringify({ ...pack, calls: {} }), keys } });
    assert.match(messages.at(-1).error, /part of this proof pack could not be read/);
  } finally {
    if (original === undefined) delete globalThis.self; else globalThis.self = original;
  }
});
