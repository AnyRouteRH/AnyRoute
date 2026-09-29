import test from 'node:test';
import assert from 'node:assert/strict';
import {PROVIDERS_PATH,QUICKSTART,attestationOf,describeProviders,filterProviders,verifierLabel} from '../lib/providers.js';

const NOW=Date.parse('2026-09-29T09:00:00Z');
const ago=(min)=>new Date(NOW-min*60_000).toISOString();
const att=(o={})=>({status:'attested',tee:'tdx',verifiers:['dcap','dstack'],last_verified_at:ago(4),last_attempt_at:ago(4),last_attempt_ok:true,...o});
const LIST=[
 {name:'Zeta Cloud',slug:'zeta',status:'live',models:3,data_policy:{training:false,retains_prompts:false},attestation:att()},
 {name:'Alpha',slug:'alpha',status:'live',models:1,data_policy:{training:true,retains_prompts:true},attestation:{status:'unverified',reason:'attestation_stale',tee:'tdx',verifiers:[],last_verified_at:ago(60*24*3),last_attempt_at:ago(3),last_attempt_ok:false}},
 {name:'Never',slug:'never',status:'shadow',models:2,attestation:{status:'unverified',reason:'no_attestation',tee:null,verifiers:[],last_verified_at:null,last_attempt_at:null,last_attempt_ok:null}},
 {name:'Dev box',slug:'devbox',status:'live',models:1,attestation:{status:'simulated',tee:'dev',verifiers:[],last_verified_at:ago(1),last_attempt_ok:true}},
 {name:'Beta',slug:'beta',status:'live',models:2,attestation:att({verifiers:['phala']})},
];

test('the list is read from the public providers endpoint and nothing else',()=>{
 assert.equal(PROVIDERS_PATH,'/api/v1/providers');
});

test('attested providers come first, then simulated, then unverified, each by name',()=>{
 const {rows,counts}=describeProviders(LIST,NOW);
 assert.deepEqual(rows.map((r)=>r.id),['beta','zeta','devbox','alpha','never']);
 assert.deepEqual(counts,{total:5,attested:2,simulated:1,unverified:2});
});

