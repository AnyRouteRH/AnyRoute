import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_LANES,MAX_LINK_PROMPT,MAX_PROMPT,blankLane,chatModels,decodeArena,encodeArena,estimateCeiling,estimateTokens,filterModels,formatMs,formatUsd,pickWinners,raceLane,receiptHref,redactKeys,shortId,tokensPerSecond} from '../lib/arena.js';

const LLAMA='meta-llama/llama-3.3-70b-instruct',QWEN='qwen/qwen3-32b',GPT='openai/gpt-4o-mini',MIST='mistralai/mistral-small-3.2:free';
const KEY='sk-ar-v1-'+'ab12'.repeat(16);
const catalog=[
 {id:LLAMA,name:'Llama 3.3 70B Instruct',author:'Meta-llama',type:'General',price:0.1,output:0.3},
 {id:QWEN,name:'Qwen3 32B',author:'Qwen',type:'Reasoning',price:0.05,output:0.2},
 {id:'openai/text-embedding-3-small',name:'Text Embedding 3 Small',author:'Openai',type:'Embeddings',price:0.02,output:0},
 {id:GPT,name:'GPT-4o mini',author:'Openai',type:'General',price:0.15,output:0.6},
];

test('a link carries the prompt and the chosen models and nothing else',()=>{
 const {query,trimmed}=encodeArena({prompt:'Explain Merkle proofs & why they matter?',models:[LLAMA,QWEN]});
 assert.equal(trimmed,false);
 assert.ok(query.startsWith('?'));
 assert.deepEqual([...new URLSearchParams(query).keys()],['prompt','model','model']);
 assert.equal(query.includes('%2F'),false,'slashes in model ids stay readable');
 assert.deepEqual(decodeArena(query),{prompt:'Explain Merkle proofs & why they matter?',models:[LLAMA,QWEN]});
 assert.equal(encodeArena({}).query,'');
 assert.equal(encodeArena({prompt:'   ',models:[]}).query,'');
});

test('links round-trip unicode, newlines and model ids with colons',()=>{
 const prompt='Résumé — 日本語?\nline two & "quotes" 100% #1';
 const back=decodeArena(encodeArena({prompt,models:[MIST,GPT]}).query);
 assert.equal(back.prompt,prompt);
 assert.deepEqual(back.models,[MIST,GPT]);
});

test('a key never travels in a link, in either direction',()=>{
 const out=encodeArena({prompt:`use ${KEY} please`,models:[LLAMA]});
 assert.equal(out.query.includes('sk-ar'),false);
 assert.equal(redactKeys(`a ${KEY} b`),'a [key removed] b');
 const crafted=`?prompt=${encodeURIComponent('hello '+KEY)}&key=${KEY}&api_key=${KEY}&authorization=Bearer%20${KEY}&model=${LLAMA}`;
 const back=decodeArena(crafted);
 assert.deepEqual(Object.keys(back).sort(),['models','prompt']);
 assert.equal(JSON.stringify(back).includes('sk-ar'),false);
 assert.equal(back.prompt,'hello [key removed]');
});

test('decoding is defensive: bad ids, duplicates, extra lanes and oversized prompts',()=>{
 const bad=decodeArena('?model=%3Cscript%3E&model=&model=has%20space&model='+LLAMA+'&model='+LLAMA+'&model='+'x'.repeat(200));
 assert.deepEqual(bad.models,[LLAMA]);
 const many=decodeArena('?'+[LLAMA,QWEN,GPT,MIST,'a/b','c/d'].map((m)=>'model='+encodeURIComponent(m)).join('&'));
 assert.equal(many.models.length,MAX_LANES);
 assert.equal(decodeArena('?prompt='+'a'.repeat(MAX_PROMPT+500)).prompt.length,MAX_PROMPT);
 assert.deepEqual(decodeArena(''),{prompt:'',models:[]});
 assert.deepEqual(decodeArena(undefined),{prompt:'',models:[]});
});

test('a long prompt is trimmed for the link and says so',()=>{
 const {query,trimmed}=encodeArena({prompt:'w'.repeat(MAX_LINK_PROMPT+50),models:[LLAMA]});
 assert.equal(trimmed,true);
 assert.equal(decodeArena(query).prompt.length,MAX_LINK_PROMPT);
 assert.equal(encodeArena({prompt:'w'.repeat(MAX_LINK_PROMPT),models:[]}).trimmed,false);
});

test('at most four unique models are encoded, and invalid ids are skipped',()=>{
 const {query}=encodeArena({models:[LLAMA,LLAMA,'bad id',QWEN,GPT,MIST,'a/b']});
 assert.deepEqual(decodeArena(query).models,[LLAMA,QWEN,GPT,MIST]);
});

