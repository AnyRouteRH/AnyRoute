import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keys, ledger, agentApprovals, spendAlerts, accounts, providers } from "../src/db/schema.ts";
import { webhookDestinations, webhookDeliveries } from "../src/webhooks/schema.ts";
import { webhookSignature, verifyWebhook } from "../src/webhooks/signature.ts";
import { runWebhooks, activityEvent } from "../src/webhooks/worker.ts";
import { sendRuleWebhook } from "../src/webhooks/delivery.ts";
import { decrypt, encrypt } from "../src/lib/util.ts";
import { loadConfig } from "../src/config.ts";
import { startRouter, type Harness } from "./helpers.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { WEBHOOK_SIGNING_ENABLED: "true", AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h.close(); });
const hook = "https://hooks.example.com/credential-path?key=receiver-credential";
async function make(owner: Awaited<ReturnType<Harness["newKey"]>>, events = ["deposit.credited"]) {
  const r = await h.request("/api/v1/webhooks", { method: "POST", headers: owner.auth, json: { webhook_url: hook, events } });
  expect(r.status).toBe(201); expect(r.headers.get("cache-control")).toBe("no-store"); return await r.json();
}
test("fixed SHA256 HMAC vector, exact bytes, tolerance and invalid header handling", () => {
  const body = '{"id":"event_1","type":"deposit.credited"}';
  expect(webhookSignature("fixture-secret", body, 1700000000)).toBe("t=1700000000,v1=65c5694885945670e14ccf669846463ebee6a3c568219eda5069076fe2d1d10b");
  const signature = webhookSignature("fixture-secret", body, 1700000000);
  expect(verifyWebhook("fixture-secret", body, signature, 1700000300)).toBe(true);
  for (const time of [1699999699,1700000301]) expect(verifyWebhook("fixture-secret", body, signature,time)).toBe(false);
  expect(verifyWebhook("fixture-secret", body + ' ', signature,1700000000)).toBe(false);
  expect(verifyWebhook("wrong",body,signature,1700000000)).toBe(false);
  expect(verifyWebhook("fixture-secret",body,'t=1,v1=bad')).toBe(false);
});
test("secret encrypted and shown once; list, logs and subsequent writes omit it", async () => {
  const owner = await h.newKey(), result = await make(owner);
  expect(result.signing_secret).toMatch(/^whsec_[a-f0-9]{64}$/);
  const [stored] = await h.ctx.db.select().from(webhookDestinations).where(eq(webhookDestinations.id,result.data.id));
  expect(stored.secretEnc).not.toContain(result.signing_secret); expect(decrypt(h.ctx.cfg.appSecret,stored.secretEnc!)).toBe(result.signing_secret);
  for (const path of ['/api/v1/webhooks','/api/v1/webhooks/'+result.data.id+'/deliveries']) {
    const text = await (await h.request(path,{headers:owner.auth})).text();
    expect(text).not.toContain(result.signing_secret); expect(text).not.toContain('credential-path'); expect(text).not.toContain('receiver-credential'); expect(text).not.toContain('secret_enc');
  }
  const r = await h.request('/api/v1/webhooks/'+result.data.id,{method:'PATCH',headers:owner.auth,json:{events:['approval.requested']}});
  expect(r.status).toBe(200); expect(await r.text()).not.toContain(result.signing_secret);
});
test("account isolation and ordinary-key/session management guards", async () => {
  const owner = await h.newKey(), other = await h.newKey(), result = await make(owner);
  const childResponse = await h.request('/api/v1/keys',{method:'POST',headers:owner.auth,json:{name:'sample-user'}});
  const child = await childResponse.json(), auth = {authorization:'Bearer '+child.key};
  expect((await h.request('/api/v1/webhooks',{headers:auth})).status).toBe(403);
  for (const [method,suffix] of [['GET','/deliveries'],['POST','/rotate'],['POST','/revoke'],['POST','/test'],['DELETE','']]) {
    expect((await h.request('/api/v1/webhooks/'+result.data.id+suffix,{method,headers:other.auth})).status).toBe(404);
  }
});
test("egress rejects insecure and private URLs before saving", async () => {
  const owner = await h.newKey();
  for (const url of ['http://hooks.example.com','https://127.0.0.1/a','https://receiver.internal/','https://user:password@hooks.example.com']) expect((await h.request('/api/v1/webhooks',{method:'POST',headers:owner.auth,json:{webhook_url:url,events:['deposit.credited']}})).status).toBe(400);
});
test("queued endpoint check signs exact bytes, binds id, and records no body or secret", async () => {
  const owner = await h.newKey(), r = await make(owner);
  const check = await h.request('/api/v1/webhooks/'+r.data.id+'/test',{method:'POST',headers:owner.auth});
  expect(check.status).toBe(202); const event = await check.json();
  expect((await h.request('/api/v1/webhooks/'+r.data.id+'/test',{method:'POST',headers:owner.auth})).status).toBe(429);
  let sent = 0;
  await runWebhooks(h.ctx,{send:async (_url,init) => { sent++; const headers = new Headers(init.headers); expect(headers.get('x-anyroute-event-id')).toBe(event.data.event_id); expect(verifyWebhook(r.signing_secret,String(init.body),headers.get('x-anyroute-signature')!)).toBe(true); expect(JSON.parse(String(init.body)).event_id).toBe(headers.get('x-anyroute-event-id')); expect(init.redirect).toBe('error'); return new Response('receiver body sentinel',{status:204}); }});
  expect(sent).toBe(1);
  const log = await (await h.request('/api/v1/webhooks/'+r.data.id+'/deliveries',{headers:owner.auth})).json();
  expect(log.data).toHaveLength(1); expect(log.data[0]).toMatchObject({event:'endpoint.check',retry_count:0,status:'delivered',http_status:204});
  expect(JSON.stringify(log)).not.toContain(r.signing_secret); expect(JSON.stringify(log)).not.toContain('receiver body sentinel');
});
test("legacy unsigned path, rotation signs, subscription filtering and revoke stops sends", async () => {
  const owner = await h.newKey(); const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash,owner.hash));
  await h.ctx.db.insert(spendAlerts).values({id:'legacy-signing',accountId:k.accountId,createdBy:owner.hash,kind:'threshold',webhookUrlEnc:encrypt(h.ctx.cfg.appSecret,hook)});
  const list = await (await h.request('/api/v1/webhooks',{headers:owner.auth})).json(), d = list.data.find((d: any) => d.legacy_rule_id==='legacy-signing');
  expect(d.signing).toBe('unsigned');
  const payload = {kind:'threshold',value_usd:1}; const event = {id:'legacy-event',event:'spend.alert',reference:'legacy-signing',at:new Date()};
  await sendRuleWebhook(h.ctx,'legacy-signing',hook,event,payload,{send:async (_url,init) => { expect(new Headers(init.headers).has('x-anyroute-signature')).toBe(false); expect(JSON.parse(String(init.body))).toEqual(payload); return new Response(null,{status:200}); }});
  const rotation = await (await h.request('/api/v1/webhooks/'+d.id+'/rotate',{method:'POST',headers:owner.auth})).json();
  await sendRuleWebhook(h.ctx,'legacy-signing',hook,{...event,id:'signed-event'},payload,{send:async (_url,init) => { expect(verifyWebhook(rotation.signing_secret,String(init.body),new Headers(init.headers).get('x-anyroute-signature')!)).toBe(true); return new Response(null,{status:200}); }});
  await h.request('/api/v1/webhooks/'+d.id,{method:'PATCH',headers:owner.auth,json:{events:['approval.requested']}});
  const noSend = {send:async () => { throw new Error('must not send'); }};
  expect((await sendRuleWebhook(h.ctx,'legacy-signing',hook,{...event,id:'filtered'},payload,noSend)).ok).toBe(true);
  await h.request('/api/v1/webhooks/'+d.id+'/revoke',{method:'POST',headers:owner.auth});
  const [stored] = await h.ctx.db.select().from(webhookDestinations).where(eq(webhookDestinations.id,d.id)); expect(stored.secretEnc).toBeNull(); expect(stored.revoked).toBe(true);
  expect((await sendRuleWebhook(h.ctx,'legacy-signing',hook,{...event,id:'revoked'},payload,noSend)).ok).toBe(true);
});
test("worker filters subscriptions, account credits and atomically queued approval requests/decisions; deduplicates scans", async () => {
  const owner = await h.newKey(), other = await h.newKey(), r = await make(owner,['deposit.credited','approval.requested','approval.decided']);
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash,owner.hash));
  const [otherKey] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash,other.hash));
  const at = new Date(Date.now()-2000);
  await h.ctx.db.update(webhookDestinations).set({createdAt:new Date(at.getTime()-1000),scan:{from:new Date(at.getTime()-1000).toISOString()}}).where(eq(webhookDestinations.id,r.data.id));
  await h.ctx.db.insert(ledger).values([{id:'webhook-credit',accountId:k.accountId,keyHash:k.keyHash,kind:'deposit',amount:1n,ref:'webhook-credit',createdAt:at},{id:'webhook-other-credit',accountId:otherKey.accountId,keyHash:otherKey.keyHash,kind:'deposit',amount:1n,ref:'other-credit',createdAt:at}]);
  const { prepareApproval, decideApproval } = await import('../src/agents/approvals.ts');
  const { ApiError } = await import('../src/lib/errors.ts');
  await h.ctx.db.transaction(tx => prepareApproval(h.ctx.db, tx, [], [{ kind:'inference',model:'sample/model',lane:'public',tools:[],est_cost_pico:1n }], k.keyHash,new ApiError(403,'Approval required','agent_approval_required'),new Date()));
  const [approval] = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.keyHash,k.keyHash));
  await decideApproval(h.ctx.db,k.accountId,approval.id,k.keyHash,'approve');
  const types: string[] = [];
  const opts = {send:async (_url: string,init:RequestInit) => { const body = JSON.parse(String(init.body)); expect(String(init.body)).not.toContain('must not be copied'); expect(body.reference).not.toBe('webhook-other-credit'); types.push(body.type); return new Response(null,{status:200}); }};
  await runWebhooks(h.ctx,opts); expect(types.sort()).toEqual(['approval.decided','approval.requested','deposit.credited']);
  await runWebhooks(h.ctx,opts); expect(types).toHaveLength(3);
  expect(activityEvent({id:'x',kind:'agreement',status:'MilestoneFunded'})).toBe('agreement.funded'); expect(activityEvent({id:'x',kind:'agreement',status:'Settled'})).toBeNull();
});
test("flag off preserves unsigned transport and hides routes and jobs", async () => {
  const disabled = await startRouter();
  try { const owner = await disabled.newKey(); expect((await disabled.request('/api/v1/webhooks',{headers:owner.auth})).status).toBe(404); expect(await runWebhooks(disabled.ctx)).toMatchObject({skipped:'disabled',attempted:0});
    await sendRuleWebhook(disabled.ctx,'missing',hook,{id:'off',event:'spend.alert',reference:'missing',at:new Date()},{value:1},{send:async (_url,init) => { expect(new Headers(init.headers).has('x-anyroute-event-id')).toBe(false); expect(new Headers(init.headers).has('x-anyroute-signature')).toBe(false); expect(init.body).toBe('{"value":1}'); return new Response(null,{status:200}); }});
  } finally { await disabled.close(); }
});
test("production config starts for API and isolated webhook worker with signing enabled", () => {
  const base = {NODE_ENV:'production',ANYROUTE_ENV:'production',AUTO_MIGRATE:'false',HOST:'0.0.0.0',APP_SECRET:'fixture-'.repeat(6),ADMIN_TOKEN:'fixture-admin-'.repeat(3),PUBLIC_BASE_URL:'https://router.example',DATABASE_URL:'postgres://fixture:fixture-only-credential@localhost/fixture',REDIS_URL:'redis://:fixture-only-credential@localhost:6379',PAYMENTS_MODE:'escrow',ESCROW_ADDRESS:'0x'+'1'.repeat(40),ESCROW_START_BLOCK:'1',ESCROW_TOKENS:JSON.stringify([{symbol:'UNIT',address:'0x'+'2'.repeat(40),decimals:18,feed:'0x'+'3'.repeat(40)}]),WEBHOOK_SIGNING_ENABLED:'true'};
  for (const role of ['api','worker']) expect(loadConfig({...base,RUNTIME_ROLE:role,WORKER_JOBS:'webhooks'}).webhookSigningEnabled).toBe(true);
  expect(loadConfig({}).webhookSigningEnabled).toBe(false);
});