test('an attested row says what the router checked: hardware, verifiers, when',()=>{
 const zeta=describeProviders(LIST,NOW).rows.find((r)=>r.id==='zeta');
 assert.equal(zeta.statusLabel,'Attested');
 assert.equal(zeta.tee,'Intel TDX (confidential virtual machine)');
 assert.deepEqual(zeta.verifiers.map((v)=>v.id),['dcap','dstack']);
 assert.match(zeta.verifiers[0].label,/Intel's signature/);
 assert.equal(zeta.last,'Verified 4 min ago');
 assert.equal(zeta.reason,'');
 assert.equal(zeta.href,'/verify/?p=zeta');
 assert.equal(zeta.models,3);
});

test('an unverified row never shows verifiers, never claims hardware, and says why',()=>{
 const rows=describeProviders(LIST,NOW).rows;
 const alpha=rows.find((r)=>r.id==='alpha');
 assert.equal(alpha.statusLabel,'Unverified');
 assert.deepEqual(alpha.verifiers,[]);
 assert.equal(alpha.tee,'Declared: Intel TDX (confidential virtual machine). Not verified.');
 assert.match(alpha.reason,/too old to count/);
 assert.match(alpha.last,/Last verified 3 d ago, too long ago to count\. Latest attempt failed 3 min ago\./);
 assert.deepEqual(alpha.declared,{training:true,retainsPrompts:true});
 const never=rows.find((r)=>r.id==='never');
 assert.equal(never.tee,'Not established');
 assert.equal(never.last,'Never verified.');
 assert.match(never.reason,/never verified/);
 assert.equal(never.verifiersNote,'No verifier has accepted a quote for this provider.');
});

test('simulated evidence is labelled simulated and is not counted as attested',()=>{
 const dev=describeProviders(LIST,NOW).rows.find((r)=>r.id==='devbox');
 assert.equal(dev.statusLabel,'Simulated');
 assert.equal(dev.tee,'None: simulated for development');
 assert.deepEqual(dev.verifiers,[]);
 assert.equal(filterProviders(describeProviders(LIST,NOW).rows,{status:'attested'}).some((r)=>r.id==='devbox'),false);
});

test('a status that is not exactly "attested" or "simulated" reads as unverified; verifiers are ignored unless attested',()=>{
 for(const status of ['ATTESTED','ok','',null,undefined,42,{}]){
  const a=attestationOf({slug:'x',attestation:{status,tee:'tdx',verifiers:['dcap'],last_verified_at:ago(1)}});
  assert.equal(a.status,'unverified',String(status));
  assert.deepEqual(a.verifiers,[]);
 }
 assert.deepEqual(attestationOf({slug:'x',attestation:{status:'unverified',verifiers:['dcap']}}).verifiers,[]);
 assert.equal(attestationOf({slug:'x',attestation:att({verifiers:['dcap',7,null]})}).verifiers.length,1);
 assert.equal(attestationOf({slug:'x',attestation:att({last_verified_at:'yesterday-ish'})}).lastVerifiedAt,'');
});

test('an older router without the attestation object is read conservatively',()=>{
 const old=describeProviders([
  {name:'Old fresh',slug:'oldfresh',status:'live',tee:'tdx',attestation_fresh:true,attested:true,attested_at:ago(2),models:1},
  {name:'Old stale',slug:'oldstale',status:'live',tee:'tdx',attestation_fresh:false,attested:true,attested_at:ago(9999),models:1},
  {name:'Old dev',slug:'olddev',status:'live',tee:'dev',attestation_fresh:true,attested:true,attested_at:ago(2),models:1},
  {name:'Old none',slug:'oldnone',status:'live',tee:null,attestation_fresh:false,attested:false,attested_at:null,models:0},
  {name:'Flag only',slug:'flag',status:'live',tee:'tdx',attested:true,attested_at:ago(1),models:1}, // no freshness flag at all
 ],NOW).rows;
 const by=Object.fromEntries(old.map((r)=>[r.id,r]));
 assert.equal(by.oldfresh.status,'attested');
 assert.match(by.oldfresh.verifiersNote,/does not report which verifiers/);
 assert.equal(by.oldstale.status,'unverified');
 assert.equal(by.olddev.status,'simulated');
 assert.equal(by.oldnone.status,'unverified');
 assert.equal(by.flag.status,'unverified');
});

test('bad input does not throw or invent providers',()=>{
 assert.deepEqual(describeProviders(null,NOW).rows,[]);
 assert.deepEqual(describeProviders({data:[]},NOW).rows,[]);
 const {rows}=describeProviders([null,{},{slug:''},{slug:'ok',name:{},models:'3',attestation:'yes'}],NOW);
 assert.deepEqual(rows.map((r)=>[r.id,r.name,r.status,r.models]),[['ok','ok','unverified',0]]);
});

test('the verify link encodes the id',()=>{
 assert.equal(describeProviders([{slug:'a b/c',name:'x'}],NOW).rows[0].href,'/verify/?p=a%20b%2Fc');
});

test('filters: by status (not attested includes simulated) and by a name or id fragment',()=>{
 const {rows}=describeProviders(LIST,NOW);
 assert.deepEqual(filterProviders(rows,{status:'attested'}).map((r)=>r.id),['beta','zeta']);
 assert.deepEqual(filterProviders(rows,{status:'unverified'}).map((r)=>r.id),['devbox','alpha','never']);
 assert.deepEqual(filterProviders(rows,{query:' ZET '}).map((r)=>r.id),['zeta']);
 assert.deepEqual(filterProviders(rows,{status:'attested',query:'alpha'}),[]);
 assert.equal(filterProviders(rows).length,5);
});

test('verifier labels: known ids are explained, unknown ids are shown as given',()=>{
 assert.match(verifierLabel('phala'),/Phala/);
 assert.equal(verifierLabel('new-thing'),'new-thing');
});

test('the quickstart is one clone and one command',()=>{
 assert.match(QUICKSTART,/sidecar\/src\/cli\.ts init/);
 assert.doesNotMatch(QUICKSTART,/npm|publish/);
});
