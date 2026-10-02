import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { generations, keys, ledger, teamMembers, models, offers } from "../src/db/schema.ts";
import { insightsQuery } from "../src/insights/query.ts";
import { suggestPrices, type PriceModel } from "../src/insights/suggest.ts";
import { loadConfig } from "../src/config.ts";
let h: Harness;
beforeAll(async()=>{h=await startRouter({env:{SPEND_INSIGHTS_ENABLED:'true'}});});
afterAll(async()=>{await h?.close();});
type Key = { hash:string; auth:Record<string,string> };
const range='from=2026-09-27T00:00:00Z&to=2026-09-30T00:00:00Z';
async function read(key:Key, query=range){const r=await h.request('/api/v1/insights?'+query,{headers:key.auth});expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');return r.json();}
async function child(owner:Key){const r=await h.request('/api/v1/keys',{method:'POST',headers:owner.auth,json:{name:'Agent key'}});expect(r.status).toBe(201);const j=await r.json();return {hash:j.data.hash,auth:{authorization:'Bearer '+j.key}};}
async function call(key:Key,id:string,cost:bigint,at:string,extra={}){
  const [k]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,key.hash));
  await h.ctx.db.insert(generations).values({id,keyHash:key.hash,accountId:k.accountId,modelId:MODELS.llama.slug,providerId:'alpha',mode:'prepaid',cost,ts:new Date(at),tokensIn:100,tokensOut:10,receipt:{lane:'public'},...extra});
}
test('UTC buckets, refunds posted in range, multiple keys, exact totals and historical hardware evidence',async()=>{
  const owner=await h.fundedKey(), agent=await child(owner);const [k]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,owner.hash));
  await call(owner,'insights-sunday',1000000000001n,'2026-09-27T23:59:59.999Z');
  await call(agent,'insights-monday',2000000000000n,'2026-09-28T00:00:00Z',{receiptSig:'fixture-signature',receipt:{lane:'attested',disclosure:'attested'}});
  await call(owner,'insights-older',500n,'2026-09-26T00:00:00Z');
  await call(owner,'insights-edge',999n,'2026-09-30T00:00:00Z');
  await h.ctx.db.insert(ledger).values([{id:'insights-refund',ref:'insights-refund',accountId:k.accountId,keyHash:owner.hash,kind:'refund',amount:17n,generationId:'insights-older',createdAt:new Date('2026-09-28T23:59:59Z')},{id:'insights-deposit',ref:'insights-deposit',accountId:k.accountId,keyHash:owner.hash,kind:'deposit',amount:50n,createdAt:new Date('2026-09-28T00:00:00Z')}]);
  const report=await read(owner);
  expect(report.totals).toMatchObject({cost_usd:'2.999999999984',charged_usd:'3.000000000001',refunded_usd:'0.000000000017',calls:'2',proven_calls:'1',tokens_in:'200',tokens_out:'20',average_cost_usd:'1.499999999992'});
  expect(report.series.map((r:any)=>r.id)).toEqual(['2026-09-27','2026-09-28']);
  expect(report.keys).toHaveLength(2);expect(report.lanes).toHaveLength(2);expect(report.models[0].cost_usd).toBe(report.totals.cost_usd);
  const week=await read(owner,range+'&bucket=week');expect(week.series.map((r:any)=>r.id)).toEqual(['2026-09-21','2026-09-28']);
  expect(JSON.stringify(report)).not.toContain(owner.hash);expect(JSON.stringify(report)).not.toContain(agent.hash);
  expect((await read(agent)).totals).toMatchObject({calls:'1',cost_usd:'2'});
});
test('authentication, ordinary keys, account admins and sessions use Activity scope; no cross-account data',async()=>{
  expect((await h.request('/api/v1/insights')).status).toBe(401);
  expect((await h.request('/api/v1/insights',{headers:{authorization:'Bearer invalid'}})).status).toBe(401);
  const owner=await h.fundedKey(), admin=await child(owner), other=await h.fundedKey();
  await h.ctx.db.update(keys).set({teamId:'insights-team'}).where(eq(keys.keyHash,admin.hash));await h.ctx.db.insert(teamMembers).values({teamId:'insights-team',keyHash:admin.hash,role:'admin'});
  await call(owner,'insights-access',5n,'2026-09-28T00:00:00Z');await call(other,'insights-other',99n,'2026-09-28T00:00:00Z');
  expect((await read(admin))).toMatchObject({scope:'account',totals:{calls:'1',cost_usd:'0.000000000005'}});
  const s=(await (await h.request('/api/v1/sessions',{method:'POST',headers:owner.auth,json:{budget_usd:1}})).json()).data;const session={hash:s.key_hash,auth:{authorization:'Bearer '+s.key}};
  await h.ctx.db.update(keys).set({management:true}).where(eq(keys.keyHash,session.hash));
  expect((await read(session))).toMatchObject({scope:'key',totals:{calls:'0',cost_usd:'0',average_cost_usd:null}});
  await h.ctx.db.update(keys).set({disabled:true}).where(eq(keys.keyHash,admin.hash));expect((await h.request('/api/v1/insights',{headers:admin.auth})).status).toBe(401);
});
test('unlinked refunds produce negative net spend without inventing calls; cache and insufficient proof stay unproven',async()=>{
  const key=await h.fundedKey();const [k]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,key.hash));
  await h.ctx.db.insert(ledger).values({id:'insights-unlinked',ref:'insights-unlinked',accountId:k.accountId,keyHash:key.hash,kind:'refund',amount:9007199254740993123n,createdAt:new Date('2026-09-29')});
  for(const [i,extra] of [{mode:'cache'},{receiptSig:null},{receipt:{lane:'attested',disclosure:'attested',attestation_simulated:true}},{receipt:{lane:'attested',disclosure:'attested',upstream_attestation:{attested:false}}}].entries())await call(key,'insights-proof-'+i,0n,'2026-09-28T00:00:00Z',{receiptSig:'fixture-signature',receipt:{lane:'attested',disclosure:'attested'},...extra});
  const r=await read(key);expect(r.totals.cost_usd).toBe('-9007199.254740993123');expect(r.totals.proven_calls).toBe('0');expect(r.models.find((m:any)=>m.id===null).calls).toBe('0');
});
test('read-only route validates bounded ranges and is absent by default',async()=>{
  const key=await h.fundedKey();for(const query of ['from=2026-01-01T00:00:00Z&to=2026-04-04T00:00:00Z','bucket=month','from=bad',range+'&bucket=bad'])expect((await h.request('/api/v1/insights?'+query,{headers:key.auth})).status).toBe(400);
  const off=await startRouter();try{expect((await off.request('/api/v1/insights')).status).toBe(404);}finally{await off.close();}
  expect(()=>insightsQuery({from:'2026-01-01T00:00:00Z',to:'2026-04-03T00:00:00.001Z'})).toThrow();
  expect(insightsQuery({from:'2026-01-01T00:00:00Z',to:'2026-04-03T00:00:00Z'}).bucket).toBe('day');
});
const source:PriceModel={id:'source',name:'Source',live:true,disclosure:'attested',capabilities:['tools','attested'],lanes:['public','attested'],context:128000,inputs:['text'],outputs:['text'],prompt:10n,completion:100n,request:0n};
const mix={id:'source',tokens_in:'900',tokens_out:'100',calls:'10',lanes:['attested'],disclosures:['attested']};
test('price suggestions preserve capability tags, endpoint lanes, modalities, context and live status; weight actual mix exactly',()=>{
  const good={...source,id:'good',prompt:5n,completion:90n};
  const rows=suggestPrices(source,mix,[good,{...good,id:'offline',live:false},{...good,id:'no-tools',capabilities:['attested']},{...good,id:'weak-disclosure',disclosure:'policy'},{...good,id:'weak-lane',lanes:['public']},{...good,id:'small-context',context:8192},{...good,id:'wrong-output',outputs:['image']},{...good,id:'expensive-output',completion:1000n},{...good,id:'request-fee',request:10000n},source]);
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({model:'good',baseline_usd:'0.000000019',estimated_cost_usd:'0.0000000135',estimated_saving_usd:'0.0000000055'});
  expect(suggestPrices(source,{...mix,lanes:['unknown']},[good])).toEqual([]);
});
test('config starts in production with insights enabled without weakening guards',()=>{
  const address='0x'+'1'.repeat(40);
  const cfg=loadConfig({NODE_ENV:'production',ANYROUTE_ENV:'production',RUNTIME_ROLE:'api',AUTO_MIGRATE:'false',HOST:'0.0.0.0',APP_SECRET:'fixture-'.repeat(6),ADMIN_TOKEN:'fixture-admin-'.repeat(3),PUBLIC_BASE_URL:'https://router.example',DATABASE_URL:'postgres://fixture:fixture-only-credential@localhost/insights',REDIS_URL:'redis://:fixture-only-credential@localhost:6379',CREDITS_ADDRESS:address,CALLPAY_ADDRESS:address,PROVIDER_BOND_ADDRESS:address,RECEIPT_ANCHOR_ADDRESS:address,ROUTER_PRIVATE_KEY:'0x'+'3'.repeat(64),SPEND_INSIGHTS_ENABLED:'true'});
  expect(cfg.production).toBe(true);expect(cfg.spendInsightsEnabled).toBe(true);expect(loadConfig({}).spendInsightsEnabled).toBe(false);
});