test("signed sender still blocks DNS answers to private addresses", async () => {
  const owner = await h.newKey(), r = await make(owner);
  const [d] = await h.ctx.db.select().from(webhookDestinations).where(eq(webhookDestinations.id,r.data.id));
  const { deliver } = await import("../src/webhooks/delivery.ts");
  expect(await deliver(h.ctx,d,{id:'dns',event:'deposit.credited',reference:'dns',at:new Date()},{id:'dns'},{resolve:async () => [{address:'127.0.0.1',family:4}]})).toMatchObject({ok:false,blocked:true,error:'destination_blocked'});
});
test("new Spend Watch destinations reveal a secret and omit it on later reads", async () => {
  const owner = await h.newKey();
  const r = await h.request('/api/v1/spend/alerts',{method:'POST',headers:owner.auth,json:{kind:'threshold',threshold_usd:1,webhook_url:hook}});
  expect(r.status).toBe(201); const body = await r.json(); expect(body.signing_secret).toMatch(/^whsec_/);
  const list = await (await h.request('/api/v1/spend/alerts',{headers:owner.auth})).text(); expect(list).not.toContain(body.signing_secret);
  const change = await h.request('/api/v1/spend/alerts/'+body.data.id,{method:'PATCH',headers:owner.auth,json:{webhook_url:'https://other.example.com/new'}});
  const next = await change.json(); expect(next.signing_secret).not.toBe(body.signing_secret); expect(next.signing_secret).toMatch(/^whsec_/);
});
test("bounded retries keep the same id, log each result, and never retry after the third failure", async () => {
  const owner = await h.newKey(), r = await make(owner);
  const check = await (await h.request('/api/v1/webhooks/'+r.data.id+'/test',{method:'POST',headers:owner.auth})).json();
  const ids: string[] = [];
  const opts = {send:async (_url: string,init: RequestInit) => { ids.push(new Headers(init.headers).get('x-anyroute-event-id')!); return new Response(null,{status:503}); }};
  for(let i=0;i<3;i++) { await h.ctx.db.update(webhookDeliveries).set({nextAttempt:new Date(0)}).where(eq(webhookDeliveries.eventId,check.data.event_id)); await runWebhooks(h.ctx,opts); }
  expect(ids).toEqual([check.data.event_id,check.data.event_id,check.data.event_id]);
  await runWebhooks(h.ctx,opts); expect(ids).toHaveLength(3);
  const [row] = await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId,check.data.event_id)); expect(row.status).toBe('failed'); expect(row.history.map(a => a.retry_count)).toEqual([0,1,2]);
  expect(JSON.stringify(row)).not.toContain(r.signing_secret); expect(JSON.stringify(row)).not.toContain('credential-path');
});

