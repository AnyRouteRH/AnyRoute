import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { accounts, keys } from "../src/db/schema.ts";
import { agentPolicySchema } from "../src/agents/policy.ts";
import { agentPolicies } from "../src/agents/schema.ts";
import { agreementEscrowAbi } from "../src/agreements/abi.ts";
import { pollAgreements, loadAgreementState, type AgreementIndexChain, type IndexedAgreementLog } from "../src/agreements/indexer.ts";
import { agreementScope } from "../src/agreements/state.ts";
import { addEvidence, pruneAgreementEvidence } from "../src/agreements/evidence.ts";
import { agreementRuleReasons } from "../src/agreements/rulebook.ts";
import { callJuryModel, evidenceRoot, juryConsensus, runAgreementJury, type Vote } from "../src/agreements/jury.ts";
import { postAgreementRuling, type RulingTransport } from "../src/agreements/posting.ts";
import { agreementCursor, agreementEvents, agreementEvidence, agreementJury, agreementProjection } from "../src/agreements/schema.ts";
import { formatSignerKey, noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { AnyRoute } from "../packages/client/src/index.ts";
import { startRouter, type Harness } from "./helpers.ts";
describe("agreement DB service", () => {
const address = (n: number) => `0x${n.toString(16).repeat(40)}` as Hex;
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const payer = address(1), payee = address(2), outsider = address(3), escrow = address(4), oracle = address(5);
const env = { AGENT_AGREEMENTS_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: escrow, DISPUTE_ORACLE_ADDRESS: oracle, AGREEMENT_START_BLOCK: "1", CHAIN_CONFIRMATIONS: "1", AGREEMENT_EVIDENCE_WINDOW_SECONDS: "60", AGREEMENT_RETENTION_DAYS: "1", AGREEMENT_JURY_MODELS: "jury/a,jury/b,jury/c", TLOG_ENABLED: "true", AGENT_POLICY_ENABLED: "true" };
let h: Harness, owner: Awaited<ReturnType<Harness['fundedKey']>>, recipient: typeof owner, stranger: typeof owner, unlinked: typeof owner;
let logs: IndexedAgreementLog[], head: bigint, at: number;
const hashes = new Map<bigint, Hex>();
const log = (block: number, event: string, args: Record<string, unknown>): IndexedAgreementLog => ({ block: BigInt(block), blockHash: hex(block), txHash: hex(100+block), logIndex: event === "MilestoneFunded" ? 0 : 1, event, args: { indexedAt: at, milestone: "0", ...args } });
const chain: AgreementIndexChain = { tip: async () => ({ head, final: head }), hash: async block => hashes.get(block) ?? hex(Number(block)), logs: async (from, to) => logs.filter(l => l.block >= from && l.block <= to) };
beforeAll(async () => {
  h = await startRouter({ env });
  [owner, recipient, stranger, unlinked] = await Promise.all([h.fundedKey(), h.fundedKey(), h.fundedKey(), h.fundedKey()]);
  for (const [key, wallet] of [[owner, payer], [recipient, payee], [stranger, outsider]] as const) {
    const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
    await h.ctx.db.update(accounts).set({ wallet }).where(eq(accounts.id, row.accountId));
  }
  h.ctx.cfg.agreements.apiKey = owner.secret;
});
afterAll(async () => h?.close());
beforeEach(async () => {
  for (const table of [agreementJury, agreementEvidence, agreementProjection, agreementEvents, agreementCursor, agentPolicies]) await h.ctx.db.delete(table);
  head = 4n; hashes.clear(); at = Math.floor(Date.now()/1000);
  logs = [log(1, "MilestoneFunded", { id: "1", amount: "5000000" }), log(1, "AgreementCreated", { id: "1", payer, payee, total: "5000000", termsHash: hex(9), deadline: "2000000000", disputeOracle: oracle }), log(2, "DeliverySubmitted", { id: "1", deliverableHash: hex(8), reviewUntil: "2000000000" }), log(3, "DisputeOpened", { id: "1", evidenceHash: hex(7) })];
  h.ctx.cfg.agreements.rulings = false; h.ctx.cfg.agreements.signerKeys = undefined; h.ctx.cfg.chain.confirmations = 1;
  await pollAgreements(h.ctx, chain, 2n);
});
const req = (k: typeof owner, path: string, method = "GET", json?: unknown) => h.request(path, { method, headers: k.auth, json: json as never });
const vote = (model: string, verdict: "pay" | "refund" | "split" | "abstain" = "pay", bps = verdict === "pay" ? 10000 : verdict === "split" ? 5000 : 0): Vote => ({ model, verdict: { verdict, payee_bps: bps, reason: "Terms and delivery assessed." }, receipt_id: `receipt-${model}`, receipt_url: "/verify/", policy_hash: null, failure: null });
const jury = (call = async (model: string) => vote(model)) => runAgreementJury(h.ctx, (path, init) => h.app.request(path, init), call, (at+61)*1000);
test("flags off and missing addresses do not register routes, tools, jobs, indexing or jury behavior", async () => {
  const off = await startRouter();
  try {
    expect(off.ctx.cfg.agreements.enabled).toBe(false);
    expect((await off.request('/api/v1/agreements')).status).toBe(404);
    expect(await pollAgreements(off.ctx, { tip: async () => { throw Error('unexpected RPC'); } } as AgreementIndexChain)).toEqual({ skipped: 'disabled' });
    expect(await runAgreementJury(off.ctx, () => { throw Error('unexpected call'); })).toEqual({ skipped: 'disabled' });
    expect(await postAgreementRuling(off.ctx)).toEqual({ skipped: 'disabled' });
    expect(off.ctx.jobs.status().some(j => j.name.startsWith('agreement-'))).toBe(false);
    const tools = await (await off.request('/mcp', { method:'POST', json:{ jsonrpc:'2.0',id:1,method:'tools/list' }})).json();
    expect(tools.result.tools.some((t: any) => t.name.startsWith('anyroute_agreement_'))).toBe(false);
  } finally { await off.close(); }
  expect(loadConfig({ AGENT_AGREEMENTS_ENABLED:true }).agreements.enabled).toBe(false);
});
test("index journals once, waits for confirmations/finality and replays reorg state", async () => {
  expect((await pollAgreements(h.ctx, chain)).recorded).toBe(0);
  expect((await loadAgreementState(h.ctx.db,agreementScope(h.ctx.cfg))).get('agreement:1.0')?.state).toBe('disputed');
  hashes.set(4n,hex(400)); logs = logs.slice(0,3);
  expect((await pollAgreements(h.ctx,chain,2n)).reorg).toBe(true);
  expect((await loadAgreementState(h.ctx.db,agreementScope(h.ctx.cfg))).get('agreement:1.0')?.state).toBe('submitted');
  expect((await h.ctx.db.select().from(agreementEvents)).length).toBe(3);
  h.ctx.cfg.chain.confirmations=3;
  expect((await pollAgreements(h.ctx,chain)).caught_up).toBe(false);
  expect((await h.ctx.db.select().from(agreementCursor))[0].checkedAt.getTime()).toBe(0);
});
test("index rejects noncanonical logs and does not commit a partial journal", async () => {
  head=5n; logs.push({...log(5,'Released',{id:'1'}),blockHash:hex(500)});
  await expect(pollAgreements(h.ctx,chain)).rejects.toThrow('noncanonical');
  expect((await h.ctx.db.select().from(agreementCursor))[0].block).toBe(4n);
});
test("wallet-linked party access, hashed encrypted evidence, unauthorized reads and capped streams", async () => {
  expect((await req(unlinked,'/api/v1/agreements')).status).toBe(403);
  expect((await req(stranger,'/api/v1/agreements/1.0')).status).toBe(404);
  expect((await req(stranger,'/api/v1/agreements/1.0/evidence','POST',{text:'secret'})).status).toBe(404);
  expect((await req(owner,'/api/v1/agreements/1.0/evidence','POST',{text:'delivery material'})).status).toBe(201);
  const stored=(await h.ctx.db.select().from(agreementEvidence))[0]; expect(stored.content).not.toContain('delivery material'); expect(stored.sha256).toHaveLength(64);
  const detail=await (await req(recipient,'/api/v1/agreements/1.0')).json(); expect(detail.data.evidence[0].content.text).toBe('delivery material');
  expect((await req(owner,'/api/v1/agreements/1.0/evidence','POST','x'.repeat(17000))).status).toBe(413);
  expect((await req(owner,'/api/v1/agreements')).headers.get('cache-control')).toBe('no-store');
  await expect(addEvidence(h.ctx,'1.0',payer,'late',(at+61)*1000)).rejects.toMatchObject({status:409});
});
test("creation reorg prevents new parties from reading old before-dispute evidence", async () => {
  logs=logs.slice(0,3); hashes.set(4n,hex(400)); await pollAgreements(h.ctx,chain);
  await addEvidence(h.ctx,'1.0',payer,'old agreement secret');
  for(let i=1;i<=4;i++) hashes.set(BigInt(i),hex(1000+i));
  logs=[{...log(1,"MilestoneFunded",{id:"1",amount:"5000000"}),blockHash:hex(1001)}, {...log(1,'AgreementCreated',{id:'1',payer:outsider,payee,total:'5000000',termsHash:hex(9),deadline:'2000000000',disputeOracle:oracle}),txHash:hex(999),blockHash:hex(1001)}];
  await pollAgreements(h.ctx,chain);
  expect((await (await req(stranger,'/api/v1/agreements/1.0')).json()).data.evidence).toHaveLength(0);
  expect((await req(owner,'/api/v1/agreements/1.0')).status).toBe(404);
});
test("equal evidence hashes before and during a dispute retain deterministic leaf order", async () => {
  logs=logs.slice(0,3); hashes.set(4n,hex(400)); await pollAgreements(h.ctx,chain);
  await addEvidence(h.ctx,'1.0',payer,'same evidence');
  head=5n; logs.push(log(5,'DisputeOpened',{id:'1',evidenceHash:hex(7)})); await pollAgreements(h.ctx,chain);
  await addEvidence(h.ctx,'1.0',payer,'same evidence');
  const detail=(await (await req(owner,'/api/v1/agreements/1.0')).json()).data;
  expect(detail.evidence.map((e:any)=>e.dispute)).toEqual([`${hex(105)}:1`, `before-dispute:${hex(101)}:1`]);
});
test("agreement preparation checks exact USDG amount, normalized allowlist, inherited caps and killed state", async () => {
  const policy=agentPolicySchema.parse({version:1,models:{},caps:{},on_breach:'deny',agreements:{max_escrow_usd:5,counterparties_allow:[payee.toUpperCase().replace('0X','0x')]}});
  expect(agreementRuleReasons(policy,payee,5000000n)).toEqual([]); expect(agreementRuleReasons(policy,payee,5000001n)).toHaveLength(1); expect(agreementRuleReasons(policy,outsider,1n)).toHaveLength(1);
  await h.ctx.db.insert(agentPolicies).values({keyHash:owner.hash,spec:policy,sha256:'fixture',version:1,updatedBy:owner.hash});
  const body={payee,milestone_amounts_usdg_units:['5000000'],terms_hash:hex(9),deadline:'2000000000'};
  const allowed=await req(owner,'/api/v1/agreements/prepare','POST',body); expect(allowed.status).toBe(200); expect((await allowed.json()).data).toMatchObject({payer,to:escrow,value:'0'});
  expect((await req(owner,'/api/v1/agreements/prepare','POST',{...body,milestone_amounts_usdg_units:['5000001']})).status).toBe(403);
  const sessionResponse = await req(owner,'/api/v1/sessions','POST',{budget_usd:1});
  expect(sessionResponse.status).toBe(201);
  const session = (await sessionResponse.json()).data;
  expect((await h.request('/api/v1/agreements/prepare',{method:'POST',headers:{authorization:`Bearer ${session.key}`},json:{...body,payee:outsider}})).status).toBe(403);
  await h.ctx.db.update(agentPolicies).set({killed:true}); expect((await req(owner,'/api/v1/agreements/prepare','POST',body)).status).toBe(403);
});
test("jury freezes evidence, stores signed dry-run with logged key and no chain posting", async () => {
  await addEvidence(h.ctx,'1.0',payer,{terms:'Terms supplied by the payer'}); await addEvidence(h.ctx,'1.0',payee,{delivery:'Supporting content'});
  let calls=0; expect(await jury(async model=>{calls++;return vote(model);})).toMatchObject({status:'dry_run'}); expect(calls).toBe(3);
  const row=(await h.ctx.db.select().from(agreementJury))[0]; expect(await h.ctx.signer.verify(row.statement,row.signature,row.keyId)).toBe(true);
  expect(await jury()).toEqual({skipped:'nothing ready'}); await expect(addEvidence(h.ctx,'1.0',payer,'extra')).rejects.toMatchObject({status:409});
  expect(await postAgreementRuling(h.ctx,{guard:async()=>{throw Error('must not sign');}} as RulingTransport)).toEqual({skipped:'dry run'});
});
test("jury stores panel for failed or hung calls and does not auto-decide", async () => {
  expect(await jury(async model=>model==='jury/a'?vote(model):{...vote(model),verdict:null,failure:'unavailable'})).toMatchObject({status:'panel'});
  expect((await h.ctx.db.select().from(agreementJury))[0].status).toBe('panel');
});
test("attested jury adapter verifies signed answer digest and rejects public or altered replies", async () => {
  const text=JSON.stringify({verdict:'pay',payee_bps:10000,reason:'Satisfied terms'});
  const {sha256}=await import('../src/lib/util.ts');
  const payload={id:'jury-receipt',lane:'attested',disclosure:'attested',model:'jury/a',response_sha256:sha256(text)};
  const signed=h.ctx.signer.sign(payload);
  const router=async (_path:string,init?:RequestInit)=>{ const body=JSON.parse(init!.body as string); expect(body.provider.lane).toBe('attested'); expect(body.provider.disclosure).toBe('none'); return new Response(JSON.stringify({choices:[{message:{content:text}}],receipt:{payload,key_id:signed.keyId,sig:signed.sig}}),{headers:{'x-anyroute-lane':'attested','x-receipt-id':'jury-receipt'}}); };
  expect((await callJuryModel(h.ctx,router,'jury/a',{})).verdict?.verdict).toBe('pay');
  expect((await callJuryModel(h.ctx,async()=>new Response('{}',{headers:{'x-anyroute-lane':'public'}}),'jury/a',{})).verdict).toBeNull();
  const changed=async()=>new Response(JSON.stringify({choices:[{message:{content:text.replace('pay','refund')}}],receipt:{payload,key_id:signed.keyId,sig:signed.sig}}),{headers:{'x-anyroute-lane':'attested','x-receipt-id':'jury-receipt'}});
  expect((await callJuryModel(h.ctx,changed,'jury/a',{})).failure).toBe('invalid_receipt');
});
test("posting persists before broadcast, retries identical bytes, never posts panel and checks stale/reorg state", async () => {
  await jury(); h.ctx.cfg.agreements.rulings=true; h.ctx.cfg.agreements.signerKeys=[hex(3)];
  h.ctx.chain.blockHashAt=async block=>chain.hash(block);
  let preparations=0,broadcasts=0;
  const transport:RulingTransport={guard:async()=>{},prepare:async()=>{preparations++;return{raw:'0x1234',hash:hex(999)};},broadcast:async(raw)=>{broadcasts++;expect(raw).toBe('0x1234');expect((await h.ctx.db.select().from(agreementJury))[0].postingRaw).not.toBeNull();if(broadcasts===1)throw Error('fixture interruption');return'posted';}};
  await expect(postAgreementRuling(h.ctx,transport)).rejects.toThrow('fixture interruption'); expect(preparations).toBe(1);
  expect(await postAgreementRuling(h.ctx,transport)).toMatchObject({status:'posted'}); expect(preparations).toBe(1);expect(broadcasts).toBe(2);
  hashes.set(4n,hex(400)); expect(await postAgreementRuling(h.ctx,transport)).toEqual({skipped:'nothing canonical and ready'});
});
test("retention waits for canonical resolution and deletes evidence plus jury answer text", async () => {
  await addEvidence(h.ctx,'1.0',payer,'content'); await jury();
  expect(await pruneAgreementEvidence(h.ctx)).toEqual({removed:0});
  head=5n;logs.push(log(5,'Settled',{id:'1',payeeAmount:'5000000',payerAmount:'0',indexedAt:at-172800}));await pollAgreements(h.ctx,chain);
  expect(await pruneAgreementEvidence(h.ctx)).toEqual({removed:1}); expect(await h.ctx.db.select().from(agreementJury)).toHaveLength(0);
});
test("MCP tools reuse party-only routes and SDK prepares through the rulebook endpoint", async () => {
  const response=await h.request('/mcp',{method:'POST',headers:owner.auth,json:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'anyroute_agreement_evidence',arguments:{id:'1.0',evidence:'via MCP'}}}});
  expect((await response.json()).result.structuredContent.sha256).toHaveLength(64);
  const client=new AnyRoute({apiKey:owner.secret,baseUrl:'http://router.example',fetch:async(input,init)=>h.app.request(new URL(String(input)).pathname,init)});
  expect(await client.agreements.prepare({payee,milestone_amounts_usdg_units:['5000000'],terms_hash:hex(9),deadline:'2000000000'})).toMatchObject({payer,to:escrow});
});

});
