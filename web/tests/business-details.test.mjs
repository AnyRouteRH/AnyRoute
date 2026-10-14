import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { billedToLines, statementCsv, emptyBusinessDetails, BUSINESS_FIELDS } from '../lib/business-details.js';
import { canonicalJson } from '../lib/verify.js';
import { verifyStatement, parseStatement } from '../lib/statements.js';
import { TASKS } from '../lib/site-map.js';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const details = { business_name: 'Example Studio', address: '12 Sample Road\nSuite 3', tax_id: 'VAT sample-42', reference: 'Purchase order 42' };
const payload = { type:'anyroute.statement.v1',month:'2026-05',currency:'USDG',scope:'account',from:'2026-05-01T00:00:00.000Z',to_exclusive:'2026-06-01T00:00:00.000Z',opening_balance:'10',deposits:'1',refunds:'0',usage:'0.000000000007',fees:'0',other_changes:'0',closing_balance:'10.999999999993',calls:'1',usage_by_model:[{id:'sample-model',amount:'0.000000000007'}],usage_by_key_agent:[{id:'sample-key',amount:'0.000000000007'}],usage_by_lane:[{id:'public',amount:'0.000000000007'}],movements_by_kind:[{id:'deposit',amount:'1'},{id:'usage',amount:'-0.000000000007'}],limits:['Settled ledger totals, excluding open holds.'] };
function components(file, names, bindings = {}) {
  const transformed = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement"}}}).transformSync(await Bun.stdin.text()));'], { input: read(file), encoding: 'utf8' });
  const scope = { React, useState: React.useState, useEffect: React.useEffect, billedToLines, BUSINESS_FIELDS, emptyBusinessDetails, s: { billed:'billed', controls:'controls', form:'form' }, Button: ({secondary,...props}) => React.createElement('button', props), ...bindings };
  return new Function(...Object.keys(scope), transformed.replace(/^import .*;\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '') + '\nreturn {' + names.join(',') + '};')(...Object.values(scope));
}
const { BilledTo } = components('components/business-details/StatementBusinessDetails.jsx', ['BilledTo']);
test('Billed to renders outside signed content, preserves address lines, escapes user text, and omits absent details', () => {
  const html = renderToStaticMarkup(React.createElement(BilledTo, {details}));
  for (const value of Object.values(details)) assert.ok(html.includes(value));
  assert.match(html, /Billed to/); assert.match(html, /User-entered · outside the signed statement/); assert.match(html, /has not verified/);
  for (const value of [null,emptyBusinessDetails()]) assert.equal(renderToStaticMarkup(React.createElement(BilledTo,{details:value})), '');
  const unsafe = renderToStaticMarkup(React.createElement(BilledTo,{details:{...details,business_name:'<script>unsafe</script>'}}));
  assert.ok(unsafe.includes('&lt;script&gt;unsafe&lt;/script&gt;')); assert.ok(!unsafe.includes('<script>'));
  const css=read('components/business-details/BusinessDetails.module.css');
  assert.match(css,/white-space:pre-wrap/); assert.match(css,/overflow-wrap:anywhere/); assert.match(css,/@media print\{\.controls\{display:none!important/);
  assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  const statement=read('components/account/AccountStatements.jsx');
  assert.ok(statement.indexOf('<StatementBusinessDetails ') < statement.indexOf('<h3>Signed statement</h3>'));
});
test('CSV uses optional unsigned identity, quotes multiline and comma fields, preserves exact decimal strings and prevents formulas', () => {
  const original = {payload}; const before=JSON.stringify(original);
  for (const d of [undefined,null,emptyBusinessDetails()]) assert.ok(!statementCsv(original,d).includes('Billed to'));
  const csv=statementCsv(original,details);
  assert.ok(csv.indexOf('Billed to') < csv.indexOf('Statement amounts')); assert.ok(csv.includes('"12 Sample Road\nSuite 3"'));
  assert.ok(csv.includes('0.000000000007')); assert.ok(csv.includes('Download the signed statement separately')); assert.ok(csv.endsWith('\r\n'));
  for (const value of ['=SUM(1,2)','+1','-1','@SUM(A1)','  =A1']) assert.ok(statementCsv(original,{business_name:value}).includes('"\''+value+'"'));
  assert.ok(statementCsv(original,{reference:'PO "42", next'}).includes('"PO ""42"", next"'));
  assert.equal(JSON.stringify(original),before);
});
test('changing or deleting unsigned business identity cannot change receipt verification or the payload signature', async () => {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'); const x=publicKey.export({format:'jwk'}).x;
  const kid=createHash('sha256').update(Buffer.from(x,'base64url')).digest('hex').slice(0,16);
  const signed={payload,alg:'Ed25519',key_id:kid,sig:sign(null,Buffer.from(canonicalJson(payload)),privateKey).toString('base64')};
  const options={keys:{keys:[{kty:'OKP',crv:'Ed25519',x,kid}]}};
  for (const d of [details,{business_name:'Changed Studio'},null]) {
    const envelope={...signed,business_details:d};
    assert.equal((await verifyStatement(envelope,options)).valid,true);
    assert.equal(envelope.sig,signed.sig); assert.equal(canonicalJson(envelope.payload),canonicalJson(payload));
    assert.deepEqual(parseStatement(JSON.stringify(envelope)),envelope);
  }
  assert.equal((await verifyStatement({...signed,payload:{...payload,closing_balance:'0'}},options)).valid,false);
});
test('settings have labelled optional fields, length limits, native disabled authority and a Delete action', () => {
  const {BusinessDetailsSettings}=components('components/business-details/BusinessDetailsSettings.jsx',['BusinessDetailsSettings']);
  const html=renderToStaticMarkup(React.createElement(BusinessDetailsSettings,{apiKey:'sample-key'}));
  for (const [field,,max] of BUSINESS_FIELDS) {
    assert.ok(html.includes('for="business-'+field+'"')); assert.ok(html.includes('id="business-'+field+'"')); assert.ok(html.includes('maxLength="'+max+'"'));
  }
  assert.ok(html.includes('<textarea')); assert.match(html,/<fieldset disabled=""/); assert.match(html,/Delete business details/);
  assert.match(html,/Only an account management key can edit/); assert.match(html,/Leave out email addresses/); assert.ok(!html.includes('type="email"'));
  assert.match(read('components/Dashboard.jsx'),/<BusinessDetailsSettings key=\{apiKey\}/);
});
test('docs, search, schemas and opt-in statement field explain the existing scope boundary', () => {
  const {BusinessDetailsDocs}=components('components/business-details/BusinessDetailsDocs.jsx',['BusinessDetailsDocs']);
  const html=renderToStaticMarkup(React.createElement(BusinessDetailsDocs));
  assert.match(html,/id="business-details"/); assert.match(html,/outside the signed section/); assert.match(html,/default false/); assert.match(html,/Read-only keys remain blocked/);
  assert.ok(TASKS.some(t=>t.id==='business-details' && t.href==='/docs/#business-details'));
  assert.match(read('components/DocsFeatureIndex.jsx'),/\["business-details", "Business details on statements"\]/);
  const spec=JSON.parse(read('public/openapi.json'));
  assert.ok(spec.paths['/api/v1/account/business-details'].get); assert.ok(spec.paths['/api/v1/account/business-details'].put);
  assert.equal(spec.components.schemas.BusinessDetails.properties.address.maxLength,1000);
  assert.ok(spec.paths['/api/v1/statements/{yyyy-mm}'].get.parameters.some(p=>p.name==='business_details'));
});
