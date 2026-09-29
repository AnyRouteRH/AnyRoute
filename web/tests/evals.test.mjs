import test from 'node:test';
import assert from 'node:assert/strict';
import {
 CHECKS,LIMITS,JUDGE_MAX_TOKENS,normalizeCase,caseProblem,paramsProblem,parseCSV,csvCell,casesFromCSV,casesFromJSON,importCases,casesToCSV,setToJSON,fileSlug,
 compileRegex,parseJSONText,jsonContains,scoreOutput,judgeMessages,judgeRequest,parseJudge,estTokens,priceOf,callCost,judgeInputTokens,estimateRun,buildRequest,
 readCompletion,routeOptions,sleep,retryDelayMs,createGate,withRetry,runPool,resultKey,percentile,summarize,runToJSON,runToCSV,
 STORE_KEY,starterState,restoreState,loadState,saveState,
} from '../lib/evals.js';

const close=(a,b,eps=1e-12)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
const memory=(init={})=>{const m=new Map(Object.entries(init));return{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>void m.set(k,String(v)),map:m};};

test('cases are normalized: defaults, aliases, id collisions and limits',()=>{
 const taken=new Set();
 assert.deepEqual(normalizeCase({id:'a',prompt:'Hi',expected:'Hello',check:' Exact '},taken),{id:'a',prompt:'Hi',expected:'Hello',check:'exact'});
 const dup=normalizeCase({id:'a',prompt:'Again'},taken);assert.notEqual(dup.id,'a');assert.equal(dup.check,'none');assert.equal('expected' in dup,false);
 assert.equal(normalizeCase({prompt:'x',expected:'y'}).check,'contains','an expected value without a check defaults to contains');
 assert.equal(normalizeCase({input:'from alias',answer:'ignored'}).prompt,'from alias');
 assert.equal(normalizeCase('bare prompt').prompt,'bare prompt');
 assert.equal(normalizeCase({prompt:'j',expected:{a:1},check:'json'}).expected,'{"a":1}');
 assert.equal('expected' in normalizeCase({prompt:'p',expected:'   '}),false,'whitespace-only expected is empty');
 assert.throws(()=>normalizeCase({prompt:'  '}),/prompt is empty/);
 assert.throws(()=>normalizeCase({prompt:'p',check:'fuzzy'}),/unknown check "fuzzy"/);
 assert.throws(()=>normalizeCase({prompt:'x'.repeat(LIMITS.promptChars+1)}),/longer than/);
 assert.throws(()=>normalizeCase([1]),/object with a prompt/);
});

test('case problems block a run with a specific message',()=>{
 assert.equal(caseProblem({prompt:'',check:'none'}),'Add a prompt.');
 assert.equal(caseProblem({prompt:'p',check:'exact'}),'Add the expected text for this check.');
 assert.equal(caseProblem({prompt:'p',check:'regex',expected:''}),'Add the pattern this check matches.');
 assert.match(caseProblem({prompt:'p',check:'regex',expected:'(['}),/^The regex does not compile/);
 assert.match(caseProblem({prompt:'p',check:'json',expected:'{nope'}),/valid JSON/);
 assert.equal(caseProblem({prompt:'p',check:'json'}),null,'json without expected only requires JSON output');
 assert.equal(caseProblem({prompt:'p',check:'none'}),null);
 assert.equal(paramsProblem({temperature:0.7,maxTokens:1024}),null);
 assert.match(paramsProblem({temperature:2.5,maxTokens:10}),/temperature/);
 assert.match(paramsProblem({temperature:0,maxTokens:1025}),/max tokens from 1 to 1024/);
 assert.match(paramsProblem({temperature:0,maxTokens:1.5}),/max tokens/);
});

