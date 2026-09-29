import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LIMITS,createBody,envSnippet,formatAgo,formatDuration,formatUsd,routeOptions,sampleSessions,secondsLeft,spendShare,statusMeta,timeShare,validateForm,withDeadlines} from '../components/features/agent-sessions.js';

test('status labels cover every API status and unknown values stay visible',()=>{
 assert.deepEqual(statusMeta('active'),{label:'Active',tone:'active'});
 assert.equal(statusMeta('ended').label,'Ended');
 assert.equal(statusMeta('expired').tone,'stopped');
 assert.equal(statusMeta('budget_exhausted').label,'Budget spent');
 assert.equal(statusMeta('paused').label,'paused');
});

test('money, durations and relative times read at agent scale',()=>{
 assert.equal(formatUsd(0),'$0.00');assert.equal(formatUsd(12.5),'$12.50');assert.equal(formatUsd(0.4182),'$0.4182');assert.equal(formatUsd(0.000004),'$0.000004');
 assert.equal(formatDuration(-3),'0s');assert.equal(formatDuration(42),'42s');assert.equal(formatDuration(725),'12m 05s');assert.equal(formatDuration(3*3600+7*60+59),'3h 07m');
 const now=Date.parse('2026-09-28T12:00:00Z');
 assert.equal(formatAgo(null,now),'No calls yet');
 assert.equal(formatAgo('2026-09-28T11:59:58Z',now),'just now');
 assert.equal(formatAgo('2026-09-28T11:59:30Z',now),'30s ago');
 assert.equal(formatAgo('2026-09-28T11:56:00Z',now),'4m ago');
 assert.equal(formatAgo('2026-09-28T09:00:00Z',now),'3h ago');
 assert.equal(formatAgo('2026-09-25T12:00:00Z',now),'3d ago');
});

test('the spend bar never exceeds 100% and shows in-flight holds after settled spend',()=>{
 assert.deepEqual(spendShare(0.5,0.1,1),{spent:50,reserved:10});
 assert.deepEqual(spendShare(1.2,0.1,1),{spent:100,reserved:0});
 const near=spendShare(0.95,0.2,1);assert.ok(Math.abs(near.spent-95)<1e-9&&Math.abs(near.spent+near.reserved-100)<1e-9);
 assert.deepEqual(spendShare(1,0,0),{spent:0,reserved:0});
 assert.equal(timeShare('2026-09-28T12:00:00Z','2026-09-28T13:00:00Z',1800),50);
 assert.equal(timeShare('2026-09-28T12:00:00Z','2026-09-28T13:00:00Z',0),100);
});

test('countdowns run on this device from the server time_left_s, so clock skew does not matter',()=>{
 const [s]=withDeadlines([{id:'as_1',time_left_s:90}],1_000_000);
 assert.equal(s.deadline,1_090_000);
 assert.equal(secondsLeft(s.deadline,1_000_000),90);
 assert.equal(secondsLeft(s.deadline,1_089_500),0);
 assert.equal(secondsLeft(s.deadline,2_000_000),0);
});

test('form validation mirrors the API limits and the body omits empty optional fields',()=>{
 assert.equal(validateForm({name:'run',budget:'1',ttl:'60'}),'');
 assert.equal(validateForm({budget:String(LIMITS.maxBudget),ttl:String(LIMITS.maxTtl)}),'');
 for(const budget of ['','0','-1','1000.5','abc'])assert.match(validateForm({budget,ttl:'60'}),/budget/);
 for(const ttl of ['','0','1441','1.5'])assert.match(validateForm({budget:'1',ttl}),/time limit/);
 assert.match(validateForm({name:'x'.repeat(81),budget:'1',ttl:'5'}),/name/);
 assert.deepEqual(createBody({name:'  ',budget:'0.25',ttl:'15'}),{budget_usd:0.25,ttl_minutes:15});
 assert.deepEqual(createBody({name:' crawler ',budget:'2',ttl:'60',models:['a/b','@route/fast','a/b']}),{budget_usd:2,ttl_minutes:60,name:'crawler',allowed_models:['a/b','@route/fast']});
});

test('the env snippet carries the key and the API base, nothing else',()=>{
 assert.equal(envSnippet('sk-x','https://r.example/'),'ANYROUTE_API_KEY=sk-x\nANYROUTE_BASE_URL=https://r.example/api/v1');
 assert.equal(envSnippet('sk-x',''),'ANYROUTE_API_KEY=sk-x\nANYROUTE_BASE_URL=/api/v1');
});

test('saved routes are optional and malformed rows are skipped',()=>{
 assert.deepEqual(routeOptions({data:[{slug:'fast',name:'Fast lane'},{slug:'cheap'},{slug:'Bad Slug'},null,{name:'no slug'}]}),[{id:'@route/fast',name:'Fast lane'},{id:'@route/cheap',name:'cheap'}]);
 assert.deepEqual(routeOptions(null),[]);
 assert.deepEqual(routeOptions({error:{code:404}}),[]);
});

test('sample sessions are labelled as samples and carry no key material or real receipts',()=>{
 const all=sampleSessions(Date.parse('2026-09-28T12:00:00Z'));
 assert.ok(all.length>=2);
 for(const s of all){
  assert.equal(s.sample,true);assert.match(s.name,/sample/i);assert.doesNotMatch(JSON.stringify(s),/sk-ar-v1-/);
  for(const c of s.recent_calls){assert.equal(c.receipt,false);assert.match(c.id,/^sample-/);assert.match(c.provider,/^Sample provider/);}
 }
 assert.deepEqual([...new Set(all.map((s)=>s.status))].sort(),['active','budget_exhausted','ended']);
});

test('the tab refreshes every 5 s only while visible and never calls the API in sample mode',()=>{
 const src=fs.readFileSync(new URL('../components/features/AgentSessions.jsx',import.meta.url),'utf8');
 assert.match(src,/visibilityState !== "visible"/);
 assert.match(src,/setInterval\(tick, REFRESH_MS\)/);
 assert.match(src,/if \(!live\) return <SampleView \/>;/);
 // The sample view is defined without any API access.
 const sample=src.slice(src.indexOf('function SampleView'),src.indexOf('export default function AgentSessions'));
 assert.doesNotMatch(sample,/\bapi\(/);
 assert.match(src,/\/api\/v1\/routes/);
});
