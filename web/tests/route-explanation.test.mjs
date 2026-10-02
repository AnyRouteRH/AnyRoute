import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { test } from 'node:test';
import { routeEvidence, routeSentence, validRouteExplanation } from '../lib/route-explanation.js';
import { canonicalJson, verifyReceipt } from '../lib/verify.js';
import { TASKS, menuTasks } from '../lib/site-map.js';
const route = { v: 1, provider: 'sample-provider', reason: 'lowest_price', eligible: 4, skipped: { health: 2 }, lane: 'public', parameters: ['tools'], network_host: false };
const receipt = { payload: { provider: 'sample-provider', route } };

test('disclosure uses only receipt or header evidence, with receipt priority and cache omission', () => {
  assert.deepEqual(routeEvidence(receipt), route);
  assert.deepEqual(routeEvidence(null, JSON.stringify(route)), route);
  assert.deepEqual(routeEvidence({ v2: { claims: { node: { provider: route.provider }, route } } }), route);
  assert.equal(routeEvidence(null), null);
  assert.equal(routeEvidence({ payload: { provider: 'sample-provider', lane: 'attested' } }), null);
  assert.equal(routeEvidence({ payload: { ...receipt.payload, mode: 'cache' } }, JSON.stringify(route)), null);
  assert.equal(routeEvidence({ payload: { ...receipt.payload, route: { ...route, v: 99 } } }, JSON.stringify(route)), null);
  assert.equal(routeEvidence(null, '{broken'), null);
  assert.equal(routeEvidence(null, ' '.repeat(4097)), null);
  assert.equal(routeEvidence({ payload: { provider: 'another-provider', route } }), null);
});

test('plain words retain weighted-choice, lane, network and fallback limits', () => {
  const sentence = routeSentence(route);
  assert.match(sentence, /Sent to sample-provider/);
  assert.match(sentence, /price order among 4 eligible providers/);
  assert.match(sentence, /Required parameter rules: tools/);
  assert.match(sentence, /2 were skipped for health/);
  const weighted = routeSentence({ ...route, reason: 'weighted_choice' });
  assert.match(weighted, /weighted choice used price, health, quality and hardware checks/);
  assert.doesNotMatch(weighted, /cheapest|healthiest/);
  assert.match(routeSentence({ ...route, lane: 'attested', network_host: true }), /attested lane was required.*network host/);
  assert.match(routeSentence({ ...route, reason: 'fallback', fallback: { timeout: 1, http_5xx: 2 } }), /1 × a timeout; 2 × a provider server error/);
  assert.equal(routeSentence({ ...route, parameters: ['unknown-secret'] }), '');
});

test('strict schema rejects unknown versions, extra fields, unsafe identifiers and inconsistent fallbacks', () => {
  for (const bad of [null, [], {}, { ...route, v: 2 }, { ...route, eligible: -1 }, { ...route, eligible: 1.5 }, { ...route, eligible: 0 }, { ...route, provider: 'https://internal.example' }, { ...route, raw_error: 'secret' }, { ...route, skipped: { secret: 2 } }, { ...route, skipped: { health: 0 } }, { ...route, skipped: { health: '2' } }, { ...route, parameters: ['tools', 'tools'] }, { ...route, parameters: ['secret'] }, { ...route, fallback: { timeout: 1 } }, { ...route, reason: 'fallback' }, { ...route, reason: 'fallback', fallback: {} }]) {
    assert.equal(validRouteExplanation(bad), false);
  }
  assert.equal(validRouteExplanation({ ...route, reason: 'fallback', fallback: { connection: 1 } }), true);
});

test('browser verifier signs the entire additive extension and refuses changed or malformed summaries', async () => {
  const key = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), format: 'der', type: 'pkcs8' });
  const pub = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url');
  const key_id = createHash('sha256').update(pub).digest('hex').slice(0, 16);
  const envelope = payload => ({ payload, sig: sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64'), key_id, alg: 'Ed25519' });
  const options = { publicKeyHex: pub.toString('hex') };
  const signed = envelope(receipt.payload);
  assert.equal((await verifyReceipt(signed, options)).valid, true);
  assert.equal((await verifyReceipt({ ...signed, payload: { ...signed.payload, route: { ...route, eligible: 8 } } }, options)).valid, false);
  assert.equal((await verifyReceipt(envelope({ ...receipt.payload, route: { ...route, v: 99 } }), options)).valid, false);
});

test('docs and OpenAPI describe the versioned claim, streaming delivery and where it is switched on', () => {
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  assert.equal(spec.components.schemas.RouteExplanation.additionalProperties, false);
  assert.equal(spec.components.schemas.RouteExplanation.properties.v.const, 1);
  assert.equal(spec.components.schemas.Receipt.properties.payload.properties.route.$ref, '#/components/schemas/RouteExplanation');
  assert.equal(spec.components.schemas.ReceiptClaimsV2.properties.route.$ref, '#/components/schemas/RouteExplanation');
  assert.equal(spec.paths['/api/v1/chat/completions'].post.responses['200'].headers['X-Anyroute-Route'].$ref, '#/components/headers/RouteExplanation');
  const docs = readFileSync(new URL('../components/RouteExplanationDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /switched on at anyroute\.tech/);
  assert.match(docs, /defaults to <code>false/);
  assert.match(docs, /Streams carry it in the header and the final receipt/);
  assert.match(docs, /not an independent replay/);
  assert.match(docs, /Ordinary request text remains readable/);
  const task = TASKS.find(t => t.id === 'why-this-route');
  assert.equal(task.href, '/docs/#why-this-route');
  assert.equal(task.menu, false);
  assert.ok(!menuTasks('learn').some(t => t.id === task.id));
});