test('CSV parsing handles quotes, embedded newlines, CRLF, BOM, blank lines and other delimiters',()=>{
 assert.deepEqual(parseCSV('﻿a,b\r\n"x, y","say ""hi"""\n\n"multi\nline",\n'),[['a','b'],['x, y','say "hi"'],['multi\nline','']]);
 assert.deepEqual(parseCSV('prompt;expected\nq;a'),[['prompt','expected'],['q','a']]);
 assert.deepEqual(parseCSV('prompt\texpected\nq\ta'),[['prompt','expected'],['q','a']]);
 assert.deepEqual(parseCSV('only'),[['only']]);
 assert.throws(()=>parseCSV('"never closed'),/never closed/);
 assert.equal(csvCell('plain'),'plain');assert.equal(csvCell('a,b'),'"a,b"');assert.equal(csvCell('say "x"'),'"say ""x"""');assert.equal(csvCell(' pad'),'" pad"');
 assert.equal(csvCell('=SUM(A1)',{neutralize:true}),"'=SUM(A1)");assert.equal(csvCell(-5,{neutralize:true}),'-5','numbers are never altered');
 assert.equal(csvCell('=x'),'=x','eval-set exports keep prompts verbatim');
});

test('CSV import maps headers (with aliases), reports bad rows by line and round-trips exports',()=>{
 const out=casesFromCSV('Question,Expected Output,check,notes\n"What is 2+2?",4,exact,x\n,missing,none,\nHi,,,\n');
 assert.equal(out.cases.length,2);assert.deepEqual(out.cases[0].prompt,'What is 2+2?');assert.equal(out.cases[0].expected,'4');assert.equal(out.cases[0].check,'exact');
 assert.equal(out.cases[1].check,'none');assert.deepEqual(out.errors,['Row 3: the prompt is empty.']);
 const positional=casesFromCSV('Say hi,hi,contains\n');assert.deepEqual(positional.cases.map(c=>[c.prompt,c.expected,c.check]),[['Say hi','hi','contains']]);
 const cases=[{id:'one',prompt:'Line 1\nLine 2, with "quotes"',expected:'=1+1',check:'exact'},{id:'two',prompt:'-leading dash',check:'none'}];
 assert.deepEqual(casesFromCSV(casesToCSV(cases)).cases,cases);
 assert.deepEqual(casesFromCSV('').errors,['The CSV file has no rows.']);
});

test('JSON import accepts arrays, {name, cases}, prompt strings and JSON Lines, and caps a set at 200',()=>{
 const named=casesFromJSON(JSON.stringify({name:'  Support  ',cases:[{prompt:'a'},{prompt:'b',expected:'B',check:'exact'}]}));
 assert.equal(named.name,'Support');assert.equal(named.cases.length,2);assert.deepEqual(named.errors,[]);
 assert.deepEqual(casesFromJSON('["one","two"]').cases.map(c=>c.prompt),['one','two']);
 assert.deepEqual(casesFromJSON('{"prompt":"a"}\n{"prompt":"b","check":"json"}\n').cases.map(c=>c.check),['none','json']);
 assert.deepEqual(casesFromJSON('{"prompt":"single"}').cases.map(c=>c.prompt),['single']);
 assert.match(casesFromJSON('{"foo":1}').errors[0],/array of cases/);
 assert.match(casesFromJSON('{oops').errors[0],/Not valid JSON/);
 const many=casesFromJSON(JSON.stringify(Array.from({length:205},(_,i)=>({id:'c'+i,prompt:'p'+i}))));
 assert.equal(many.cases.length,200);assert.match(many.errors.at(-1),/first 200 cases.*5 more were skipped/);
 assert.deepEqual(casesFromJSON('[{"prompt":""},{"prompt":"ok"}]').errors,['Case 1: the prompt is empty.']);
 assert.equal(importCases('[{"prompt":"x"}]','set.json').cases.length,1);
 assert.equal(importCases('prompt\nx','set.csv').cases.length,1);
 assert.equal(importCases('  [{"prompt":"x"}]','noext').cases.length,1,'sniffs JSON without an extension');
 const exported=setToJSON({name:'S',cases:[{id:'a',prompt:'p',expected:'',check:'none'}]});
 assert.equal(exported.format,'anyroute.evalset');assert.deepEqual(exported.cases,[{id:'a',prompt:'p',check:'none'}]);
 assert.deepEqual(casesFromJSON(JSON.stringify(exported)).cases,exported.cases);
 assert.equal(fileSlug('My Set: v2!'),'my-set-v2');assert.equal(fileSlug('***'),'eval');
});

