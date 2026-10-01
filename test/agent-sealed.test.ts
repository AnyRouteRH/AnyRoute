import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { ApiError } from "../src/lib/errors.ts";
import { keys, kv } from "../src/db/schema.ts";
import { agentSealedRoutes } from "../src/api/agent-sealed.ts";
import { agentsRoutes } from "../src/api/agents.ts";
import { registrationSchema, sealedReportData } from "../src/agents/sealed/bindings.ts";
import { getSealed, recheckSealed, registerSealed, removeSealed, sealedStatus, runSealedAttestor, SEALED_MAX_AGE_MS } from "../src/agents/sealed/store.ts";
import { verifySealed, type SealedIO } from "../src/agents/sealed/verify.ts";
import { bootAgent } from "../sidecar/src/agent/runtime.ts";
import { sealedDstackProvider } from "./support/sealed-fixtures.ts";
import { startRouter, type Harness } from "./helpers.ts";
const image = 'sha256:' + 'ab'.repeat(32), compose = 'sha256:' + 'cd'.repeat(32);
const expected = {attestation_url:'https://agent.example/attest',agent_image_digest:image,compose_hash:compose};
const env = { AGENT_SEALED_ENABLED:'true', AGENT_POLICY_ENABLED:'true', ATTESTATION_VERIFIERS:'dstack', DSTACK_VERIFIER_URL:'https://verifier.example' };
let h: Harness;
beforeAll(async () => { h = await startRouter({env}); });
afterAll(async () => { await h?.close(); });
async function fixture(hash: string, secret: string) {
  const rt = await bootAgent({imageDigest:image,keyHash:hash,socket:'/var/run/dstack.sock',credentialFile:'/sealed/api-credential.bin',routerOrigin:'https://router.example',hostname:'agent.example'},sealedDstackProvider(compose),async () => secret);
  const io: SealedIO = {certificate:async () => rt.tls.certDer, report:async url => rt.attest(url.searchParams.get('nonce')!),verify:async () => ({ok:true,verifiers:['dstack'],composeHash:compose.slice(7)})};
  return { rt, io };
}
async function child() {
  const owner = await h.fundedKey();
  const res = await h.request('/api/v1/keys', {method:'POST',headers:owner.auth,json:{name:'sealed-agent',management:false}});
  const json = await res.json() as any;
  expect(res.status).toBe(201);
  return {owner, hash:json.data.hash, secret:json.key, auth:{authorization:`Bearer ${json.key}`}};
}
function appWith(io: SealedIO) {
  const app = new Hono();
  app.onError((error,c) => error instanceof ApiError ? c.json({error:{type:error.type}},error.status as any) : c.json({error:{type:'invalid_request'}},400));
  agentSealedRoutes(app,h.ctx,io); agentsRoutes(app,h.ctx); return app;
}
test('fresh dstack evidence verifies exact key, image, measured compose and TLS binding',async () => {
  const k=await child(), {io}=await fixture(k.hash,k.secret);
  expect(await verifySealed(k.hash,expected,io)).toMatchObject({attested:true,verified_by:['dstack']});
  expect(await verifySealed('ef'.repeat(32),expected,io)).toEqual({attested:false,reason:'agent_key_mismatch'});
  expect(await verifySealed(k.hash,{...expected,agent_image_digest:'sha256:'+'ee'.repeat(32)},io)).toMatchObject({reason:'deployment_mismatch'});
  expect(await verifySealed(k.hash,expected,{...io,verify:async () => ({ok:true,verifiers:['dstack'],composeHash:'ff'.repeat(32)})})).toMatchObject({reason:'measured_compose_mismatch'});
  expect(await verifySealed(k.hash,expected,{...io,verify:async () => ({ok:true,verifiers:[]})})).toMatchObject({reason:'quote_rejected'});
});
test('stale nonce, spoofed TLS key, software evidence, debug TDX and verifier rejection fail closed',async () => {
  const k=await child(), {io,rt}=await fixture(k.hash,k.secret);
  expect(await verifySealed(k.hash,expected,{...io,report:async () => rt.attest('00'.repeat(32))})).toMatchObject({reason:'report_data_mismatch'});
  const changed = (edit:(doc:any)=>void):SealedIO => ({...io,report:async (url,pin) => {const doc=structuredClone(await io.report(url,pin));edit(doc);return doc;}});
  expect(await verifySealed(k.hash,expected,changed(doc => {doc.bindings.tls_spki_sha256='ff'.repeat(32);}))).toMatchObject({reason:'tls_binding_mismatch'});
  expect(await verifySealed(k.hash,expected,changed(doc => {doc.evidence.dev=true;}))).toMatchObject({reason:'hardware_evidence_required'});
  expect(await verifySealed(k.hash,expected,changed(doc => {const q=Buffer.from(doc.evidence.quote,'hex');q[168]=1;doc.evidence.quote=q.toString('hex');}))).toMatchObject({reason:'unsafe_tdx_quote'});
  expect(await verifySealed(k.hash,expected,{...io,verify:async () => ({ok:false,verifiers:[]})})).toMatchObject({reason:'quote_rejected'});
  expect(await verifySealed(k.hash,expected,{...io,verify:async () => {throw new Error('down');}})).toMatchObject({reason:'verification_unavailable'});
});
test('principal registration enriches list and me; agent and another account cannot manage it',async () => {
  const k=await child(), {io}=await fixture(k.hash,k.secret), app=appWith(io);
  const post=(auth:Record<string,string>) => app.request('/api/v1/agents/'+k.hash+'/sealed',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify(expected)});
  expect((await post(k.auth)).status).toBe(403);
  const other=await h.fundedKey(); expect((await post(other.auth)).status).toBe(404);
  const res=await post(k.owner.auth); expect(res.status).toBe(200);expect((await res.json() as any).data.attested).toBe(true);
  const me=await app.request('/api/v1/agents/me',{headers:k.auth});expect((await me.json() as any).data.sealed.attested).toBe(true);
  const list=await app.request('/api/v1/agents',{headers:k.owner.auth});expect((await list.json() as any).data.find((a:any)=>a.key_hash===k.hash).sealed.attested).toBe(true);
  const deleted=await app.request('/api/v1/agents/'+k.hash+'/sealed',{method:'DELETE',headers:k.owner.auth});expect(deleted.status).toBe(200);expect(await getSealed(h.ctx,k.hash)).toBe(null);
});
test('failed recheck clears success; expired records and disabled keys never show a badge',async () => {
  const k=await child(), {io}=await fixture(k.hash,k.secret);
  await registerSealed(h.ctx,k.hash,expected,io);
  let record=(await getSealed(h.ctx,k.hash))!;
  const checked=Date.parse(record.checked_at!);
  expect(sealedStatus(record,checked+SEALED_MAX_AGE_MS-1)?.attested).toBe(true);
  expect(sealedStatus(record,checked+SEALED_MAX_AGE_MS)?.attested).toBe(false);
  expect(sealedStatus(record,checked-1)?.attested).toBe(false);
  await recheckSealed(h.ctx,k.hash,record,{...io,verify:async () => ({ok:false,verifiers:[]})});
  expect(sealedStatus(await getSealed(h.ctx,k.hash))?.attested).toBe(false);
  await registerSealed(h.ctx,k.hash,expected,io);
  await h.ctx.db.update(keys).set({disabled:true}).where(eq(keys.keyHash,k.hash));
  expect(sealedStatus(await getSealed(h.ctx,k.hash))?.attested).toBe(false);
});
test('in-flight checks cannot resurrect deleted or replaced registration',async () => {
  const k=await child(), {io}=await fixture(k.hash,k.secret);
  await registerSealed(h.ctx,k.hash,expected,io); const record=(await getSealed(h.ctx,k.hash))!;
  let release!:()=>void, started!:()=>void;
  const wait = new Promise<void>(resolve=>{release=resolve;}), ready=new Promise<void>(resolve=>{started=resolve;});
  const inFlight=recheckSealed(h.ctx,k.hash,record,{...io,verify:async input=>{started();await wait;return io.verify(input);}});
  await ready; await removeSealed(h.ctx,k.hash); release(); await inFlight;
  expect(await getSealed(h.ctx,k.hash)).toBe(null);
  await registerSealed(h.ctx,k.hash,expected,io);
  expect(await recheckSealed(h.ctx,k.hash,record,io)).toBe(null);
});
test('strict HTTPS endpoint settings and off flag preserve existing response shape',async () => {
  for(const url of ['http://agent.example/attest','https://agent.example/attest?key=secret','https://user:secret@agent.example/attest','https://agent.example/other','https://agent.example/attest#x'])expect(()=>registrationSchema.parse({...expected,attestation_url:url})).toThrow();
  expect(()=>registrationSchema.parse({...expected,api_key:'unexpected'})).toThrow();
  const off=await startRouter({env:{AGENT_POLICY_ENABLED:'true'}});
  try {const k=await off.fundedKey();expect((await off.request('/api/v1/agents/'+k.hash+'/sealed',{method:'POST',headers:k.auth,json:expected})).status).toBe(404);expect((await (await off.request('/api/v1/agents/me',{headers:k.auth})).json() as any).data.sealed).toBeUndefined();}
  finally {await off.close();}
});
test('real config loader starts in production API and attestor worker roles with sealed agents on',() => {
  const address='0x'+'1'.repeat(40);
  const base={NODE_ENV:'production',ANYROUTE_ENV:'production',RUNTIME_ROLE:'api',AUTO_MIGRATE:'false',HOST:'0.0.0.0',APP_SECRET:'fixture-'.repeat(6),ADMIN_TOKEN:'fixture-admin-'.repeat(3),PUBLIC_BASE_URL:'https://router.example',DATABASE_URL:'postgres://fixture:fixture-only-credential@localhost/fixture',REDIS_URL:'redis://:fixture-only-credential@localhost:6379',CREDITS_ADDRESS:address,CALLPAY_ADDRESS:address,PROVIDER_BOND_ADDRESS:address,RECEIPT_ANCHOR_ADDRESS:address,ROUTER_PRIVATE_KEY:'0x'+'3'.repeat(64),ALLOW_DEV_ATTESTATION:'false',...env};
  expect(loadConfig(base).agentSealedEnabled).toBe(true);
  expect(loadConfig({...base,RUNTIME_ROLE:'worker',WORKER_JOBS:'attestor'}).workerJobs).toEqual(['attestor']);
  expect(loadConfig({...base,AGENT_SEALED_ENABLED:'false'}).agentSealedEnabled).toBe(false);
  expect(()=>loadConfig({...base,AGENT_POLICY_ENABLED:'false'})).toThrow();
  expect(()=>loadConfig({...base,ATTESTATION_VERIFIERS:'dcap'})).toThrow();
});

test('scheduled sealed attestor clears badges after verification failure and is inactive with flag off',async () => {
 const k=await child(), {io}=await fixture(k.hash,k.secret);
 await registerSealed(h.ctx,k.hash,expected,io);
 const unavailable={...io,verify:async () => ({ok:false,verifiers:[]})};
 await runSealedAttestor({...h.ctx,cfg:{...h.ctx.cfg,agentSealedEnabled:false}},unavailable);
 expect(sealedStatus(await getSealed(h.ctx,k.hash))?.attested).toBe(true);
 await runSealedAttestor(h.ctx,unavailable);
 expect(sealedStatus(await getSealed(h.ctx,k.hash))?.attested).toBe(false);
});
