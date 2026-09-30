import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const api = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
test('certificate REST contract includes authenticated issuance and both public verification methods', () => {
  const issue = api.paths['/api/v1/agents/me/record-certificate'].post;
  assert.equal(issue.security[0].BearerAuth.length, 0);
  assert.ok(issue.responses['422']); assert.ok(issue.responses['429']); assert.ok(issue.responses['503']);
  assert.equal(issue.requestBody.content['application/json'].schema.additionalProperties, false);
  const verify = api.paths['/api/v1/agents/certificates/verify'];
  for (const method of ['get', 'post']) assert.deepEqual(verify[method].security, []);
  assert.equal(verify.get.parameters[0].name, 'certificate');
  const schema = api.components.schemas.AgentRecordCertificate;
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.payload.properties.notice.const.includes('not a zero-knowledge proof'));
  assert.deepEqual(schema.properties.payload.required.sort(), ['claims','expires_at','issued_at','notice','pseudonym','type','version']);
});
test('docs include offline verification, retained-history limits and correlation limits', () => {
  const docs = readFileSync(new URL('../components/AgentCertificateDocs.jsx', import.meta.url), 'utf8');
  for (const phrase of ['verifyRecordCertificate', 'trustedKeys', 'TLOG_ENABLED', 'not a zero-knowledge proof', 'may correlate', 'not anonymity from the router', 'on-chain enforcement', '90 days']) assert.ok(docs.includes(phrase), phrase);
  const page = readFileSync(new URL('../app/docs/page.jsx', import.meta.url), 'utf8');
  assert.ok(page.includes('<AgentCertificateDocs />'));
});