test('scoring: exact, contains, regex, json and none',()=>{
 const s=(output,c)=>scoreOutput(output,c).pass;
 assert.equal(s('  391\r\n',{check:'exact',expected:'391'}),true,'exact trims and normalizes line endings');
 assert.equal(s('391.',{check:'exact',expected:'391'}),false);
 assert.equal(s('canberra',{check:'exact',expected:'Canberra'}),false,'exact is case-sensitive');
 assert.equal(s('It is CANBERRA.',{check:'contains',expected:'canberra'}),true,'contains ignores case');
 assert.equal(s('Sydney',{check:'contains',expected:'Canberra'}),false);
 assert.equal(s('1969-07-20\n',{check:'regex',expected:'/^1969-07-20$/'}),true);
 assert.equal(s('ANSWER: yes',{check:'regex',expected:'/answer: yes/i'}),true,'flags from /…/i are honoured');
 assert.equal(s('abc',{check:'regex',expected:'^\\d+$'}),false);
 const re=compileRegex('/a/gy');assert.equal(re.flags,'');assert.equal(re.test('a'),true);assert.equal(re.test('a'),true,'no lastIndex state between tests');
 assert.deepEqual(scoreOutput('x',{check:'regex',expected:'(['}).pass,null,'an invalid pattern is not scored');
 assert.equal(s('```json\n{"city":"Paris","country":"France","extra":1}\n```',{check:'json',expected:'{"city":"Paris"}'}),true,'fenced JSON with extra keys contains the expected fields');
 assert.equal(s('{"city":"Lyon"}',{check:'json',expected:'{"city":"Paris"}'}),false);
 assert.equal(s('Here you go: {"a":1}',{check:'json'}),false,'the whole output must be JSON');
 assert.equal(s('[1,2]',{check:'json'}),true);
 assert.equal(scoreOutput('{}',{check:'json',expected:'{bad'}).pass,null);
 assert.equal(s('anything',{check:'none',expected:'x'}),null);
 assert.equal(s('anything',{check:'contains'}),null,'no expected value is not scored');
 assert.equal(parseJSONText('```\n[1]\n```').ok,true);
 assert.equal(jsonContains({a:[{b:1,c:2}]},{a:[{b:1}]}),true);assert.equal(jsonContains({a:[1,2]},{a:[1]}),false,'arrays match exactly');
 assert.equal(jsonContains({a:null},{a:null}),true);assert.equal(jsonContains({},{a:undefined}),false);assert.equal(jsonContains([1],{0:1}),false);
 assert.deepEqual(CHECKS,['none','exact','contains','regex','json']);
});