test('model rankings order cost and calls independently; averages retain an exact ratio',async()=>{
  const key=await h.fundedKey();
  await call(key,'insights-ranking-high',9007199254740993123n,'2026-09-28T00:00:00Z',{modelId:MODELS.qwen.slug});
  await call(key,'insights-ranking-low-a',1n,'2026-09-28T00:00:00Z');await call(key,'insights-ranking-low-b',0n,'2026-09-28T00:00:00Z');
  const r=await read(key);expect(r.top_models_by_cost[0].id).toBe(MODELS.qwen.slug);expect(r.top_models_by_calls[0].id).toBe(MODELS.llama.slug);
  expect(r.models.find((m:any)=>m.id===MODELS.llama.slug)).toMatchObject({average_cost_usd:'0',average_cost_ratio:{numerator_usd:'0.000000000001',denominator:'2'}});
});
test('live catalog adapter suggests the priced eligible endpoint and drops disabled offers',async()=>{
  const key=await h.fundedKey();const [m]=await h.ctx.db.select().from(models).where(eq(models.id,MODELS.llama.slug));const [o]=await h.ctx.db.select().from(offers).where(eq(offers.modelId,MODELS.llama.slug));
  const id='sample/low-price';await h.ctx.db.insert(models).values({...m,id,name:'Lower price'});await h.ctx.db.insert(offers).values({...o,modelId:id,pricePrompt:5n,priceCompletion:6n});await h.ctx.catalog.refresh();
  await call(key,'insights-live-source',1000000000n,'2026-09-28T00:00:00Z',{receipt:{lane:'public',disclosure:'vendor-forwarded'}});
  const r=await read(key);expect(r.suggestions[0].alternatives.some((a:any)=>a.model===id)).toBe(true);
  await h.ctx.db.update(offers).set({status:'disabled'}).where(eq(offers.modelId,id));await h.ctx.catalog.refresh();
  expect(JSON.stringify((await read(key)).suggestions)).not.toContain(id);
});
