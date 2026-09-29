import test from 'node:test';
import assert from 'node:assert/strict';
import {ATTESTED_LANE,MAX_LANES,PRESETS,attestedCatalog,blankLane,decodeArena,encodeArena,isFailClosed,pickWinners,presetLanes,proofFromReceipt,raceLane} from '../lib/arena.js';
import {ApiError} from '../lib/api.js';

const KEY='sk-ar-v1-'+'ab12'.repeat(16);
const KIMI='moonshotai/kimi-k3',DSV='deepseek/deepseek-v4-flash-0731',GLM='z-ai/glm-5.3',OSS='openai/gpt-oss-120b',LLAMA='meta-llama/llama-3.3-70b-instruct';
const FRONTIER=PRESETS.find((p)=>p.id==='frontier-attested');

// A receipt as the router signs it (src/api/chat.ts finalize), with the upstream_attestation block exactly as
// src/providers/aci.ts compactUpstream() writes it. test/private-arena.test.ts builds this from the real checker.
const claims=(o={})=>({tee_attested:{status:'asserted',source:'hardware_proven'},tcb_up_to_date:{status:'asserted',source:'hardware_proven'},gpu_attested:{status:'asserted',source:'verifier_derived'},model_weights_provenance:{status:'unknown'},zdr:null,...o});
const upstream=(o={})=>({kind:'aci/1',receipt_id:'rcpt-1',workload_id:null,keyset_digest:'sha256:'+'ab'.repeat(32),receipt_verified:true,upstream:{result:'verified',required:true,session_id:'ab'.repeat(32),model_id:'demo-model'},claims:claims(),gpu_attested:true,attested:true,constraints:{aci_verified:true,zdr:true},...o});
const receipt=(over={},ua=upstream())=>({id:'gen-1-abc',sig:'00',key_id:'k1',alg:'Ed25519',payload:{v:1,id:'gen-1-abc',model:KIMI,provider:'phala-confidential-ai',disclosure:'attested',lane:'attested',attestation:'0x'+'cd'.repeat(32),...(ua?{upstream_attestation:ua}:{}),...over}});
const texts=(proof)=>proof.checks.map((c)=>`${c.key}:${c.state}`);

test('a gateway receipt with every claim asserted shows provider, TEE, GPU and TCB',()=>{
 const proof=proofFromReceipt(receipt());
 assert.equal(proof.attested,true);assert.equal(proof.gateway,true);assert.equal(proof.reason,null);
 assert.equal(proof.provider,'phala-confidential-ai');
 assert.deepEqual(texts(proof),['provider:yes','tee:yes','gpu:yes','tcb:yes']);
 assert.deepEqual(proof.checks.map((c)=>c.text),['Provider attested','TEE attested','GPU attested','TCB up to date']);
});

test('GPU attested comes from upstream_attestation.gpu_attested and is never assumed',()=>{
 const off=proofFromReceipt(receipt({},upstream({gpu_attested:false,claims:claims({gpu_attested:{status:'unknown'}})})));
 assert.equal(off.attested,true,'the answer is still attested; only the GPU claim is missing');
 assert.deepEqual(texts(off),['provider:yes','tee:yes','gpu:unknown','tcb:yes']);
 assert.equal(off.checks[2].text,'GPU status not reported');
 const refuted=proofFromReceipt(receipt({},upstream({gpu_attested:false,claims:claims({gpu_attested:{status:'refuted'}})})));
 assert.equal(refuted.checks[2].state,'no');assert.equal(refuted.checks[2].text,'GPU not attested');
 const absent=proofFromReceipt(receipt({},upstream({gpu_attested:false,claims:claims({gpu_attested:null})})));
 assert.equal(absent.checks[2].state,'unknown');
 const inconsistent=proofFromReceipt(receipt({},upstream({gpu_attested:false})));
 assert.equal(inconsistent.checks[2].state,'no','an asserted claim the router did not count is not shown as attested');
});

test('TCB status is shown as stated: up to date, out of date, or not reported',()=>{
 const state=(c)=>proofFromReceipt(receipt({},upstream({claims:claims({tcb_up_to_date:c})}))).checks[3];
 assert.deepEqual([state({status:'asserted'}).state,state({status:'asserted'}).text],['yes','TCB up to date']);
 assert.deepEqual([state({status:'refuted'}).state,state({status:'refuted'}).text],['no','TCB out of date']);
 assert.deepEqual([state({status:'unknown'}).state,state({status:'unknown'}).text],['unknown','TCB status not reported']);
 assert.equal(state(null).state,'unknown');
 assert.equal(state({status:'something-new'}).state,'unknown');
});