test('judge prompts delimit the data and replies are parsed robustly',()=>{
 const msgs=judgeMessages({rubric:'Be strict.',prompt:'Q?',expected:'A',output:'x'.repeat(13000)});
 assert.equal(msgs[0].role,'system');assert.match(msgs[0].content,/"score": <integer 1-5>/);
 assert.match(msgs[1].content,/^RUBRIC:\nBe strict\.\n\n<prompt>\nQ\?\n<\/prompt>\n\n<reference>\nA\n<\/reference>\n\n<response>\n/);
 assert.match(msgs[1].content,/\[… 1000 more characters not shown\]\n<\/response>$/);
 assert.doesNotMatch(judgeMessages({rubric:'r',prompt:'p',output:'o'})[1].content,/<reference>/);
 const req=judgeRequest({model:'m/j',rubric:'r'},{prompt:'p'},'o');assert.equal(req.model,'m/j');assert.equal(req.temperature,0);assert.equal(req.max_tokens,JUDGE_MAX_TOKENS);
 const cases=[
  ['{"score": 4, "reason": "Correct but verbose."}',4,'Correct but verbose.'],
  ['```json\n{"score":"5","rationale":"Exact."}\n```',5,'Exact.'],
  ['Sure! Here is my verdict: {"rating": 2, "explanation": "Misses the {key} part"} Thanks.',2,'Misses the {key} part'],
  ['Score: 3/5 - partially right.',3,'partially right.'],
  ['I would rate this 4 out of 5; it is mostly correct.',4,'I would rate this ; it is mostly correct.'],
  ['5\nPerfect answer.',5,'Perfect answer.'],
  ['{score: 1, reason: "unquoted keys"}',1,'unquoted keys'],
  ['{"score": 3.6, "reason": "rounds"}',4,'rounds'],
 ];
 for(const [reply,score,reason] of cases){const got=parseJudge(reply);assert.equal(got.score,score,reply);assert.equal(got.reason,reason,reply);}
 assert.deepEqual(parseJudge('{"score": 9, "reason": "too high"}'),{score:null,reason:'too high'});
 assert.equal(parseJudge('{"score": 0}').score,null);assert.match(parseJudge('{"score": 0}').reason,/outside 1–5/);
 assert.equal(parseJudge('10/10 brilliant').score,null);
 assert.equal(parseJudge('No idea.').score,null);assert.match(parseJudge('No idea.').reason,/Could not read/);
 assert.equal(parseJudge('').reason,'The judge returned no text.');
 assert.ok(parseJudge('{"score":2,"reason":"'+'x'.repeat(400)+'"}').reason.length<=240);
});

test('cost estimate: chars/4 prompt tokens plus max_tokens of output, royalties, routes and the judge',()=>{
 const models=[{id:'a/cheap',price:1,output:2},{id:'b/royal',price:3,output:4,royaltyBps:500},{id:'c/pricey',price:10,output:20}];
 const routes=[{id:'@route/fast',models:['a/cheap','b/royal']},{id:'@route/ghost',models:['a/cheap','z/unknown']}];
 const catalog={models,routes};
 assert.equal(estTokens('abcde'),2);assert.equal(estTokens(''),0);
 assert.deepEqual(priceOf('a/cheap',catalog),{prompt:1e-6,completion:2e-6,royaltyBps:0,basis:'catalog'});
 const route=priceOf('@route/fast',catalog);assert.equal(route.basis,'route');close(route.prompt,3e-6);close(route.completion,4e-6);assert.equal(route.royaltyBps,500);
 const ghost=priceOf('@route/ghost',catalog);assert.equal(ghost.basis,'assumed');close(ghost.completion,20e-6);
 assert.equal(priceOf('x/y',catalog).basis,'assumed');assert.equal(priceOf('x/y',{}).basis,'unknown');
 close(callCost({prompt:1e-6,completion:2e-6,royaltyBps:500},100,50),(100e-6+100e-6)*1.05);
 const cases=[{prompt:'x'.repeat(40)},{prompt:'y'.repeat(7)}]; // 10 and 2 tokens
 const est=estimateRun({cases,candidates:['a/cheap','b/royal'],maxTokens:100,catalog});
 close(est.perCandidate[0].cost,(10*1e-6+100*2e-6)+(2*1e-6+100*2e-6));
 close(est.perCandidate[1].cost,((10*3e-6+100*4e-6)+(2*3e-6+100*4e-6))*1.05);
 assert.equal(est.calls,4);assert.equal(est.judgeCalls,0);assert.equal(est.judgeCost,0);close(est.total,est.candidatesCost);
 const judged=estimateRun({cases,candidates:['a/cheap','b/royal'],maxTokens:100,catalog,judge:{model:'c/pricey',rubric:'Be fair.'}});
 const jt=cases.map(c=>judgeInputTokens('Be fair.',c,100));
 assert.ok(jt[0]>100+10,'judge input includes the template, the prompt and the output at max_tokens');
 close(judged.judgeCost,2*((jt[0]*10e-6+JUDGE_MAX_TOKENS*20e-6)+(jt[1]*10e-6+JUDGE_MAX_TOKENS*20e-6)));
 assert.equal(judged.judgeCalls,4);close(judged.total,judged.candidatesCost+judged.judgeCost);
 assert.equal(estimateRun({cases,candidates:['a/cheap'],maxTokens:5000,catalog}).maxTokens,1024,'max_tokens is capped at 1024');
});

