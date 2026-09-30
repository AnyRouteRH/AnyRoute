import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LIMITS,NAME_RE,PRESET_PREFIX,diffDocs,docText,parseDoc,pinned,presetSummary,samplePresets,shortHash,showValue,slugifyName,snippet,versionLabel} from '../lib/presets.js';

const LLAMA='meta-llama/llama-3.3-70b-instruct',QWEN='qwen/qwen3-32b';
const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));

test('names follow the router pattern and pins read @preset/<name>@<version>',()=>{
 assert.equal(slugifyName('Support Bot: EU!'),'support-bot-eu');
 assert.ok(NAME_RE.test('support'));assert.ok(!NAME_RE.test('Support'));assert.ok(!NAME_RE.test('a'));
 assert.equal(pinned('support',3),'@preset/support@3');
 assert.equal(shortHash('9f2c4e6a8b0d1f3e5a7c'),'9f2c4e6a8b0d');
 assert.equal(versionLabel({version:2,hash:'1a3c5e7f9b2d4f6a8c0e'}),'v2 · 1a3c5e7f9b2d');
});

test('the editor parses a preset document and names what is wrong before any call',()=>{
 const ok=parseDoc(JSON.stringify({models:[QWEN,LLAMA],system_prompt:'Be brief.',params:{temperature:0.2}}),{catalogIds:new Set([QWEN,LLAMA])});
 assert.equal(ok.ok,true);assert.deepEqual(ok.doc.models,[QWEN,LLAMA]);
 assert.match(parseDoc('{nope').errors.json,/Not valid JSON/);
 assert.match(parseDoc('[]').errors.json,/object/);
 assert.match(parseDoc(JSON.stringify({models:[LLAMA],messages:[]})).errors.json,/Unknown field/);
 assert.match(parseDoc(JSON.stringify({models:[]})).errors.models,/at least one/);
 assert.match(parseDoc(JSON.stringify({models:[LLAMA,LLAMA]})).errors.models,/once/);
 assert.match(parseDoc(JSON.stringify({models:['@route/x']})).errors.models,/cannot point/);
 assert.match(parseDoc(JSON.stringify({models:['acme/gone']}),{catalogIds:new Set([LLAMA])}).errors.models,/acme\/gone/);
 assert.match(parseDoc(JSON.stringify({models:[LLAMA],system_prompt:'x'.repeat(LIMITS.systemPromptChars+1)})).errors.system_prompt,/16,000/);
 assert.match(parseDoc(JSON.stringify({models:[LLAMA],system_prompt:''})).errors.system_prompt,/leave it out/);
 assert.match(parseDoc(JSON.stringify({models:[LLAMA],tool_choice:'auto'})).errors.tool_choice,/needs tools/);
 assert.match(parseDoc(JSON.stringify({models:[LLAMA],tools:Array.from({length:33},()=>({}))})).errors.tools,/at most 32/);
 assert.equal(parseDoc(docText()).ok,false,'the empty template asks for a model');
 assert.deepEqual(JSON.parse(docText({models:[LLAMA],system_prompt:'s',extra:1})),{models:[LLAMA],system_prompt:'s'});
});

test('the diff matches the router: JSON Pointer paths with old and new values',()=>{
 const a={models:[QWEN,LLAMA],params:{temperature:0.2},system_prompt:'v1'};
 const b={models:[QWEN],params:{temperature:0.5,top_p:0.9},system_prompt:'v2',description:'a/b~'};
 assert.deepEqual(diffDocs(a,b),[
  {op:'add',path:'/description',to:'a/b~'},
  {op:'remove',path:'/models/1',from:LLAMA},
  {op:'replace',path:'/params/temperature',from:0.2,to:0.5},
  {op:'add',path:'/params/top_p',to:0.9},
  {op:'replace',path:'/system_prompt',from:'v1',to:'v2'},
 ]);
 assert.deepEqual(diffDocs(a,{system_prompt:'v1',params:{temperature:0.2},models:[QWEN,LLAMA]}),[]);
 assert.equal(showValue('x'.repeat(200),10).length,10);assert.equal(showValue({a:1}),'{"a":1}');assert.equal(showValue(undefined),'');
});

test('sample presets show a rollback that restores an earlier hash, and are labelled',()=>{
 const support=samplePresets.find((p)=>p.name==='support');
 assert.ok(samplePresets.every((p)=>p.sample&&p.model===PRESET_PREFIX+p.name&&p.history.length===p.versions));
 const [v3,v2,v1]=support.history;
 assert.equal(v3.source,'rollback');assert.equal(v3.restored_from,1);assert.equal(v3.hash,v1.hash);
 assert.deepEqual(diffDocs(v1.config,v3.config),[]);
 assert.ok(diffDocs(v1.config,v2.config).some((c)=>c.path==='/system_prompt'));
 assert.deepEqual(presetSummary(support.config).slice(0,1),['system prompt · 50 chars']);
 assert.ok(presetSummary(samplePresets[0].config).includes('response_format json_object'));
});

test('snippets call the preset by name and read the preset field; the API documents every endpoint',()=>{
 assert.match(snippet('support',null,'https://r.example','js'),/model: "@preset\/support"/);
 assert.match(snippet('support',3,'https://r.example','python'),/model="@preset\/support@3"/);
 assert.match(snippet('support',null,'','js'),/completion\.preset/);
 for(const [path,methods] of [['/api/v1/presets',['get']],['/api/v1/presets/{name}',['get','put','delete']],['/api/v1/presets/{name}/versions',['get']],['/api/v1/presets/{name}/diff',['get']],['/api/v1/presets/{name}/rollback',['post']]])
  for(const m of methods)assert.deepEqual(spec.paths[path]?.[m]?.tags,['Presets'],`${m.toUpperCase()} ${path}`);
 assert.equal(spec.components.schemas.PresetDocument.properties.system_prompt.maxLength,LIMITS.systemPromptChars);
 assert.match(spec.components.schemas.ChatRequest.properties.model.description,/@preset\/<name>@<version>/);
});

test('no em dashes in the user-facing preset text',()=>{
 for(const file of ['../components/features/Presets.jsx','../lib/presets.js'])
  assert.ok(!fs.readFileSync(new URL(file,import.meta.url),'utf8').includes('\u2014'),file);
});
