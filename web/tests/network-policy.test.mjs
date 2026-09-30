import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const docs=fs.readFileSync(new URL('../components/NetworkPolicyDocs.jsx',import.meta.url),'utf8');
test('network policy API documents signed versions and operator-only explicit publication',()=>{
 for(const path of ['/api/v1/network/policy','/api/v1/network/policy/{version}']){
  assert.equal(spec.paths[path].get.security,undefined);
  assert.ok(spec.paths[path].get.responses['404']);
 }
 const publish=spec.paths['/trpc/network.publishPolicy'].post;
 assert.deepEqual(publish.security,[{AdminToken:[]}]);
 assert.equal(publish.requestBody.content['application/json'].schema.$ref,'#/components/schemas/HostPolicy');
 assert.equal(spec.components.schemas.HostPolicy.properties.rules.properties.allow_dev.const,false);
 assert.ok(spec.components.schemas.HostPolicyPublication.properties.signature);
 assert.match(docs,/default false/); assert.match(docs,/router reads request text in memory on every lane/);
 assert.match(docs,/does not change existing provider admission/);
 assert.doesNotMatch(docs,/\b(demo|test|mock|simulated|placeholder)\b|local.build/i);
});