test('requests, completions and saved routes are read defensively',()=>{
 assert.deepEqual(buildRequest('@route/fast','Hi',{temperature:'0.5',maxTokens:4096}),{model:'@route/fast',messages:[{role:'user',content:'Hi'}],temperature:0.5,max_tokens:1024});
 const full=readCompletion({id:'gen-1',model:'m/x',provider:'P',choices:[{message:{content:'Hello'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2,cost:0.00012},receipt:{id:'gen-1',sig:'c2ln',key_id:'k1',alg:'Ed25519',payload:{v:1},leaf:'0x'}});
 assert.deepEqual(full,{output:'Hello',finish:'stop',id:'gen-1',model:'m/x',provider:'P',promptTokens:5,completionTokens:2,cost:0.00012,receipt:{id:'gen-1',sig:'c2ln',key_id:'k1',payload:{v:1}}});
 assert.equal(readCompletion({choices:[{message:{content:[{type:'text',text:'a'},'b']}}]}).output,'ab');
 assert.equal(readCompletion({choices:[{text:'legacy'}]}).output,'legacy');
 const empty=readCompletion(null);assert.equal(empty.output,'');assert.equal(empty.cost,0);assert.equal(empty.receipt,null);
 assert.deepEqual(routeOptions({data:[{slug:'fast',name:'Fast lane',config:{models:['a/x','b/y']}},{slug:'fast'},{slug:'bad slug'},{slug:'solo',model:'c/z'},null]}),[
  {id:'@route/fast',slug:'fast',label:'Fast lane',models:['a/x','b/y']},{id:'@route/solo',slug:'solo',label:'solo',models:['c/z']},
 ]);
 assert.deepEqual(routeOptions(null),[]);assert.deepEqual(routeOptions({data:{routes:[{slug:'r'}]}}).map(r=>r.id),['@route/r']);
});

test('429 waits follow Retry-After, the router metadata, the message, then backoff',()=>{
 assert.equal(retryDelayMs({retryAfter:'7'}),7000);
 assert.equal(retryDelayMs({headers:new Headers({'retry-after':'2'})}),2000);
 const now=Date.parse('2026-09-28T12:00:00Z');assert.equal(retryDelayMs({retryAfter:'Mon, 28 Sep 2026 12:00:05 GMT'},0,now),5000);
 assert.equal(retryDelayMs({metadata:{retry_after_ms:1500}}),1500);
 assert.equal(retryDelayMs({message:'Rate limit exceeded (60 requests/min). Retry in 3s.'}),3000);
 assert.deepEqual([0,1,2].map(a=>retryDelayMs({},a)),[1000,2000,4000]);
 assert.equal(retryDelayMs({retryAfter:'3600'}),60000);assert.equal(retryDelayMs({retryAfter:'0'}),250);
});

test('retries only 429s, through a shared gate, and stops when cancelled',async()=>{
 let clock=0;const slept=[];const sleeper=async ms=>{slept.push(ms);clock+=ms;};
 const gate=createGate(()=>clock);let calls=0;const retries=[];
 const value=await withRetry(async()=>{calls++;if(calls<3)throw Object.assign(new Error('slow down'),{status:429,metadata:{retry_after_ms:2000}});return 'ok';},{gate,sleeper,onRetry:r=>retries.push(r.attempt)});
 assert.equal(value,'ok');assert.equal(calls,3);assert.deepEqual(retries,[1,2]);assert.deepEqual(slept,[2000,2000]);
 let other=0;await withRetry(async()=>{other++;return 1;},{gate,sleeper});assert.equal(other,1,'a lane after the pause runs immediately');
 gate.hold(1000);const before=clock;await withRetry(async()=>1,{gate,sleeper});assert.equal(clock-before,1000,'other lanes wait out the shared pause');
 let n=0;await assert.rejects(withRetry(async()=>{n++;throw Object.assign(new Error('boom'),{status:500});},{sleeper}),/boom/);assert.equal(n,1,'5xx is never retried');
 let m=0;await assert.rejects(withRetry(async()=>{m++;throw Object.assign(new Error('limit'),{status:429});},{retries:2,sleeper}),/limit/);assert.equal(m,3);
 const ctl=new AbortController();ctl.abort();await assert.rejects(withRetry(async()=>1,{signal:ctl.signal,sleeper}),e=>e.name==='AbortError');
 const c2=new AbortController();const p=sleep(10000,c2.signal);c2.abort();await assert.rejects(p,e=>e.name==='AbortError');
});

test('the pool keeps at most three calls in flight, preserves order and stops on cancel',async()=>{
 let inFlight=0,peak=0;const items=Array.from({length:10},(_,i)=>i);
 const seen=[];
 const out=await runPool(items,async i=>{inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,2+(i%3)*3));inFlight--;if(i===4)throw Object.assign(new Error('bad'),{status:400});return i*2;},{concurrency:3,onResult:(r,i)=>seen.push(i)});
 assert.equal(peak,3);assert.equal(seen.length,10);
 assert.deepEqual(out.map(r=>r.ok?r.value:'x'),[0,2,4,6,'x',10,12,14,16,18]);assert.equal(out[4].cancelled,false);
 const ctl=new AbortController();let started=0;
 const partial=await runPool(items,async(i)=>{started++;if(i===1)ctl.abort();await sleep(5,ctl.signal);return i;},{concurrency:3,signal:ctl.signal});
 assert.equal(started,2,'no new item starts after cancel');
 assert.ok(partial.slice(0,2).every(r=>r&&!r.ok&&r.cancelled));assert.ok(partial.slice(2).every(r=>r===undefined));
 assert.deepEqual(await runPool([],async()=>1),[]);
});

