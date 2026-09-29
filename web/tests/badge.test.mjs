import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {badgeSnippet,badgeImage} from '../lib/registry.js';

// public/badge.js is a plain script for other people's pages. Load it the way a page would, without a DOM, and test
// the part that decides what it may say.
const source=fs.readFileSync(new URL('../public/badge.js',import.meta.url),'utf8');
const sandbox={};sandbox.window=sandbox;vm.runInNewContext(source,sandbox);
const {evaluate,shareText}=sandbox.AnyrouteBadge;

const NOW=Date.parse('2026-09-29T12:00:00Z');
const iso=(msAgo)=>new Date(NOW-msAgo).toISOString();
const DIGESTS={compose_hash:'1a2b3c4d'+'0'.repeat(56)};
const POLICY='sha256:'+'55'.repeat(32);
const entry=(o={})=>({provider:'alpha',status:'attested',measurement:{digests:DIGESTS},fresh:{'7d':{share:0.99876,observed_ms:7*86_400_000,history_complete:true}},...o});
const summary=(o={})=>({generated_at:iso(10_000),fresh_within_ms:45*60_000,providers:[entry()],...o});
const record=(o={})=>({status:'attested',attested_at:iso(5*60_000),measurement:DIGESTS,policy_hash:POLICY,...o});
const input=(o={})=>({cls:'attested',provider:'alpha',summary:summary(),record:record(),...o});

test('attested only when every check passes, with the measurement, policy hash and share',()=>{
 const v=evaluate(input(),NOW);
 assert.equal(v.state,'attested');
 assert.deepEqual([...v.facts],['measure 1a2b3c4d','policy 55555555','99.8% of 7 d']);
 assert.ok(v.checks.length>=5&&v.checks.every((c)=>c.ok));
});

test('a share is truncated, never rounded up, and a short record says how short',()=>{
 assert.equal(shareText(0.99999),'99.9%');assert.equal(shareText(1),'100%');
 const s=summary({providers:[entry({fresh:{'7d':{share:1,observed_ms:30*3_600_000,history_complete:false}}})]});
 assert.equal(evaluate(input({summary:s}),NOW).facts.at(-1),'100% of 30 h');
 const early=summary({providers:[entry({fresh:{'7d':{share:1,observed_ms:600_000,history_complete:false}}})]});
 assert.ok(!evaluate(input({summary:early}),NOW).facts.some((f)=>f.includes('%')));
});

test('a stale, old, missing or contradicting record reads Unverified, never Attested',()=>{
 const cases={
  'attestation older than the freshness window':input({record:record({attested_at:iso(60*60_000)})}),
  'record not attested':input({record:record({status:'unverified'})}),
  'summary disagrees':input({summary:summary({providers:[entry({status:'unverified'})]})}),
  'provider missing from summary':input({summary:summary({providers:[]})}),
  'summary read long ago':input({summary:summary({generated_at:iso(30*60_000)})}),
  'no summary at all':input({summary:null}),
  'measurement differs':input({record:record({measurement:{compose_hash:'ff'.repeat(32)}})}),
  'malformed policy hash':input({record:record({policy_hash:'sha256:abc'})}),
  'router not reached':{error:'router not reached'},
  'unknown endpoint':{cls:null},
 };
 for(const [name,i] of Object.entries(cases)){const v=evaluate(i,NOW);assert.equal(v.state,'unverified',name);assert.equal(v.label,'Unverified',name);assert.ok(!v.facts.some((f)=>/measure|policy [0-9a-f]/.test(f)),name)}
});

test('policy and vendor-forwarded are shown as such, with no digests',()=>{
 for(const cls of ['policy','vendor-forwarded']){const v=evaluate(input({cls}),NOW);assert.equal(v.state,cls);assert.deepEqual([...v.facts],['no fresh attestation'])}
});

test('a model badge needs the model object, its endpoint and the record to name the same policy hash',()=>{
 const model={id:'m/x',attestation:{best:'attested',policy_hash:POLICY}};
 const endpoint={provider_slug:'alpha',disclosure:'attested',policy_hash:POLICY};
 assert.equal(evaluate(input({model,endpoint}),NOW).state,'attested');
 assert.equal(evaluate(input({model,endpoint:{...endpoint,policy_hash:'sha256:'+'66'.repeat(32)}}),NOW).state,'unverified');
 assert.equal(evaluate(input({model:{...model,attestation:{best:'attested',policy_hash:null}},endpoint}),NOW).state,'unverified');
 assert.equal(evaluate(input({model,endpoint,record:record({policy_hash:null})}),NOW).state,'unverified');
 assert.equal(evaluate(input({model:{...model,attestation:{best:'policy',policy_hash:null}},endpoint}),NOW).state,'unverified');
});

test('the script is small, has no dependency and loads nothing but the router API',()=>{
 assert.ok(source.length<16_000,`badge.js is ${source.length} bytes`);
 const code=source.replace(/^\/\*![\s\S]*?\*\//,'');
 assert.doesNotMatch(code,/\bimport\b\s|require\(|<script|eval\(|innerHTML|new Function/);
 for(const m of source.matchAll(/"(\/api\/v1\/[^"]*)"/g))assert.match(m[1],/^\/api\/v1\/(attestation|disclosure|models)/);
 for(const c of new Set([...source.matchAll(/#[0-9a-f]{6}\b/gi)].map((m)=>m[0].toLowerCase())))assert.ok(['#f5f5f0','#0b0c0b','#5b605a','#979d96','#0a7d31','#1fe15a'].includes(c),c);
 assert.doesNotMatch(source,/—/);
});

test('the embed snippets point at the router the page is served from',()=>{
 assert.equal(badgeSnippet('https://anyroute.example','alpha','dark'),'<script src="https://anyroute.example/badge.js" data-endpoint="alpha" data-theme="dark" async></script>');
 assert.equal(badgeImage('https://anyroute.example','meta-llama/llama-3.3-70b'),'<img src="https://anyroute.example/api/v1/badge/meta-llama/llama-3.3-70b.svg" alt="Anyroute attestation status" height="48">');
 assert.match(badgeSnippet('https://a.example','x"><b>'),/data-endpoint="x&quot;&gt;&lt;b&gt;"/);
});
