import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, api } from '../lib/api.js';
import { capBars, reasonText, decisionText, intentSummary, errorState, FEATURE_OFF, policyForm, buildPolicy, sampleIntent, eventsPage, confirmKill, utcTime } from '../lib/agents.js';

test('spend is converted from pico, bars clamp and uncapped or unavailable spend remains explicit', () => {
  const bars = capBars({ spent:{ hour:0.5,day:2,week:-1 },caps:{ per_hour_usd:1,per_day_usd:1 } });
  assert.equal(bars[0].percent,50); assert.equal(bars[0].spent,0.5);
  assert.equal(bars[1].percent,100); assert.equal(bars[2].percent,0); assert.match(bars[2].label,/No cap/);
  assert.equal(capBars({})[0].label,'Spend not recorded / No cap');
  assert.equal(capBars({ spent:{hour:0},caps:{per_hour_usd:1} })[0].percent,0);
});

test('reason messages are authoritative and all contract reasons have readable fallbacks', () => {
  assert.equal(reasonText({ code:'over_per_day',message:'Daily cap reached at $3.' }),'Daily cap reached at $3.');
  for (const code of ['killed','model_not_allowed','lane_not_allowed','over_per_request','over_per_hour','over_per_day','over_per_week','max_tokens','tool_not_allowed','outside_window','approval_required']) assert.notEqual(reasonText({code}),code);
  assert.equal(reasonText({code:'new_reason'}),'new_reason');
  assert.equal(decisionText('approval_required'),'Approval required');
  assert.equal(utcTime('2026-09-30T12:00:00Z'),'2026-09-30 12:00:00 UTC');
  assert.equal(utcTime('bad'),'Not recorded');
});

test('event summary projects only permitted intent fields and pages sort newest first with a cursor', () => {
  const summary = intentSummary({kind:'inference',model:'author/model',lane:'attested',est_cost_pico:'10000000000',tools:['lookup'],prompt:'PRIVATE TEXT',response:'PRIVATE TEXT'});
  assert.match(summary,/author\/model.*attested.*\$0.01.*lookup/); assert.doesNotMatch(summary,/PRIVATE TEXT/);
  assert.equal(intentSummary({kind:'mcp_tool',name:'lookup'}),'Tool: lookup');
  const page = eventsPage({ data:[{id:'2',ts:'2026-09-30T12:00:00Z'},{id:'3',ts:'2026-09-30T12:00:00Z'},{id:'1',ts:'2026-09-29T12:00:00Z'}],next:'cursor&1' });
  assert.deepEqual(page.events.map(e => e.id),['3','2','1']); assert.equal(page.next,'cursor&1');
  assert.deepEqual(eventsPage({data:{events:[],next_cursor:null}}),{events:[],next:null});
});

test('only 404 not_found presents the calm feature-off state, authentication and network errors remain errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({error:{type:'not_found',message:'Not found'}}),{status:404});
  try { await assert.rejects(() => api('/api/v1/agents'),e => { assert.deepEqual(errorState(e),{off:true,message:FEATURE_OFF}); return true; }); }
  finally { globalThis.fetch = original; }
  for (const error of [new ApiError(403,'Permission denied','forbidden'),new ApiError(404,'Key missing','key_not_found'),new ApiError(0,'Unreachable','unreachable')]) assert.deepEqual(errorState(error),{off:false,message:error.message});
});

test('empty form produces the strict v1 shape and disabled restrictions are omitted', () => {
  const form = policyForm(null);
  assert.deepEqual(buildPolicy(form),{policy:{version:1,models:{},caps:{},on_breach:'deny'},errors:[]});
  form.lanes = []; form.windows = [{days:[1],start:'09:00',end:'17:00'}];
  assert.equal(buildPolicy(form).policy.lanes,undefined); assert.equal(buildPolicy(form).policy.windows,undefined);
  form.restrictLanes = true; form.restrictWindows = true;
  assert.deepEqual(buildPolicy(form).policy.lanes,[]); assert.equal(buildPolicy(form).policy.windows.length,1);
});

test('form round-trip retains models, lanes, money, tools, windows, approval and breach action', () => {
  const policy = {version:1,models:{allow:['author/*'],deny:['author/no']},lanes:['public','attested'],caps:{per_request_usd:0.01,per_hour_usd:1,per_day_usd:4,per_week_usd:20,max_output_tokens:512},tools:{allow:['lookup'],deny:['delete']},windows:[{days:[0,6],start:'09:00',end:'17:00'}],approval:{above_usd:0.02},on_breach:'kill'};
  assert.deepEqual(buildPolicy(policyForm(policy)),{policy,errors:[]});
  assert.deepEqual(buildPolicy({...policyForm(null),modelAllow:'author/a, author/b\n author/*'}).policy.models.allow,['author/a','author/b','author/*']);
});