test('summaries: pass rate over checked outputs, nearest-rank p95, actual costs and judge scores',()=>{
 assert.equal(percentile([5,1,3,2,4],95),5);assert.equal(percentile([1,2,3,4,5,6,7,8,9,10],50),5);assert.equal(percentile([],95),null);
 const cases=[{id:'a',prompt:'1',check:'exact',expected:'x'},{id:'b',prompt:'2',check:'none'},{id:'c',prompt:'3',check:'contains',expected:'y'},{id:'d',prompt:'4',check:'exact',expected:'z'}];
 const run={id:'r',status:'complete',startedAt:'2026-09-28T00:00:00Z',set:{name:'S',cases},candidates:[{id:'m/one',label:'One'},{id:'m/two',label:'Two'}],params:{temperature:0,maxTokens:64},judge:{model:'m/j',rubric:'r'},results:{
  [resultKey('a',0)]:{status:'ok',output:'x',pass:true,reason:'Exact match.',latencyMs:100,promptTokens:3,completionTokens:1,cost:0.001,receipt:{id:'gen-a0'},judge:{score:5,reason:'ok',cost:0.0001,receipt:{id:'gen-j'}}},
  [resultKey('b',0)]:{status:'ok',output:'=cmd()',pass:null,latencyMs:300,promptTokens:3,completionTokens:2,cost:0.002,judge:{score:3,cost:0.0001}},
  [resultKey('c',0)]:{status:'ok',output:'no',pass:false,latencyMs:200,promptTokens:3,completionTokens:1,cost:0.001,judge:{status:'error',error:{message:'judge down'}}},
  [resultKey('d',0)]:{status:'error',error:{status:400,message:'bad request'}},
  [resultKey('a',1)]:{status:'ok',output:'x',pass:true,latencyMs:50,promptTokens:2,completionTokens:1,cost:0.0005},
  [resultKey('b',1)]:{status:'cancelled'},
 }};
 const [one,two]=summarize(run);
 assert.equal(one.checked,2);assert.equal(one.passed,1);assert.equal(one.passRate,0.5,'the unchecked case and the errored call are not in the pass rate');
 assert.equal(one.failures,1);assert.equal(one.completed,3);close(one.meanLatency,200);assert.equal(one.p95Latency,300);
 assert.equal(one.promptTokens,9);assert.equal(one.completionTokens,4);close(one.cost,0.004);close(one.judgeCost,0.0002);assert.equal(one.judged,2);assert.equal(one.judgeMean,4);
 assert.equal(two.passRate,1);assert.equal(two.cancelled,1);assert.equal(two.judgeMean,null);
 const json=runToJSON(run);assert.equal(json.format,'anyroute.evalrun');assert.equal(json.results.length,8);assert.equal(json.params.max_tokens,64);
 assert.deepEqual(json.results.find(r=>r.case_id==='c'&&r.candidate==='m/two'),{case_id:'c',candidate:'m/two',status:'not_run'});
 const csv=runToCSV(run);const rows=csv.trim().split('\r\n');assert.equal(rows.length,9);
 assert.match(rows[0],/^case_id,candidate,status,pass,check/);assert.match(rows[1],/^a,m\/one,ok,pass,exact,Exact match\.,5,ok,100,3,1,0\.001,0\.0001,,,gen-a0,gen-j,,1,x,x$/);
 assert.ok(rows.some(r=>r.endsWith(",'=cmd()")),'formula-like model output is neutralized');
 assert.ok(rows.some(r=>r.includes('judge down')));
});

