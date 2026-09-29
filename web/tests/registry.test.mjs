import test from 'node:test';
import assert from 'node:assert/strict';
import {HISTORY_QUERY,badgeMarkdown,describeHistory,describeRegistry,measurementVersions,registryHref,registryIdFrom,versionOf} from '../lib/registry.js';

const NOW=Date.parse('2026-09-29T12:00:00Z');
const at=(min)=>new Date(NOW-min*60_000).toISOString();
const A='sha256:'+'aa'.repeat(32),B='sha256:'+'bb'.repeat(32);
const ev=(min,o={})=>({id:min,kind:'attestation',at:at(min),ok:true,simulated:false,measurements:{compose_hash:B},measurement_changed:false,verifiers:['dcap'],reason:null,...o});

test('the entry id comes from /registry/<id>/, then ?p=, and only a valid id counts',()=>{
 assert.equal(registryIdFrom('/registry/alpha/',''),'alpha');
 assert.equal(registryIdFrom('/registry/_/','?p=beta'),'beta');
 assert.equal(registryIdFrom('/registry/_/',''),'');
 assert.equal(registryIdFrom('/registry/%3Cb%3E/',''),'');
 assert.equal(registryIdFrom('/registry/_/','?p=../x'),'');
 assert.equal(registryHref('alpha'),'/registry/alpha/');
 assert.equal(HISTORY_QUERY,'?kind=attestation&limit=200');
});

test('the list puts attested first and shows a measurement only where one is current',()=>{
 const summary={generated_at:at(0),history_days:30,providers:[
  {provider:'zed',name:'Zed',status:'unverified',reason:'attestation_stale',measurement:{digests:{compose_hash:A}},fresh:{'7d':{share:0.5,observed_ms:7*86_400_000,history_complete:true,buckets:[]}},history_since:at(9000)},
  {provider:'alpha',name:'Alpha',status:'attested',measurement:{digests:{compose_hash:B}},measurement_changes_7d:[{at:at(60),changed:['compose_hash']}],last_measurement_change:{at:at(60),changed:['compose_hash']},fresh:{'7d':{share:0.99951,observed_ms:7*86_400_000,history_complete:true,buckets:[]}},history_since:at(9000)},
 ]};
 const rows=describeRegistry(summary,NOW);
 assert.deepEqual(rows.map((r)=>r.id),['alpha','zed']);
 assert.equal(rows[0].share,'99.9%');
 assert.match(rows[0].version,/^sha256:bbbb/);
 assert.equal(rows[0].changes7d,1);
 assert.equal(rows[1].version,'');
 assert.equal(rows[1].versionNote,'No current measurement');
 assert.equal(rows[0].href,'/registry/alpha/');
});

test('the history folds identical runs, keeps every failure and change on its own line',()=>{
 const events=[ev(0),ev(15),ev(30),ev(45,{ok:false,measurements:null,reason:{code:'quote_rejected',message:'The quote was rejected.'}}),ev(60),ev(75,{measurement_changed:true}),ev(90,{measurements:{compose_hash:A}}),ev(105,{measurements:{compose_hash:A}})];
 const spans=describeHistory(events,NOW);
 assert.deepEqual(spans.map((s)=>[s.kind,s.count]),[['passed',3],['failed',1],['passed',1],['changed',1],['passed',2]]);
 assert.equal(spans[0].title,'3 checks passed');
 assert.equal(spans[1].text,'The quote was rejected.');
 assert.ok(spans[3].digests.some((d)=>d.key==='compose_hash'&&d.value===B));
 assert.ok(!describeHistory([{kind:'probe',at:at(1),ok:true}],NOW).length,'only attestation runs');
});

test('measurement versions list each verified digest once, newest first; simulated and failed runs do not count',()=>{
 const v=measurementVersions([ev(0),ev(15),ev(30,{simulated:true,measurements:{compose_hash:'sha256:'+'cc'.repeat(32)}}),ev(45,{ok:false}),ev(90,{measurements:{compose_hash:A}})]);
 assert.deepEqual(v.map((x)=>[x.version,x.runs]),[[B,2],[A,1]]);
 assert.equal(v[0].first,at(15));assert.equal(v[0].last,at(0));
 assert.equal(versionOf({image_digest:A}),A);assert.equal(versionOf(null),'');
});

test('the Markdown badge links a provider to its entry and a model to the registry',()=>{
 assert.equal(badgeMarkdown('https://r.example','alpha'),'[![Anyroute attestation status](https://r.example/api/v1/badge/alpha.svg)](https://r.example/registry/alpha/)');
 assert.equal(badgeMarkdown('https://r.example','m/x'),'[![Anyroute attestation status](https://r.example/api/v1/badge/m/x.svg)](https://r.example/registry/)');
});
