import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');

test('the Responses endpoint is documented like chat completions: same auth, routing headers and response headers',()=>{
 const op=spec.paths['/api/v1/responses'].post;
 const chat=spec.paths['/api/v1/chat/completions'].post;
 assert.deepEqual(op.tags,['Responses']);
 assert.ok(spec.tags.some((t)=>t.name==='Responses'));
 assert.equal(op.operationId,'createResponse');
 assert.deepEqual(op.security,chat.security);
 assert.deepEqual(op.parameters,chat.parameters,'lane, disclosure, payment and referer headers apply');
 assert.equal(op.requestBody.content['application/json'].schema.$ref,'#/components/schemas/ResponsesRequest');
 const ok=op.responses['200'];
 assert.equal(ok.content['application/json'].schema.$ref,'#/components/schemas/ResponsesObject');
 assert.ok(ok.content['text/event-stream']);
 for(const h of ['X-Receipt-Id','Inference-Id','X-Anyroute-Lane','X-Anyroute-Policy-Hash'])assert.ok(ok.headers[h],h);
 for(const code of ['400','401','402','403','404','409','429','501','503'])assert.ok(op.responses[code],`declares ${code}`);
});

test('the description states the stateless rule, the tool rule and the events',()=>{
 const d=spec.paths['/api/v1/responses'].post.description;
 for(const re of [/store must be false/,/previous_response_id/,/Function tools and custom \(freeform\) tools run/,/custom_tool_call/,/response\.custom_tool_call_input\.delta/,/no grammar is enforced/,/web_search, file_search, code_interpreter, computer_use/,/response\.output_text\.delta/,/response\.function_call_arguments\.done/,/response\.completed/,/there is no \[DONE\]/,/X-Anyroute-Lane/,/anyroute_receipt_id/])assert.match(d,re);
 const get=spec.paths['/api/v1/responses/{id}'].get;
 assert.ok(get.responses['404']);
 assert.match(get.description,/responses_not_stored/);
});

test('the request and response schemas match what the router accepts and returns',()=>{
 const req=spec.components.schemas.ResponsesRequest;
 assert.deepEqual(req.required,['model','input']);
 assert.deepEqual(req.properties.store.enum,[false]);
 assert.equal(req.properties.provider.$ref,'#/components/schemas/ProviderPreferences');
 assert.deepEqual(req.properties.text.properties.format.properties.type.enum,['text','json_object','json_schema']);
 assert.deepEqual(req.properties.tools.items.oneOf.map((t)=>t.properties.type.const),['function','custom'],'function and custom tools');
 assert.match(req.properties.tools.items.oneOf[1].properties.format.description,/not enforced/);
 const obj=spec.components.schemas.ResponsesObject;
 assert.equal(obj.properties.object.const,'response');
 assert.deepEqual(obj.properties.status.enum,['in_progress','completed','incomplete','failed']);
 assert.match(obj.properties.metadata.description,/anyroute_receipt_id/);
 assert.deepEqual(spec.components.schemas.ResponsesInputItem.oneOf.map((i)=>i.properties.type.const),['message','function_call','function_call_output','custom_tool_call','custom_tool_call_output']);
 const kinds=obj.properties.output.items.oneOf.map((i)=>i.properties.type.const);
 assert.deepEqual(kinds,['message','function_call','custom_tool_call']);
});

test('the developer docs have a section for the Agents SDK and Codex with the base URL, the key and the attested lane',()=>{
 assert.match(docs,/id="responses"/);
 assert.match(docs,/OpenAI Agents SDK/);
 assert.match(docs,/wire_api = "responses"/);
 assert.match(docs,/X-Anyroute-Lane/);
 assert.match(docs,/store: false|store must be false/);
 assert.match(docs,/id="responses"[\s\S]*custom_tool_call_output[\s\S]*nothing checks or enforces it/,'the docs cover custom tools and say the grammar is not enforced');
 assert.match(docs,/POST \/v1\/responses/);
});
