import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BREAKER_FIELDS, trippedBy } from '../lib/agent-breakers.js';
import { policyForm, buildPolicy, reasonText } from '../lib/agents.js';

test('optional breaker fields round-trip and omissions leave the original wire policy unchanged',()=>{
 const base={version:1,models:{},caps:{},on_breach:'deny'};
 assert.deepEqual(buildPolicy(policyForm(base)),{policy:base,errors:[]});
 const policy={...base,breakers:{max_spend_usd_per_minute:0.25,max_requests_per_minute:2,max_denials_per_10min:3,max_distinct_models_per_hour:4}};
 assert.deepEqual(buildPolicy(policyForm(policy)),{policy,errors:[]});
 for(const [name] of BREAKER_FIELDS){const form=policyForm(base);form.breakers[name]='';assert.equal(buildPolicy(form).policy.breakers,undefined);}
});
test('breaker bounds reject invalid values and preserve integer limits',()=>{
 for(const [name] of BREAKER_FIELDS) for(const value of ['0','-1','Infinity','NaN','9007199254740992']){
  const form=policyForm(null);form.breakers[name]=value;assert.ok(buildPolicy(form).errors.length);
 }
 for(const [name] of BREAKER_FIELDS.slice(1)){const form=policyForm(null);form.breakers[name]='1.5';assert.ok(buildPolicy(form).errors.length);}
 const form=policyForm(null);form.breakers.max_spend_usd_per_minute='1000000.1';assert.ok(buildPolicy(form).errors.length);
});
test('trip badge reflects persisted own or inherited kills and clears after resume',()=>{
 assert.equal(trippedBy({killed:true,killed_reason:'breaker:max_requests_per_minute'}),'max_requests_per_minute');
 assert.equal(trippedBy({killed:false,killed_reason:null}),null);
 assert.equal(trippedBy(null,{policies:[{killed:true,killed_reason:'breaker:max_denials_per_10min'}]}),'max_denials_per_10min');
 assert.equal(trippedBy({killed:true,killed_reason:'owner stop'}),null);
 for(const [name] of BREAKER_FIELDS) assert.notEqual(reasonText({code:'breaker:'+name}),'breaker:'+name);
});
test('OpenAPI includes strict optional breakers and every reason code',()=>{
 const spec=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
 const schemas=spec.components.schemas;
 assert.equal(schemas.AgentPolicy.required.includes('breakers'),false);
 assert.equal(schemas.AgentBreakers.additionalProperties,false);
 for(const [name] of BREAKER_FIELDS){assert.ok(schemas.AgentBreakers.properties[name]);assert.ok(schemas.AgentDecision.properties.reasons.items.properties.code.enum.includes('breaker:'+name));}
 const ui=readFileSync(new URL('../app/agents/Agents.jsx',import.meta.url),'utf8');assert.match(ui,/<BreakersForm/);assert.match(ui,/<TrippedBadge/);
});