test('a gateway receipt that did not verify establishes nothing, whatever its claims say',()=>{
 const proof=proofFromReceipt(receipt({disclosure:'policy'},upstream({receipt_verified:false,gpu_attested:false,attested:false,reason:'the receipt signature does not verify'})));
 assert.equal(proof.attested,false);
 assert.deepEqual(texts(proof),['provider:no','tee:no','gpu:no','tcb:unknown']);
 assert.equal(proof.reason,'the receipt signature does not verify');
 const forged=proofFromReceipt(receipt({},upstream({receipt_verified:false,gpu_attested:true,attested:true})));
 assert.equal(forged.checks[1].state,'no');assert.equal(forged.checks[2].state,'no','GPU is not credited to a receipt that did not verify');
});

test('an upstream the gateway did not verify is not attested, and says why',()=>{
 const ua=upstream({upstream:{result:'failed',required:false,session_id:null,model_id:null},claims:claims({tee_attested:null,tcb_up_to_date:null,gpu_attested:null}),gpu_attested:false,attested:false,reason:'the upstream was not verified (result "failed", required false)'});
 const proof=proofFromReceipt(receipt({disclosure:'policy'},ua));
 assert.equal(proof.attested,false);
 assert.match(proof.reason,/upstream was not verified/);
 assert.equal(proof.checks[0].text,'Provider not attested');
 assert.equal(proof.checks[1].state,'unknown');
 const noReason=proofFromReceipt(receipt({},upstream({attested:false,gpu_attested:false})));
 assert.equal(noReason.attested,false);assert.match(noReason.reason,/does not show an attested upstream/);
});

test('a directly attested provider (no gateway record) shows the provider check and nothing about GPU or TCB',()=>{
 const proof=proofFromReceipt(receipt({provider:'phala-qwen05b-tdx'},null));
 assert.equal(proof.attested,true);assert.equal(proof.gateway,false);
 assert.deepEqual(texts(proof),['provider:yes']);
});

test('development-only evidence, a missing attestation hash or another retention class is never shown as attested',()=>{
 const simulated=proofFromReceipt(receipt({attestation_simulated:true},null));
 assert.equal(simulated.attested,false);assert.equal(simulated.checks[0].text,'Provider evidence is development-only');assert.match(simulated.reason,/development-only/);
 const noHash=proofFromReceipt(receipt({attestation:null},null));
 assert.equal(noHash.attested,false);
 const policy=proofFromReceipt(receipt({disclosure:'policy',attestation:null},null));
 assert.equal(policy.attested,false);assert.equal(policy.reason,'served under policy retention');
});

test('no signed receipt, no proof; a provider id that is not a plausible id gets no verify link',()=>{
 for(const r of [null,undefined,{},{payload:null},{payload:'x'},'x',[]])assert.equal(proofFromReceipt(r),null);
 assert.equal(proofFromReceipt(receipt({provider:'a b/c?'})).provider,null);
 assert.equal(proofFromReceipt(receipt({provider:''})).provider,null);
 assert.equal(proofFromReceipt(receipt({provider:'phala-qwen05b-tdx'})).provider,'phala-qwen05b-tdx');
});

test('the attested list keeps only rows that report an attested endpoint, and carries the GPU field',()=>{
 const row=(id,attested,gpu)=>({id,name:id.split('/')[1],context_length:32768,pricing:{prompt:'0.000001',completion:'0.000002'},supported_parameters:[],architecture:{output_modalities:['text']},disclosure:{best:attested?'attested':'policy',endpoints:{attested,policy:1}},...(gpu===undefined?{}:{gpu_attested:gpu})});
 const list=attestedCatalog([row(KIMI,1,true),row(LLAMA,0),row(DSV,2,null),row(GLM,1,false),row(OSS,1),null,{id:'x/y'}]);
 assert.deepEqual(list.map((m)=>m.id),[KIMI,DSV,GLM,OSS]);
 assert.deepEqual(list.map((m)=>m.gpuAttested),[true,null,false,null]);
 assert.equal(list[0].price,1);assert.equal(list[0].output,2);
 assert.deepEqual(attestedCatalog(undefined),[]);
 const embed={...row('e/embed',1),architecture:{output_modalities:['embeddings']}};
 assert.deepEqual(attestedCatalog([embed]),[],'embedding models cannot answer a prompt');
});