test('model search matches every word, ranks name prefixes first and skips embeddings',()=>{
 const models=chatModels(catalog);
 assert.equal(models.length,3);
 assert.deepEqual(filterModels(models,'').items.map((m)=>m.id),[LLAMA,QWEN,GPT]);
 assert.deepEqual(filterModels(models,'openai mini').items.map((m)=>m.id),[GPT]);
 assert.deepEqual(filterModels(models,'QWEN').items.map((m)=>m.id),[QWEN]);
 assert.deepEqual(filterModels(models,'zzz').items,[]);
 const ranked=filterModels([{id:'x/other-gpt',name:'Other GPT'},{id:'y/gpt-x',name:'GPT X'}],'gpt').items.map((m)=>m.id);
 assert.deepEqual(ranked,['y/gpt-x','x/other-gpt']);
 const capped=filterModels(Array.from({length:100},(_,i)=>({id:'a/m'+i,name:'M'+i})),'m',10);
 assert.equal(capped.items.length,10);assert.equal(capped.total,100);
});

test('the cost ceiling adds every model at its catalog price',()=>{
 assert.equal(estimateTokens(''),0);assert.equal(estimateTokens('abcde'),2);
 const c=estimateCeiling([catalog[0],catalog[1]],'x'.repeat(400),1000);
 assert.ok(Math.abs(c-((100*0.1+1000*0.3)+(100*0.05+1000*0.2))/1e6)<1e-12);
 assert.equal(estimateCeiling([],'hi',1000),0);
 assert.equal(estimateCeiling([{id:'free/model'}],'hi',1000),0);
});

test('numbers are formatted for a compact lane',()=>{
 assert.equal(formatMs(412.4),'412 ms');assert.equal(formatMs(1234),'1.23 s');assert.equal(formatMs(NaN),'—');assert.equal(formatMs(null),'—');
 assert.equal(formatUsd(0),'$0');assert.equal(formatUsd(0.000123),'$0.000123');assert.equal(formatUsd(0.1234),'$0.1234');assert.equal(formatUsd(NaN),'—');
 assert.equal(shortId('gen-1790461071-M1D5SJxd7YpD5A'),'gen-1790…7YpD5A');
 assert.equal(shortId('gen-short'),'gen-short');assert.equal(shortId(null),'—');
 assert.equal(receiptHref('gen-1/a b'),'/api/v1/receipts/gen-1%2Fa%20b');
 assert.equal(tokensPerSecond(100,500,2500),50);
 assert.equal(tokensPerSecond(0,500,2500),null);assert.equal(tokensPerSecond(10,null,2500),null);assert.equal(tokensPerSecond(10,3000,2500),null);
});

const done=(patch)=>({...blankLane('a/b'),status:'done',ttft:300,total:2000,cost:0.001,tokens:50,...patch});

test('badges go to the fastest, cheapest and first-token lanes',()=>{
 const w=pickWinners([done({ttft:400,total:3000,cost:0.002}),done({ttft:250,total:2500,cost:0.004}),done({ttft:600,total:1800,cost:0.0005})]);
 assert.deepEqual(w,{first:[1],fastest:[2],cheapest:[2]});
});

test('badges need two clean finishes and skip ties across every lane',()=>{
 const empty={first:[],fastest:[],cheapest:[]};
 assert.deepEqual(pickWinners([done(),blankLane('a/c')]),empty);
 assert.deepEqual(pickWinners([done(),done({status:'error'})]),empty);
 assert.deepEqual(pickWinners([done(),done({partial:true})]),empty);
 assert.deepEqual(pickWinners([done(),done()]),empty,'identical lanes have no winner');
 assert.deepEqual(pickWinners([done({cost:0}),done({cost:0})]).cheapest,[]);
 const shared=pickWinners([done({total:1000}),done({total:1000}),done({total:1500})]);
 assert.deepEqual(shared.fastest,[0,1],'a tie for best shares the badge');
 const partial=pickWinners([done({cost:0.01}),done({cost:0.02}),done({status:'error',cost:0})]);
 assert.deepEqual(partial.cheapest,[0],'a failed lane cannot win');
 assert.deepEqual(pickWinners([done({cost:null,ttft:100}),done({cost:null,ttft:200})]),{first:[0],fastest:[],cheapest:[]});
});

/** A stream stand-in: emits deltas at scripted clock times, then resolves like streamChat does. */
function harness(){
 let t=1000;
 const now=()=>t;
 const at=(ms)=>{t=1000+ms};
 return {now,at};
}

