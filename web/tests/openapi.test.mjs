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

test('the lane variants, day-zero candidate endpoints and creator claim flow are documented and consistent',()=>{
 const variants=['mainstream','native_low_refusal','abliterated'];
 const list=spec.paths['/api/v1/models'].get;
 const variant=list.parameters.find((p)=>p.name==='variant');
 assert.ok(variant,'listModels takes ?variant=');
 assert.match(variant.description,/attested provider/);
 const model=spec.components.schemas.Model.properties;
 assert.deepEqual(model.variant.enum,variants);
 assert.deepEqual(model.variant_source.enum,['declared','candidate','inferred','default']);
 for(const k of ['license','base_model','weights','creator_handle','creator','royalty_bps'])assert.ok(model[k],`Model.${k}`);
 assert.match(model.variant.description,/never sent to a public or vendor-forwarded provider/);

 const lane=spec.paths['/api/v1/models/{author}/{slug}/lane'].put;
 assert.deepEqual(lane.security,[{BearerAuth:[]}],'declaring a variant is operator only');
 assert.equal(spec.components.schemas.ModelLaneInput.additionalProperties,false);
 assert.deepEqual(spec.components.schemas.ModelLaneInput.required,['variant']);
 assert.deepEqual(spec.components.schemas.ModelLaneInput.properties.variant.enum,variants);
 assert.equal(lane.parameters.filter((p)=>p.in==='path').length,2);

 const candidates=['/api/v1/lane/candidates','/api/v1/lane/candidates/{id}','/api/v1/lane/candidates/{id}/endpoint','/api/v1/lane/candidates/{id}/evaluate','/api/v1/lane/candidates/{id}/approve','/api/v1/lane/candidates/{id}/promote'];
 for(const path of candidates)for(const [method,op] of Object.entries(spec.paths[path])){
  assert.deepEqual(op.tags,['Lane'],`${method} ${path}`);
  assert.deepEqual(op.security,[{BearerAuth:[]}],`${method} ${path} is operator only`);
  assert.ok(op.responses['401'],`${method} ${path} declares 401`);
 }
 assert.deepEqual(spec.components.schemas.LaneCandidate.properties.status.enum,['discovered','rejected','evaluated','failed','approved','servable']);
 assert.match(spec.paths['/api/v1/lane/candidates/{id}/promote'].post.responses['409'].description,/not_servable/);

 const claims=spec.paths['/api/v1/creators/claims'].post;
 const verify=spec.paths['/api/v1/creators/claims/{id}/verify'].post;
 for(const op of [claims,verify,spec.paths['/api/v1/creators/claims/{id}'].get]){
  assert.deepEqual(op.tags,['Creator royalties']);
  assert.equal(op.security,undefined,'claims are public');
 }
 assert.ok(claims.responses['201']&&claims.responses['429']);
 for(const code of ['403','409','410','429','502'])assert.ok(verify.responses[code],`verify declares ${code}`);
 assert.equal(claims.requestBody.content['application/json'].schema.additionalProperties,false);
 assert.ok(spec.components.schemas.CreatorClaim.properties.file_content);
 for(const name of ['Lane','Creator royalties'])assert.ok(spec.tags.some((t)=>t.name===name),name);

 const ids=[];
 walk(spec.paths,(n)=>{if(typeof n.operationId==='string')ids.push(n.operationId);});
 assert.equal(new Set(ids).size,ids.length,'operation ids are unique');
 for(const [path,item] of Object.entries(spec.paths)){
  const declared=new Set();
  for(const op of Object.values(item))for(const p of op.parameters??[])if(p.in==='path')declared.add(p.name);
  for(const [,name] of path.matchAll(/\{(\w+)\}/g))assert.ok(declared.has(name),`${path} declares {${name}}`);
 }
});
