import test from 'node:test';
import assert from 'node:assert/strict';
import {initialWorkspace,models,routeCall,validWorkspace} from '../lib/demo.js';
const seed=()=>structuredClone(initialWorkspace);
const input=state=>({state,modelId:models[0].id,prompt:'Audit this route.',privateRoute:false,payWith:'USDG',keyId:'key_seed',now:1780000000000});
test('a successful call debits exactly once and itemizes its unsigned receipt',()=>{
 const state=seed();const before=structuredClone(state);const out=routeCall(input(state));
 assert.deepEqual(state,before);assert.equal(out.state.receipts.length,1);
 assert.equal(out.state.balance,25-out.receipt.cost);assert.equal(out.state.keys[0].spent,out.receipt.cost);
 assert.equal(out.receipt.inference+out.receipt.royalty,out.receipt.cost);
 assert.equal(out.receipt.signature,null);assert.equal(out.receipt.anchor,null);
 assert.equal('prompt' in out.receipt,false);assert.equal(validWorkspace(out.state),true);
});
test('failures preserve funds and records',()=>{
 for(const type of ['balance','budget','revoked','timeout','private','unsupported-token']){
  const state=seed();if(type==='balance')state.balance=0;if(type==='budget')state.keys[0].budget=0;if(type==='revoked')state.keys[0].active=false;
  const args=input(state);if(type==='timeout')args.forceFailure=true;if(type==='private'){args.modelId=models[2].id;args.privateRoute=true;}if(type==='unsupported-token')args.payWith='UNKNOWN';
  const before=structuredClone(state);assert.throws(()=>routeCall(args));assert.deepEqual(state,before);
 }
});
test('Stock Token calls require an active session and enforce daily caps',()=>{
 const state=seed();const args={...input(state),payWith:'NVDA'};assert.throws(()=>routeCall(args),/active NVDA/);
 state.sessions.push({id:'s1',token:'NVDA',active:true,cap:1e-12,spent:0,day:'2026-05-28'});assert.throws(()=>routeCall(args),/daily cap/);
 state.sessions[0].cap=.01;const out=routeCall(args);assert.equal(out.state.balance,25);assert.equal(out.receipt.units,out.receipt.cost/100);assert.equal(out.state.sessions[0].spent,out.receipt.units);
});
test('daily caps reset on the UTC date boundary',()=>{
 const state=seed();state.sessions.push({id:'s1',token:'TSLA',active:true,cap:.01,spent:.01,day:'2026-05-27'});
 const args={...input(state),payWith:'TSLA',now:Date.parse('2026-05-28T00:00:00Z')};const out=routeCall(args);assert.equal(out.state.sessions[0].spent,out.receipt.units);assert.equal(out.state.sessions[0].day,'2026-05-28');
});
test('private routes have an attestation fixture but no claimed proof',()=>{
 const out=routeCall({...input(seed()),privateRoute:true});assert.equal(out.receipt.private,true);assert.equal(out.receipt.attestation,'fixture:tee-evidence-not-verified');assert.equal(out.receipt.signature,null);
});
test('malformed stored workspaces are rejected before rendering',()=>{
 assert.equal(validWorkspace(seed()),true);assert.equal(validWorkspace(null),false);
 for(const mutate of [s=>s.keys[0].spent=-1,s=>s.keys[0].token=null,s=>s.receipts.push({id:'broken',cost:0,tokens:0}),s=>s.sessions.push({id:'bad',token:'UNKNOWN',cap:1,spent:0})]){
  const state=seed();mutate(state);assert.equal(validWorkspace(state),false);
 }
});