test('a lane measures first-token and total time and reads cost and receipt from the final chunk',async()=>{
 const h=harness();const seen=[];let request;
 const stream=async({key,body,signal,onDelta})=>{
  request={key,body,signal};
  h.at(320);onDelta('Hel');h.at(700);onDelta('Hello there');h.at(1500);
  return {text:'Hello there',usage:{prompt_tokens:12,completion_tokens:42,cost:0.000123},receipt:{id:'gen-1-abc'},provider:'DeepInfra',error:null};
 };
 const ctl=new AbortController();
 const final=await raceLane({model:LLAMA,prompt:'hi',maxTokens:512,key:KEY,signal:ctl.signal,stream,now:h.now,onUpdate:(p)=>seen.push(p)});
 assert.deepEqual(request.body,{model:LLAMA,messages:[{role:'user',content:'hi'}],max_tokens:512});
 assert.equal(request.key,KEY);assert.equal(request.signal,ctl.signal);
 assert.equal(seen[0].status,'waiting');
 assert.deepEqual(seen.filter((p)=>p.status==='streaming').map((p)=>[p.ttft,p.tokens]),[[320,1],[320,3]]);
 assert.equal(final.status,'done');assert.equal(final.ttft,320);assert.equal(final.total,1500);
 assert.equal(final.tokens,42);assert.equal(final.cost,0.000123);assert.equal(final.receiptId,'gen-1-abc');assert.equal(final.provider,'DeepInfra');
 assert.equal(final.partial,false);assert.equal(final.error,'');
});

test('a mid-stream provider failure keeps the billed part and drops out of the badges',async()=>{
 const h=harness();
 const stream=async({onDelta})=>{h.at(100);onDelta('half');h.at(400);return {text:'half',usage:{completion_tokens:2,cost:0.00001},receipt:{id:'gen-2'},error:new Error('upstream closed')}};
 const final=await raceLane({model:QWEN,prompt:'hi',key:KEY,stream,now:h.now});
 assert.equal(final.status,'done');assert.equal(final.partial,true);assert.match(final.error,/billed/);
 assert.equal(final.receiptId,'gen-2');
 assert.deepEqual(pickWinners([{...blankLane(QWEN),...final},done()]).fastest,[]);
});

test('a failing lane ends as an error and never rejects, so the other lanes keep racing',async()=>{
 const h=harness();
 const boom=async()=>{h.at(90);const e=new Error('This key has no balance. Deposit USDG to its key hash or pay per call.');e.type='insufficient_credits';e.status=402;throw e};
 const bad=await raceLane({model:LLAMA,prompt:'hi',key:KEY,stream:boom,now:h.now});
 assert.equal(bad.status,'error');assert.equal(bad.errorType,'insufficient_credits');assert.equal(bad.total,90);assert.equal(bad.ttft,null);assert.match(bad.error,/no balance/);
 const ok=async({onDelta})=>{h.at(200);onDelta('ok');h.at(300);return {text:'ok',usage:{completion_tokens:1,cost:0.1},receipt:{id:'gen-3'}}};
 const [a,b]=await Promise.all([raceLane({model:LLAMA,prompt:'hi',key:KEY,stream:boom,now:h.now}),raceLane({model:QWEN,prompt:'hi',key:KEY,stream:ok,now:h.now})]);
 assert.equal(a.status,'error');assert.equal(b.status,'done');
});

test('stopping a race marks the lane stopped and keeps what had streamed',async()=>{
 const h=harness();const ctl=new AbortController();
 const stream=({signal,onDelta})=>new Promise((_,reject)=>{
  h.at(150);onDelta('abcdefgh');
  signal.addEventListener('abort',()=>{h.at(900);reject(Object.assign(new Error('aborted'),{name:'AbortError'}))});
 });
 const run=raceLane({model:GPT,prompt:'hi',key:KEY,signal:ctl.signal,stream,now:h.now});
 ctl.abort();
 const final=await run;
 assert.equal(final.status,'stopped');assert.equal(final.ttft,150);assert.equal(final.total,900);assert.equal(final.tokens,2);assert.match(final.error,/Stopped/);
});

test('a missing usage block falls back to an estimate and no cost',async()=>{
 const final=await raceLane({model:LLAMA,prompt:'hi',key:KEY,now:()=>0,stream:async({onDelta})=>{onDelta('twelve chars');return {text:'twelve chars',usage:null,receipt:null}}});
 assert.equal(final.status,'done');assert.equal(final.tokens,3);assert.equal(final.cost,null);assert.equal(final.receiptId,null);
});