test('browser storage: starter state, validation, unreadable data kept aside, failing storage tolerated',()=>{
 const empty=memory();const first=loadState(empty);assert.equal(first.note,'');assert.equal(first.state.sets[0].cases.length,5);
 assert.ok(first.state.sets[0].cases.every(c=>caseProblem(c)===null),'the starter set is runnable');
 assert.equal(saveState(empty,first.state),true);assert.deepEqual(loadState(empty).state,first.state);
 const broken=memory({[STORE_KEY]:'{"version":1,"sets":[{"id":"x"}]}'});const restored=loadState(broken);
 assert.match(restored.note,/could not be read/);assert.equal(broken.map.get(STORE_KEY+'-unreadable'),'{"version":1,"sets":[{"id":"x"}]}');
 assert.match(loadState(null).note,/unavailable/);
 assert.equal(saveState({setItem(){throw new Error('QuotaExceededError');}},first.state),false);
 const s=starterState();s.activeId='missing';s.config={candidates:['a','b',7],temperature:9,maxTokens:2048,judge:{enabled:true,model:'m/j',rubric:5}};
 const r=restoreState(s);assert.equal(r.activeId,'s_starter');assert.deepEqual(r.config.candidates,['a','b']);assert.equal(r.config.temperature,0);assert.equal(r.config.maxTokens,256);
 assert.equal(r.config.judge.enabled,true);assert.equal(r.config.judge.model,'m/j');assert.match(r.config.judge.rubric,/Score how correct/);
 assert.equal(restoreState({version:1,sets:[{id:'a',name:'n',cases:[{id:'c',prompt:'p',check:'fuzzy'}]}]}),null);
 assert.equal(restoreState({version:2,sets:[]}),null);
});
