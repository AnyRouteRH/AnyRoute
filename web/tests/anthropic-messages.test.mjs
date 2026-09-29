import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');
const resolve=(ref)=>ref.replace(/^#\//,'').split('/').reduce((node,key)=>node?.[key],spec);

test('the Anthropic Messages operations are documented with both credential styles and the lane options',()=>{
 const create=spec.paths['/v1/messages'].post;
 const count=spec.paths['/v1/messages/count_tokens'].post;
 assert.deepEqual(create.tags,['Anthropic Messages']);
 assert.deepEqual(count.tags,['Anthropic Messages']);
 assert.ok(spec.tags.some((t)=>t.name==='Anthropic Messages'));
 assert.notEqual(create.operationId,count.operationId);
 for(const op of [create,count])assert.deepEqual(op.security,[{BearerAuth:[]},{AnthropicApiKey:[]}],'a key is required, in either header');
 assert.equal(spec.components.securitySchemes.AnthropicApiKey.name,'x-api-key');
 assert.equal(spec.components.securitySchemes.AnthropicApiKey.in,'header');
 const names=create.parameters.map((p)=>p.name);
 for(const n of ['X-Anyroute-Lane','X-Anyroute-Disclosure-Max','anthropic-version','anthropic-beta'])assert.ok(names.includes(n),n);
 assert.deepEqual(create.parameters.find((p)=>p.name==='X-Anyroute-Lane').schema.enum,['public','attested']);
});

test('the reply names its receipt in headers and body, and errors use Anthropic\'s shape',()=>{
 const ok=spec.paths['/v1/messages'].post.responses['200'];
 for(const h of ['X-Receipt-Id','Inference-Id','X-Anyroute-Lane','X-Anyroute-Policy-Hash'])assert.ok(ok.headers[h],h);
 assert.ok(ok.content['text/event-stream']);
 const message=spec.components.schemas.AnthropicMessage;
 assert.ok(message.properties.anyroute.properties.receipt_id);
 assert.deepEqual(message.properties.usage.required,['input_tokens','output_tokens']);
 // Anthropic's error body is not the router's ApiError, so it is declared as the default response, not as a 4xx of the shared kind.
 for(const op of [spec.paths['/v1/messages'].post,spec.paths['/v1/messages/count_tokens'].post]){
  assert.equal(op.responses.default.$ref,'#/components/responses/AnthropicError');
  for(const code of Object.keys(op.responses))assert.ok(!/^4/.test(code),`${code} would have to use the ApiError body`);
 }
 const err=spec.components.schemas.AnthropicErrorBody;
 assert.equal(err.properties.type.const,'error');
 assert.ok(err.properties.error.properties.type.enum.includes('billing_error'));
 assert.ok(resolve(spec.components.responses.AnthropicError.content['application/json'].schema.$ref));
});

test('the request schema requires what the API requires',()=>{
 const req=spec.components.schemas.AnthropicMessagesRequest;
 assert.deepEqual(req.required,['model','max_tokens','messages']);
 for(const k of ['system','tools','tool_choice','stop_sequences','stream','top_k','metadata','provider'])assert.ok(req.properties[k],k);
 assert.deepEqual(spec.components.schemas.AnthropicCountTokensRequest.required,['model','messages']);
 assert.equal(spec.components.schemas.AnthropicCountTokensRequest.properties.max_tokens,undefined);
});

test('the developer docs explain Claude Code and the SDKs, the model choice and the attested lane',()=>{
 assert.match(docs,/id="anthropic"/);
 assert.match(docs,/href="#anthropic"/);
 for(const s of ['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_CUSTOM_HEADERS','ANTHROPIC_MODEL_MAP','X-Anyroute-Lane: attested','/v1/messages/count_tokens','X-Receipt-Id'])
  assert.ok(docs.includes(s),`docs mention ${s}`);
 assert.match(docs,/POST \/v1\/messages/);
});
