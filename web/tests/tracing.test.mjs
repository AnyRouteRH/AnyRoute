import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Tracing.jsx keeps its pure helpers in one plain-JS block between markers, so they run here without a JSX toolchain.
const source=fs.readFileSync(new URL('../components/features/Tracing.jsx',import.meta.url),'utf8');
const dashboard=fs.readFileSync(new URL('../components/Dashboard.jsx',import.meta.url),'utf8');
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');
const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const begin=source.indexOf('// ---- tracing pure helpers: begin');
const end=source.indexOf('// ---- tracing pure helpers: end');
assert.ok(begin>0&&end>begin,'helper markers present');
const block=source.slice(begin,end).replace(/^export /gm,'');
const names=[...block.matchAll(/^(?:function|const)\s+([A-Za-z]\w*)/gm)].map(m=>m[1]);
const loaded=vm.runInNewContext(`${block}\n;({${names.join(',')}})`,{});
const local=(v)=>v&&typeof v==='object'?JSON.parse(JSON.stringify(v)):v;
const h=Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,typeof v==='function'?(...args)=>local(v(...args)):local(v)]));

test('headers are parsed from Name: value lines',()=>{
 assert.deepEqual(h.parseHeaders('x-honeycomb-team: abc\n\nAuthorization: Basic a:b'),{headers:{'x-honeycomb-team':'abc',Authorization:'Basic a:b'}});
 assert.match(h.parseHeaders('no colon here').error,/Name: value/);
});

test('the PATCH body leaves empty secrets out so the stored ones are kept, and asks for them on a new type',()=>{
 const current={type:'otlp',include_content:false,enabled:true};
 assert.deepEqual(h.tracingBody({type:'otlp',endpoint:'',headers:'',include_content:true},current),{body:{tracing:{type:'otlp',include_content:true,enabled:true}}});
 assert.deepEqual(h.tracingBody({type:'otlp',endpoint:' https://api.honeycomb.io ',headers:'x-honeycomb-team: k'},null).body.tracing,{type:'otlp',include_content:false,enabled:true,endpoint:'https://api.honeycomb.io',headers:{'x-honeycomb-team':'k'}});
 assert.match(h.tracingBody({type:'otlp',endpoint:''},null).error,/collector URL/);
 assert.match(h.tracingBody({type:'langfuse',public_key:'pk'},current).error,/Langfuse/);
 assert.deepEqual(h.tracingBody({type:'langfuse',public_key:'pk',secret_key:'sk'},null).body.tracing,{type:'langfuse',include_content:false,enabled:true,public_key:'pk',secret_key:'sk'});
 assert.match(h.tracingBody({type:'helicone'},null).error,/Helicone/);
 assert.deepEqual(h.tracingBody({type:'helicone'},{type:'helicone'}).body.tracing,{type:'helicone',include_content:false,enabled:true});
});

test('status reads as words',()=>{
 assert.equal(h.statusText(null).text,'Off');
 assert.equal(h.statusText({enabled:true,status:null}).tone,'wait');
 assert.deepEqual(h.statusText({enabled:true,status:{exported:1200,failed:0,dropped:0,circuit:'closed'}}),{tone:'ok',text:'1,200 exported'});
 assert.equal(h.statusText({enabled:true,status:{exported:3,failed:2,dropped:1,circuit:'closed',last_error:'http_500'}}).text,'3 exported · 2 failed · 1 dropped (last: http_500)');
 assert.match(h.statusText({enabled:true,status:{exported:0,failed:5,dropped:0,circuit:'open',last_error:'timeout'}}).text,/Paused after repeated failures/);
});

test('the API keys tab renders the Tracing section, the docs have recipes and openapi documents it',()=>{
 assert.match(dashboard,/<Tracing live=\{live && signedIn\}/);
 for(const recipe of ['Honeycomb (OTLP)','Grafana Cloud Tempo (OTLP)','Langfuse','Helicone'])assert.ok(docs.includes(recipe),recipe);
 assert.ok(docs.includes('id="tracing"'));
 assert.ok(!/\u2014/.test(source),'no em dashes in the tracing section');
 const s=spec.components.schemas;
 assert.deepEqual(s.TracingSettings.properties.type.enum,['otlp','langfuse','helicone']);
 assert.equal(s.TracingSettings.properties.include_content.default,false);
 assert.ok(!('secret_key' in s.Tracing.properties)&&!('headers' in s.Tracing.properties),'the returned view has no secret field');
 assert.ok(spec.paths['/api/v1/keys/{hash}'].patch);
});