test('the frontier preset lists the four models and uses only those in the attested list',()=>{
 assert.equal(FRONTIER.label,'Frontier, attested');assert.equal(FRONTIER.attested,true);
 assert.deepEqual(FRONTIER.models,[KIMI,DSV,GLM,OSS]);
 const all=presetLanes(FRONTIER,[OSS,LLAMA,KIMI,GLM,DSV].map((id)=>({id})));
 assert.deepEqual(all.models,[KIMI,DSV,GLM,OSS],'the preset order, not the catalog order');
 assert.deepEqual(all.missing,[]);assert.equal(all.ready,true);
 const some=presetLanes(FRONTIER,[{id:GLM},{id:LLAMA},{id:KIMI}]);
 assert.deepEqual(some.models,[KIMI,GLM]);assert.deepEqual(some.missing,[DSV,OSS]);assert.equal(some.ready,true);
 const one=presetLanes(FRONTIER,[{id:OSS}]);
 assert.deepEqual(one.models,[OSS]);assert.equal(one.ready,false,'one lane is not a race');
 const none=presetLanes(FRONTIER,[{id:LLAMA}]);
 assert.deepEqual(none.models,[]);assert.deepEqual(none.missing,FRONTIER.models);assert.equal(none.ready,false);
 assert.deepEqual(presetLanes(FRONTIER,null).models,[]);assert.deepEqual(presetLanes(null,[{id:KIMI}]).models,[]);
 assert.ok(all.models.length<=MAX_LANES);
});

test('the share link carries the attested switch and reads it back',()=>{
 const {query}=encodeArena({prompt:'Explain TEEs',models:[KIMI,OSS],attested:true});
 assert.deepEqual([...new URLSearchParams(query).keys()],['prompt','attested','model','model']);
 assert.equal(new URLSearchParams(query).get('attested'),'1');
 assert.deepEqual(decodeArena(query),{prompt:'Explain TEEs',models:[KIMI,OSS],attested:true});
 assert.equal(encodeArena({attested:true}).query,'?attested=1','the switch alone is worth sharing');
 assert.deepEqual(decodeArena('?attested=1'),{prompt:'',models:[],attested:true});
});

test('a link without the switch is unchanged, and only an explicit 1 or true turns it on',()=>{
 const off=encodeArena({prompt:'hi',models:[KIMI],attested:false}).query;
 assert.equal(off.includes('attested'),false);
 assert.deepEqual(decodeArena(off),{prompt:'hi',models:[KIMI]});
 assert.equal(encodeArena({prompt:'hi',models:[KIMI]}).query,off);
 assert.equal(encodeArena({attested:'yes'}).query,'');
 assert.equal(decodeArena('?attested=true').attested,true);
 assert.equal(decodeArena('?attested=TRUE').attested,true);
 for(const v of ['0','false','','yes','2','on'])assert.equal('attested' in decodeArena('?attested='+v),false,v);
 assert.equal('attested' in decodeArena('?attested=1&attested=0'),true,'the first value decides');
});

test('the switch never carries a key, and keys in the prompt are still removed',()=>{
 const {query}=encodeArena({prompt:`use ${KEY}`,models:[KIMI],attested:true});
 assert.equal(query.includes('sk-ar'),false);assert.equal(query.includes(KEY),false);
 const back=decodeArena(`?attested=1&key=${KEY}&api_key=${KEY}&model=${KIMI}`);
 assert.equal(JSON.stringify(back).includes('sk-ar'),false);
 assert.deepEqual(Object.keys(back).sort(),['attested','models','prompt']);
});

test('the router\'s refusals are the fail-closed types',()=>{
 for(const t of ['no_attested_endpoint','lane_unavailable','disclosure_unavailable','disclosure_provider_unavailable','upstream_not_attested'])assert.equal(isFailClosed(t),true,t);
 for(const t of ['insufficient_credits','providers_unavailable','','error',undefined,null])assert.equal(isFailClosed(t),false,String(t));
});

// ---- the runner on the attested lane

const clock=()=>{let t=1000;return {now:()=>t,at:(ms)=>{t=1000+ms}}};
const ok=(over={})=>async({onDelta})=>{onDelta('Hello');return {text:'Hello',usage:{completion_tokens:3,cost:0.0002},receipt:receipt(),provider:'Phala',error:null,...over}};

test('an attested lane asks the router for the attested lane and reads the proof from its receipt',async()=>{
 let body;const c=clock();
 const final=await raceLane({model:KIMI,prompt:'hi',key:KEY,attested:true,now:c.now,stream:async(a)=>{body=a.body;return ok()(a)}});
 assert.deepEqual(body,{model:KIMI,messages:[{role:'user',content:'hi'}],max_tokens:1024,provider:{lane:ATTESTED_LANE}});
 assert.equal(body.provider.lane,'attested');
 assert.equal(final.status,'done');assert.equal(final.receiptId,'gen-1-abc');
 assert.equal(final.proof.attested,true);assert.deepEqual(texts(final.proof),['provider:yes','tee:yes','gpu:yes','tcb:yes']);
});

