import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');
const KINDS=['receipt_key','ohttp_key_config','blind_issuer_key','measurement_bundle','attestation_binding','data_inventory','host_policy'];

test('the transparency log endpoints are documented, public and in their own tag',()=>{
 const ops={
  checkpoint:spec.paths['/tlog/checkpoint'].get,
  tile:spec.paths['/tlog/tile/{level}/{index}'].get,
  entries:spec.paths['/tlog/tile/entries/{index}'].get,
  info:spec.paths['/api/v1/tlog'].get,
  witnessed:spec.paths['/api/v1/tlog/witnessed'].get,
  bySize:spec.paths['/api/v1/tlog/checkpoints/{size}'].get,
  lookup:spec.paths['/api/v1/tlog/lookup'].get,
  proof:spec.paths['/api/v1/tlog/proof'].get,
  consistency:spec.paths['/api/v1/tlog/consistency'].get,
  cosign:spec.paths['/api/v1/tlog/cosignatures'].post,
 };
 assert.ok(spec.tags.some((t)=>t.name==='Transparency log'));
 for(const [name,op] of Object.entries(ops)){
  assert.deepEqual(op.tags,['Transparency log'],name);
  assert.equal(op.security,undefined,`${name} is public`);
 }
 for(const op of [ops.checkpoint,ops.witnessed,ops.bySize])assert.ok(op.responses['200'].content['text/plain'],'checkpoints are signed notes');
 for(const op of [ops.tile,ops.entries])assert.ok(op.responses['200'].content['application/octet-stream']);
 assert.ok(ops.cosign.requestBody.content['text/plain']);
 assert.equal(ops.cosign.responses['429'].$ref,'#/components/responses/TooManyRequests');
 assert.match(ops.cosign.description,/cosignature\/v1/);
 assert.match(ops.tile.description,/immutable/);
});

test('the transparency log schemas name the same entry kinds as the router',()=>{
 assert.deepEqual(spec.components.parameters.TlogKind.schema.enum,KINDS);
 assert.deepEqual(spec.components.schemas.TlogInfo.properties.data.properties.kinds.items.enum,KINDS);
 for(const name of ['TlogInfo','TlogCheckpoint','TlogEntry','TlogProof','TlogConsistency','TlogCosignatureResult'])assert.ok(spec.components.schemas[name],name);
 assert.ok(spec.components.schemas.TlogProof.properties.data.required.includes('inclusion'));
});

test('the developer docs explain the key log and the opt-in client check',()=>{
 assert.match(docs,/<a href="#key-log">Key log<\/a>/);
 assert.match(docs,/<h2 id="key-log">/);
 assert.match(docs,/SplitViewDetected/);
 assert.match(docs,/scripts\/tlog-witness\.ts/);
});

test('Rekor anchoring of checkpoints is documented as an alternative to witnesses',()=>{
 const ops={list:spec.paths['/api/v1/tlog/rekor'].get,key:spec.paths['/api/v1/tlog/rekor/key'].get,bySize:spec.paths['/api/v1/tlog/rekor/{size}'].get};
 for(const [name,op] of Object.entries(ops)){
  assert.deepEqual(op.tags,['Transparency log'],name);
  assert.equal(op.security,undefined,`${name} is public`);
  assert.match(op.description,/rekor_not_enabled/);
 }
 const anchor=spec.components.schemas.TlogRekorAnchor;
 for(const f of ['uuid','log_index','integrated_time','inclusion_proof','signed_entry_timestamp','artifact_sha256'])assert.ok(anchor.properties[f],f);
 assert.ok(spec.components.schemas.TlogInfo.properties.data.properties.rekor);
 assert.ok(spec.components.schemas.TlogCheckpoint.properties.rekor);
 assert.match(docs,/TLOG_REKOR_ENABLED/);
 assert.match(docs,/search\.sigstore\.dev/);
 assert.match(docs,/\/api\/v1\/tlog\/rekor\/key/);
});
