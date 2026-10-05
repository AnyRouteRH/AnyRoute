import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultProofPackRange, PROOF_PACK_LIMITS_PATH, proofPackFilename, proofPackPath, proofPackRangeError, proofPackSummary } from '../lib/proof-pack.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const now = new Date('2026-10-04T12:00:00Z');

test('proof pack paths carry UTC dates and an optional cursor', () => {
  const url = new URL(proofPackPath({ from: '2026-09-05', to: '2026-10-04' }), 'https://router.example');
  assert.equal(url.pathname, '/api/v1/proof-pack');
  assert.deepEqual(Object.fromEntries(url.searchParams), { from: '2026-09-05', to: '2026-10-04' });
  assert.equal(new URL(proofPackPath({ from: '2026-09-05', to: '2026-10-04', cursor: 'next-part' }), 'https://router.example').searchParams.get('cursor'), 'next-part');
  assert.equal(PROOF_PACK_LIMITS_PATH, '/api/v1/proof-pack/limits');
  assert.deepEqual(defaultProofPackRange(now), { from: '2026-09-05', to: '2026-10-04' });
  assert.equal(proofPackRangeError(defaultProofPackRange(now), 31, now), '');
});

test('ranges are checked before a request: real dates, order, not in the future, at most the cap', () => {
  assert.match(proofPackRangeError({ from: '', to: '2026-10-01' }, 31, now), /start and an end/);
  assert.match(proofPackRangeError({ from: '2026-02-30', to: '2026-03-01' }, 31, now), /start and an end/);
  assert.match(proofPackRangeError({ from: '2026-10-02', to: '2026-10-01' }, 31, now), /on or after/);
  assert.match(proofPackRangeError({ from: '2026-10-05', to: '2026-10-06' }, 31, now), /future/);
  assert.equal(proofPackRangeError({ from: '2026-09-01', to: '2026-10-01' }, 31, now), '');
  assert.equal(proofPackRangeError({ from: '2026-09-01', to: '2026-10-02' }, 31, now), 'A proof pack covers at most 31 days. This range has 32.');
});

test('a response is checked before it is saved, and parts are named', () => {
  const pack = { type: 'anyroute.proof-pack.v1', range: { from: '2026-09-01', to: '2026-09-30' }, part: 1, scope: 'key', calls: [{ id: 'one' }], refunds: [], statements: [{}], counts: { merkle_paths: 2 }, keys: { keys: [{ kid: 'k' }] }, manifest: { sig: 'signature' }, next_cursor: 'more' };
  assert.deepEqual(proofPackSummary({ data: pack }), { pack, part: 1, calls: 1, refunds: 0, statements: 1, paths: 2, decisionTags: 0, scope: 'key', next: 'more' });
  // B: a pack lists the decision tags its receipts carry; the summary counts them.
  assert.equal(proofPackSummary({ data: { ...pack, decision_tags: [{ id: 'one', decision_tag: 'sha256:' + 'ab'.repeat(32) }] } }).decisionTags, 1);
  assert.equal(proofPackFilename(pack), 'anyroute-proof-pack-2026-09-01-to-2026-09-30.json');
  assert.equal(proofPackFilename({ ...pack, part: 3 }), 'anyroute-proof-pack-2026-09-01-to-2026-09-30-part-3.json');
  for (const bad of [null, {}, { data: { ...pack, type: 'anyroute.statement.v1' } }, { data: { ...pack, manifest: {} } }]) assert.throws(() => proofPackSummary(bad), /could not be read/);
});

test('the dashboard shows the control on Statements only, and only after the router confirms this key can read it', () => {
  const dashboard = read('components/Dashboard.jsx');
  assert.match(dashboard, /import AccountProofPack from "\.\/account\/AccountProofPack";/);
  assert.match(dashboard, /\{tab === "Statements" && apiKey && <AccountProofPack [^>]*apiKey=\{apiKey\}\/>\}/);
  const control = read('components/account/AccountProofPack.jsx');
  assert.match(control, /PROOF_PACK_LIMITS_PATH/);
  assert.match(control, /if \(!limits\) return null;/);
  assert.match(control, /Download proof pack/);
  assert.match(control, /Download the next part/);
});

test('copy stays plain and the docs section has its anchor', () => {
  const docs = read('components/ProofPackDocs.jsx');
  assert.match(docs, /<section id="proof-pack">/);
  assert.match(docs, /STATEMENTS_ENABLED/);
  assert.match(docs, /verify-proof-pack\.mjs/);
  const visible = ['components/ProofPackDocs.jsx', 'components/account/AccountProofPack.jsx'].map(read).flatMap(src => [...src.matchAll(/>([^<>]+)</g)].map(m => m[1])).join(' ');
  assert.match(visible, /anyone can check with no network/);
  assert.doesNotMatch(visible, /\b(?:demo|test|tested|mock|simulated|placeholder|fixture|local|anonymous|trustless|decentrali[sz]ed|earn|yield|APY|returns)\b|no logs|can.t read your prompt/i);
});
