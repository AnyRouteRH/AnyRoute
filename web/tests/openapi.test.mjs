import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const ERRORS={400:'BadRequest',401:'Unauthorized',402:'PaymentRequired',403:'Forbidden',404:'NotFound',429:'TooManyRequests'};
const resolve=(ref)=>ref.replace(/^#\//,'').split('/').reduce((node,key)=>node?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],spec);
const walk=(node,fn)=>{if(node&&typeof node==='object'){fn(node);for(const v of Object.values(node))walk(v,fn);}};

test('the OpenAPI document declares its version, license, contact and subset scope',()=>{
 assert.match(spec.openapi,/^3\.1\.\d+$/);
 assert.equal(spec.info.license.identifier,'PolyForm-Noncommercial-1.0.0');
 assert.equal(spec.info.license.url,undefined,'license identifier and url are mutually exclusive');
 assert.ok(spec.info.contact.email);
 assert.equal(spec.info['x-api-coverage'],'subset');
 assert.match(spec.info.description,/documented subset/);
});

test('every $ref resolves inside the document',()=>{
 let refs=0;
 walk(spec,(node)=>{if(typeof node.$ref==='string'){refs++;assert.ok(node.$ref.startsWith('#/'),`external ref ${node.$ref}`);assert.ok(resolve(node.$ref),`unresolved ${node.$ref}`);}});
 assert.ok(refs>0);
});

test('4xx responses use the reusable error responses with the ApiError body',()=>{
 for(const name of Object.values(ERRORS)){
  const r=spec.components.responses[name];
  assert.ok(r?.description,`missing components.responses.${name}`);
  assert.equal(r.content['application/json'].schema.$ref,'#/components/schemas/ApiError');
 }
 assert.ok(spec.components.responses.TooManyRequests.headers['Retry-After']);
 for(const [path,item] of Object.entries(spec.paths))for(const [method,op] of Object.entries(item))for(const [code,res] of Object.entries(op.responses)){
  if(ERRORS[code])assert.equal(res.$ref,`#/components/responses/${ERRORS[code]}`,`${method.toUpperCase()} ${path} ${code}`);
 }
 const chat=spec.paths['/api/v1/chat/completions'].post.responses;
 for(const code of Object.keys(ERRORS))assert.ok(chat[code],`chat completions should declare ${code}`);
});

test('the blind-token endpoints, scheme and schemas are documented and consistent',()=>{
 const keys=spec.paths['/api/v1/blind/keys'].get;
 const buy=spec.paths['/api/v1/blind/purchase'].post;
 assert.deepEqual(keys.tags,['Blind tokens']);
 assert.deepEqual(buy.tags,['Blind tokens']);
 assert.ok(spec.tags.some((t)=>t.name==='Blind tokens'));
 assert.deepEqual(buy.security,[{BearerAuth:[]}],'buying tokens needs a key');
 assert.equal(keys.security,undefined,'the key list is public');
 assert.equal(spec.components.securitySchemes.PrivateToken.name,'Authorization');
 for(const [path,op] of [['/api/v1/chat/completions','post'],['/api/v1/embeddings','post'],['/api/v1/generation','get']])
  assert.ok(spec.paths[path][op].security.some((s)=>s.PrivateToken),`${op.toUpperCase()} ${path} accepts a PrivateToken`);
 const ids=[];
 walk(spec.paths,(n)=>{if(typeof n.operationId==='string')ids.push(n.operationId);});
 assert.equal(new Set(ids).size,ids.length,'operation ids are unique');
 for(const name of ['BlindKeys','BlindKey','BlindPurchaseRequest','BlindPurchase'])assert.ok(spec.components.schemas[name],name);
 assert.deepEqual(spec.components.schemas.BlindKey.properties.denomination.enum,[1000,10000,100000]);
 assert.match(spec.components.schemas.Receipt.properties.payload.description,/nullifier/);
 assert.ok(buy.responses['409'].content['application/json'].schema.$ref==='#/components/schemas/ApiError');
});