test("host transitions queue atomically for only the operated account, including rapid changes", async () => {
  const owner = await h.newKey(), other = await h.newKey(), r = await make(owner,['host.status_changed']), otherDest = await make(other,['host.status_changed']);
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash,owner.hash));
  const wallet = '0x'+'5'.repeat(40);
  await h.ctx.db.update(accounts).set({wallet}).where(eq(accounts.id,key.accountId));
  await h.ctx.db.insert(providers).values({id:'webhook-host',name:'Sample host',kind:'sidecar',baseUrl:'https://host.example.com/v1',networkHost:true,operator:wallet,status:'pending'});
  const { withHostStatus } = await import('../src/webhooks/hosts.ts');
  for(const status of ['probation','rejected']) await withHostStatus(h.ctx,'webhook-host',db => db.update(providers).set({status,updatedAt:new Date()}).where(eq(providers.id,'webhook-host')));
  expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.destinationId,otherDest.data.id))).toHaveLength(0);
  const queued = await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.destinationId,r.data.id)); expect(queued.map(e => e.eventStatus).sort()).toEqual(['probation','rejected']);
  const got: string[] = [];
  await runWebhooks(h.ctx,{send:async (_url,init) => { got.push(JSON.parse(String(init.body)).status); return new Response(null,{status:200}); }}); expect(got.sort()).toEqual(['probation','rejected']);
  await expect(withHostStatus(h.ctx,'webhook-host',async db => { await db.update(providers).set({status:'live'}).where(eq(providers.id,'webhook-host')); throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect((await h.ctx.db.select().from(providers).where(eq(providers.id,'webhook-host')))[0].status).toBe('rejected');
  expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.destinationId,r.data.id))).toHaveLength(2);
});