test('a lane outside attested-only mode sends no provider block and shows no proof',async()=>{
 let body;
 const final=await raceLane({model:KIMI,prompt:'hi',key:KEY,now:()=>0,stream:async(a)=>{body=a.body;return ok()(a)}});
 assert.equal('provider' in body,false);
 assert.equal(final.proof,null);assert.equal(blankLane('a/b').proof,null);
});

test('a lane refused with 409 is a failed lane that shows the router\'s message and was never charged',async()=>{
 const message='No provider for moonshotai/kimi-k3 meets lane "attested": it needs a provider whose retention is declared "attested" and whose TEE attestation is fresh. Nothing was sent to any provider and nothing was charged.';
 const c=clock();
 const refuse=async()=>{c.at(60);throw new ApiError(409,message,'lane_unavailable',{requested:{disclosure:'none',lane:'attested'}})};
 const seen=[];
 const lane=await raceLane({model:KIMI,prompt:'hi',key:KEY,attested:true,now:c.now,stream:refuse,onUpdate:(p)=>seen.push(p)});
 assert.equal(lane.status,'error');assert.equal(lane.errorType,'lane_unavailable');assert.equal(lane.error,message);
 assert.equal(isFailClosed(lane.errorType),true);
 assert.equal(lane.receiptId,undefined);assert.equal(lane.proof,undefined);
 assert.equal(pickWinners([{...blankLane(KIMI),...lane},{...blankLane(OSS),status:'done',ttft:1,total:2,cost:1}]).fastest.length,0,'a failed lane cannot win');
});

test('a 502 that withheld the answer keeps its receipt, cost and proof, and is a failed lane',async()=>{
 const message='The provider\'s receipt does not show an attested upstream (the upstream was not verified). The response was withheld. The upstream had already generated it, so the call is billed as usual; the signed receipt records the verification result.';
 const ua=upstream({attested:false,gpu_attested:false,claims:claims({tee_attested:null,gpu_attested:null}),reason:'the upstream was not verified (result "failed", required false)'});
 const rc=receipt({disclosure:'policy'},ua);
 // the streamed form: an error event, then the closing usage and receipt
 const streamed=async({onDelta})=>({text:'',usage:{completion_tokens:7,cost:0.0004},receipt:rc,provider:'Phala',error:new ApiError(502,message,'upstream_not_attested',{upstream_attestation:ua})});
 const a=await raceLane({model:KIMI,prompt:'hi',key:KEY,attested:true,now:()=>0,stream:streamed});
 assert.equal(a.status,'error');assert.equal(a.partial,false);assert.equal(a.error,message);assert.equal(a.errorType,'upstream_not_attested');
 assert.equal(a.text,'');assert.equal(a.ttft,null);
 assert.equal(a.receiptId,'gen-1-abc');assert.equal(a.cost,0.0004);assert.equal(a.tokens,7);
 assert.equal(a.proof.attested,false);assert.match(a.proof.reason,/upstream was not verified/);
 // the non-streamed form: an HTTP error that carries the receipt
 const failing=async()=>{const e=new ApiError(502,message,'upstream_not_attested');e.receipt=rc;e.usage={completion_tokens:7,cost:0.0004};throw e};
 const b=await raceLane({model:KIMI,prompt:'hi',key:KEY,attested:true,now:()=>0,stream:failing});
 assert.equal(b.status,'error');assert.equal(b.error,message);assert.equal(b.receiptId,'gen-1-abc');assert.equal(b.cost,0.0004);assert.equal(b.proof.attested,false);
});

test('a mid-stream provider failure on the attested lane is still a partial answer, not a refusal',async()=>{
 const final=await raceLane({model:KIMI,prompt:'hi',key:KEY,attested:true,now:()=>0,stream:ok({error:new ApiError(502,'upstream closed','provider_error')})});
 assert.equal(final.status,'done');assert.equal(final.partial,true);assert.match(final.error,/billed/);assert.equal(final.errorType,'');
});

test('other errors on the attested lane are not dressed up as refusals',async()=>{
 const boom=async()=>{throw new ApiError(402,'This key has no balance.','insufficient_credits')};
 const lane=await raceLane({model:KIMI,prompt:'hi',key:KEY,attested:true,now:()=>0,stream:boom});
 assert.equal(lane.status,'error');assert.equal(isFailClosed(lane.errorType),false);assert.equal(lane.proof,undefined);
});
