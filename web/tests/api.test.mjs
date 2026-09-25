import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,api,getMode,streamChat,toCatalogModel,toProvider,toReceiptRow,validKey} from '../lib/api.js';

const withFetch=async(impl,fn)=>{const real=globalThis.fetch;globalThis.fetch=impl;try{return await fn();}finally{globalThis.fetch=real;}};
const sse=(chunks,headers={})=>new Response(new ReadableStream({start(c){const e=new TextEncoder();for(const ch of chunks)c.enqueue(e.encode(ch));c.close();}}),{status:200,headers:{'content-type':'text/event-stream',...headers}});

test('live mode is the default outside the browser and keys must match the router format',()=>{
 assert.equal(getMode(),'live');
 assert.equal(validKey('sk-ar-v1-'+'a'.repeat(64)),true);
 assert.equal(validKey(' sk-ar-v1-'+'0f'.repeat(32)+' '),true);
 for(const bad of ['','sk-ar-v1-'+'a'.repeat(63),'sk-ar-v1-'+'A'.repeat(64),'sk-or-v1-'+'a'.repeat(64)])assert.equal(validKey(bad),false);
});

test('catalog records map to the existing card shape with per-1M prices',()=>{
 const m=toCatalogModel({id:'meta-llama/llama-3.3-70b-instruct',name:'meta-llama/llama-3.3-70b-instruct',context_length:131072,pricing:{prompt:'0.0000001',completion:'0.00000032'},supported_parameters:['tools'],attested_available:true,data_policy:{providers:3,zdr_available:true},quantization:['bf16'],royalty_bps:0});
 assert.equal(m.name,'llama-3.3-70b-instruct');assert.equal(m.author,'Meta-llama');assert.equal(m.context,'128K');
 assert.equal(m.private,true);assert.equal(m.providers,3);assert.equal(m.zdr,true);assert.equal(m.type,'General');
 assert.ok(Math.abs(m.price-0.1)<1e-9);assert.ok(Math.abs(m.output-0.32)<1e-9);
 assert.equal(toCatalogModel({id:'x/r1',supported_parameters:['reasoning']}).type,'Reasoning');
 assert.equal(toCatalogModel({id:'acme/embed',architecture:{output_modalities:['embeddings']}}).type,'Embeddings');
 assert.match(toCatalogModel({id:'x/y',data_policy:{providers:1}}).description,/^1 provider · quantization not declared/);
});

test('receipts keep signed and anchored distinct and use the payment token decimals',()=>{
 const g={id:'gen-1',created_at:'2026-09-27T12:00:00Z',model:'m/x',provider_name:'P',tokens_prompt:40,tokens_completion:9,total_cost:0.00001,anchored:false,mode:'prepaid',paid_with:{token:'NVDA',raw_units:'48900000000'}};
 const r=toReceiptRow(g,[{symbol:'NVDA',decimals:18}]);
 assert.equal(r.tokens,49);assert.equal(r.paidWith,'NVDA');assert.equal(r.decimals,18);assert.ok(Math.abs(r.units-4.89e-8)<1e-18);
 assert.equal(r.status,'Signed · anchor pending');assert.equal(r.live,true);
 assert.equal(toReceiptRow({...g,anchored:true}).status,'Signed · anchored');
 const six=toReceiptRow({...g,paid_with:{token:'TSLA',raw_units:'2500000'}},[{symbol:'TSLA',decimals:6}]);assert.equal(six.units,2.5);
 assert.equal(toReceiptRow({...g,paid_with:null,mode:'per_call'}).paidWith,'USDG · per call');
 assert.equal(toReceiptRow({...g,paid_with:null}).paidWith,'USDG');
});

test('providers show measured values or nothing, never a placeholder number',()=>{
 const p=toProvider({name:'A',slug:'a',quantizations:['bf16','fp8'],uptime_30d:null,latency_p50_ms:null,bond_usdg:'10000000000',attestation_fresh:true,status:'live'});
 assert.equal(p.quant,'bf16, fp8');assert.equal(p.uptime,null);assert.equal(p.latency,null);assert.equal(p.bond,10000);assert.equal(p.private,true);
 assert.equal(toProvider({name:'B',slug:'b'}).quant,'undeclared');
});

test('API errors surface the router message and type; network failures are explicit',async()=>{
 await withFetch(async()=>new Response(JSON.stringify({error:{message:'Insufficient credits.',type:'insufficient_credits',code:402}}),{status:402}),async()=>{
  await assert.rejects(api('/api/v1/credits',{key:'k'}),e=>e instanceof ApiError&&e.status===402&&e.type==='insufficient_credits'&&e.message==='Insufficient credits.');
 });
 await withFetch(async()=>{throw new TypeError('fetch failed');},async()=>{
  await assert.rejects(api('/api/v1/status'),e=>e instanceof ApiError&&e.status===0&&e.type==='unreachable');
 });
 let seen;
 await withFetch(async(url,init)=>{seen={url,init};return new Response(JSON.stringify({data:{ok:true}}));},async()=>{
  assert.deepEqual(await api('/api/v1/keys',{key:'sk',method:'POST',body:{name:'a'}}),{data:{ok:true}});
 });
 assert.equal(seen.url,'/api/v1/keys');assert.equal(seen.init.headers.authorization,'Bearer sk');assert.equal(seen.init.headers['content-type'],'application/json');
});

test('streaming parses SSE split across chunks and returns usage and receipt',async()=>{
 const deltas=[];
 const out=await withFetch(async()=>sse([
  'data: {"id":"gen-9","provider":"Mock","model":"m/x","choices":[{"delta":{"content":"Hel"}}]}\n\n: keep-alive\n\ndata: {"choices":[{"de',
  'lta":{"content":"lo"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2},"receipt":{"id":"gen-9","sig":"s"}}\n\ndata: [DONE]\n\n',
 ],{'x-generation-id':'gen-9'}),()=>streamChat({key:'k',body:{model:'m/x',messages:[]},onDelta:t=>deltas.push(t)}));
 assert.deepEqual(deltas,['Hel','Hello']);assert.equal(out.text,'Hello');assert.equal(out.id,'gen-9');assert.equal(out.provider,'Mock');
 assert.equal(out.usage.completion_tokens,2);assert.equal(out.receipt.sig,'s');
});

test('a route failure without a receipt rejects; a non-200 start rejects with the router error',async()=>{
 await withFetch(async()=>sse(['data: {"error":{"code":503,"message":"All providers failed.","type":"no_providers"}}\n\n']),async()=>{
  await assert.rejects(streamChat({key:'k',body:{}}),e=>e instanceof ApiError&&e.status===503&&e.type==='no_providers');
 });
 await withFetch(async()=>new Response(JSON.stringify({error:{message:'Budget exceeded.',type:'budget_exceeded'}}),{status:402}),async()=>{
  await assert.rejects(streamChat({key:'k',body:{}}),e=>e.status===402&&e.message==='Budget exceeded.');
 });
});
