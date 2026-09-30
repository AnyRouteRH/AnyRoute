import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');
const resolve=(ref)=>ref.replace(/^#\//,'').split('/').reduce((node,key)=>node?.[key],spec);

const CALLS=['/ollama/api/chat','/ollama/api/generate','/ollama/api/embed','/ollama/api/embeddings'];
const PUBLIC=[['/ollama/api/tags','get'],['/ollama/api/version','get'],['/ollama/api/ps','get'],['/ollama/api/show','post'],['/ollama/api/pull','post']];

test('the Ollama operations are documented under one tag; calls need a key, the catalog is public',()=>{
 assert.ok(spec.tags.some((t)=>t.name==='Ollama'));
 for(const path of CALLS){
  const op=spec.paths[path].post;
  assert.deepEqual(op.tags,['Ollama'],path);
  assert.deepEqual(op.security,[{BearerAuth:[]}],`${path} takes the key as Authorization: Bearer`);
  const names=op.parameters.map((p)=>resolve(p.$ref)?.name??p.name);
  assert.ok(names.includes('X-Anyroute-Lane'),`${path} takes X-Anyroute-Lane`);
  for(const h of ['X-Receipt-Id','X-Anyroute-Lane'])assert.ok(op.responses['200'].headers[h],`${path} returns ${h}`);
 }
 for(const [path,method] of PUBLIC){
  const op=spec.paths[path][method];
  assert.deepEqual(op.tags,['Ollama'],path);
  assert.equal(op.security,undefined,`${path} is public`);
 }
});

test('chat and generate stream NDJSON, and errors use Ollama\'s shape rather than the router\'s',()=>{
 for(const path of ['/ollama/api/chat','/ollama/api/generate'])assert.ok(spec.paths[path].post.responses['200'].content['application/x-ndjson'],path);
 for(const path of [...CALLS,...PUBLIC.map(([p])=>p)]){
  const op=Object.values(spec.paths[path])[0];
  assert.equal(op.responses.default.$ref,'#/components/responses/OllamaError',path);
  for(const code of Object.keys(op.responses))assert.ok(!/^4/.test(code),`${path} ${code} would have to use the ApiError body`);
 }
 assert.deepEqual(spec.components.schemas.OllamaErrorBody.required,['error']);
 const done=spec.components.schemas.OllamaChatResponse.properties;
 for(const k of ['done','done_reason','total_duration','eval_count','prompt_eval_count','anyroute'])assert.ok(done[k],k);
 assert.deepEqual(spec.components.schemas.OllamaModel.required,['name','model','modified_at','size','digest','details']);
});

test('the developer docs give the host, the key header and the client recipes',()=>{
 assert.match(docs,/id="ollama"/);
 assert.match(docs,/href="#ollama"/);
 for(const s of ['OLLAMA_HOST','/ollama','Authorization: Bearer','Open WebUI','Continue','ChatOllama','application/x-ndjson','X-Anyroute-Lane: attested','X-Anyroute-Ignored','num_predict'])
  assert.ok(docs.includes(s),`docs mention ${s}`);
 const section=docs.slice(docs.indexOf('id="ollama"'),docs.indexOf('id="responses"'));
 assert.ok(!section.includes(String.fromCharCode(0x2014)),'no em dashes in the Ollama section');
});