test('form validates every list bound and USD/tokens at boundaries, rejecting invalid numbers', () => {
  for (const field of ['modelAllow','modelDeny','toolAllow','toolDeny']) {
    assert.equal(buildPolicy({...policyForm(null),[field]:Array(64).fill('a'.repeat(160)).join('\n')}).errors.length,0);
    assert.ok(buildPolicy({...policyForm(null),[field]:Array(65).fill('a').join('\n')}).errors.length);
    assert.ok(buildPolicy({...policyForm(null),[field]:'a'.repeat(161)}).errors.length);
  }
  for (const field of ['per_request_usd','per_hour_usd','per_day_usd','per_week_usd']) {
    for (const value of ['0','-1','1000000.01','Infinity','NaN']) { const f = policyForm(null); f.caps[field] = value; assert.ok(buildPolicy(f).errors.length); }
    for (const value of ['0.000001','1000000']) { const f = policyForm(null); f.caps[field] = value; assert.equal(buildPolicy(f).errors.length,0); }
  }
  for (const value of ['0','-1','1.5','10000001','Infinity']) { const f = policyForm(null); f.caps.max_output_tokens = value; assert.ok(buildPolicy(f).errors.length); }
  for (const value of ['1','10000000']) { const f = policyForm(null); f.caps.max_output_tokens = value; assert.equal(buildPolicy(f).errors.length,0); }
  assert.ok(buildPolicy({...policyForm(null),approval:'0'}).errors.length);
  assert.ok(buildPolicy({...policyForm(null),onBreach:'continue'}).errors.length);
});

test('UTC windows validate day, clock and list bounds without silently altering them', () => {
  for (const window of [{days:[7],start:'09:00',end:'17:00'},{days:[1.5],start:'09:00',end:'17:00'},{days:[1],start:'24:00',end:'17:00'},{days:[1],start:'9:00',end:'17:60'}]) assert.ok(buildPolicy({...policyForm(null),restrictWindows:true,windows:[window]}).errors.length);
  const window = {days:[0,1,2,3,4,5,6],start:'00:00',end:'23:59'};
  assert.equal(buildPolicy({...policyForm(null),restrictWindows:true,windows:Array(64).fill(window)}).errors.length,0);
  assert.ok(buildPolicy({...policyForm(null),restrictWindows:true,windows:Array(65).fill(window)}).errors.length);
  assert.ok(buildPolicy({...policyForm(null),restrictLanes:true,lanes:['other']}).errors.length);
});

test('preview builds only an Intent with exact pico conversion and never invokes inference', () => {
  const form = {model:'author/a',lane:'public',cost:'0.123456789123',tokens:'512',tools:'lookup,read'};
  assert.deepEqual(sampleIntent(form),{intent:{kind:'inference',model:'author/a',lane:'public',est_cost_pico:'123456789123',tools:['lookup','read'],max_output_tokens:512},errors:[]});
  assert.equal(sampleIntent({...form,cost:'0',tokens:''}).intent.max_output_tokens,undefined);
  for (const cost of ['-1','Infinity','1000001','0.0000000000001','']) assert.ok(sampleIntent({...form,cost}).errors.length);
  assert.ok(sampleIntent({...form,tokens:'1.2'}).errors.length);
  assert.ok(sampleIntent({...form,model:''}).errors.length);
});

test('kill cancellation performs no request and confirmation posts only the reason to the selected key', async () => {
  const calls = [];
  const request = async (...args) => calls.push(args);
  const agent = {key_hash:'hash/1',name:'Research'};
  assert.equal(await confirmKill(agent,'because',() => false,request),false); assert.equal(calls.length,0);
  assert.equal(await confirmKill(agent,'  budget review  ',message => { assert.match(message,/Kill Research/); assert.match(message,/until you resume/); return true; },request),true);
  assert.deepEqual(calls,[['/api/v1/agents/hash%2F1/kill',{method:'POST',body:{reason:'budget review'}}]]);
  await confirmKill(agent,' ',() => true,request); assert.deepEqual(calls[1][1].body,{});
});
