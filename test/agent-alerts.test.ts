import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness, MODELS } from "./helpers.ts";
import { agentPolicySha256, agentPolicySchema, type AgentPolicy } from "../src/agents/policy.ts";
import { canonicalJson, encrypt, sha256 } from "../src/lib/util.ts";
import { alertStateKey, capAlerts, readAlertState, windowMs, type AlertState } from "../src/agents/alerts.ts";
import { runAgentAlerts, type AlertDeliveryOptions } from "../src/agents/alert-delivery.ts";
import { appendEvent, lockAccount } from "../src/agents/store.ts";
import { agentPolicies } from "../src/agents/schema.ts";
import { keys, kv, spendAlerts } from "../src/db/schema.ts";
import { reserve } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { loadConfig } from "../src/config.ts";
let h: Harness;
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", TELEGRAM_BOT_TOKEN: "12345:" + "fixture".repeat(4) } }); });
afterAll(async () => { await h?.close(); });
const deliver = (opts: AlertDeliveryOptions = {}) => runAgentAlerts(h.ctx, {send:async () => {throw new Error("unexpected webhook");},telegramFetch:(async () => {throw new Error("unexpected Telegram");}) as typeof fetch,...opts});
const path = (k: {hash: string}) => `/api/v1/agents/${k.hash}`;
const put = (k: {hash: string; auth: Record<string,string>}, policy: AgentPolicy) => h.request(path(k)+"/policy", {method:"PUT",headers:k.auth,json:policy});
const call = (k: {auth: Record<string,string>}) => h.request("/api/v1/chat/completions", {method:"POST",headers:k.auth,json:{model:MODELS.llama.slug,messages:[{role:"user",content:"never-copy-alert-content"}],max_tokens:32,provider:{only:["alpha"]}}});
async function feed(k: {hash: string;auth: Record<string,string>}) { return (await (await h.request(path(k)+"/alerts",{headers:k.auth})).json()).data; }
async function account(k: {hash: string}) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash,k.hash)))[0].accountId; }

test("schema opt-in keeps existing policy hashes and bounds settings without injecting defaults", () => {
  expect(agentPolicySha256(base)).toBe(sha256(canonicalJson(base)));
  expect(agentPolicySchema.parse(base)).toEqual(base);
  expect(agentPolicySchema.parse({...base,alerts:{}}).alerts).toEqual({});
  for (const alerts of [{at_percent:[0]},{at_percent:[101]},{at_percent:[80.5]},{at_percent:Array(65).fill(80)},{denials_in_10min:0},{channels:["sms"]},{extra:true}]) expect(agentPolicySchema.safeParse({...base,alerts}).success).toBe(false);
});
test("thresholds, exact equality, per-window cooldowns and policy-edit dedupe", () => {
  const state: AlertState = {feed:[],dedupe:{},rate:{minute:0,count:0}};
  const policy = {...base,caps:{per_hour_usd:1,per_day_usd:1,per_week_usd:1},alerts:{}};
  const spent = {hour:usdToPico(.79),day:usdToPico(.8),week:usdToPico(1)};
  const now = Date.now(); capAlerts(state,"key",policy,spent,now);
  expect(state.feed.map(a => `${a.window}:${a.percent}`).sort()).toEqual(["day:80","week:100","week:80"]);
  capAlerts(state,"key",policy,{...spent,hour:usdToPico(1)},now+1);
  expect(state.feed).toHaveLength(5);
  capAlerts(state,"key",{...policy,caps:{...policy.caps,per_hour_usd:.5}},{hour:usdToPico(1),day:usdToPico(1),week:usdToPico(1)},now+2);
  expect(state.feed).toHaveLength(6); // day 100 is new; changing caps doesn't repeat hour alerts
  capAlerts(state,"key",policy,{hour:usdToPico(1),day:usdToPico(1),week:usdToPico(1)},now+windowMs.hour+2);
  expect(state.feed).toHaveLength(8);
  capAlerts(state,"key",policy,{hour:0n,day:usdToPico(1),week:usdToPico(1)},now+windowMs.day+3);
  expect(state.feed).toHaveLength(10);
  capAlerts(state,"key",policy,{hour:0n,day:0n,week:usdToPico(1)},now+windowMs.week+4);
  expect(state.feed).toHaveLength(12);
});
test("successful concurrent reservations record each threshold once and do not copy body text", async () => {
  const k = await h.fundedKey(10n); await put(k,{...base,caps:{per_hour_usd:1},alerts:{}});
  const accountId = await account(k);
  await Promise.all([1,2].map(n => reserve(h.ctx.db,{id:`alert-${k.hash}-${n}`,accountId,keyHash:k.hash,amount:usdToPico(.5),agent:{models:[MODELS.llama.slug],lane:"public",max_output_tokens:32,body:{messages:[{content:"never-copy-alert-content"}]}}})));
  expect((await feed(k)).map((a: any) => a.percent).sort((a: number,b: number) => a-b)).toEqual([80,100]);
  expect(JSON.stringify(await feed(k))).not.toContain("never-copy-alert-content");
  await deliver({send:async () => {throw new Error("no channel should send");}});
  expect((await feed(k)).every((a: any) => a.delivery === "feed_only")).toBe(true);
});
test("denial default and override, manual/on_breach kills and new approval only", async () => {
  const k = await h.fundedKey(); await put(k,{...base,models:{allow:[]},alerts:{}});
  for (let n=0;n<4;n++) expect((await call(k)).status).toBe(403);
  expect(await feed(k)).toHaveLength(0);
  expect((await call(k)).status).toBe(403); expect((await feed(k))[0].kind).toBe("denials");
  await call(k); expect(await feed(k)).toHaveLength(1);
  await h.request(path(k)+"/kill",{method:"POST",headers:k.auth,json:{reason:"never-copy-kill-reason"}});
  expect((await feed(k))[0].kind).toBe("killed");
  const b = await h.fundedKey(); await put(b,{...base,models:{allow:[]},on_breach:"kill",alerts:{denials_in_10min:1}});
  await call(b); expect((await feed(b)).map((a: any) => a.kind).sort()).toEqual(["denials","killed"]);
  const a = await h.fundedKey(); await put(a,{...base,approval:{above_usd:1e-9},alerts:{}});
  await call(a); await call(a); expect((await feed(a)).map((x: any) => x.kind)).toEqual(["approval"]);
  expect(JSON.stringify(await feed(k))).not.toContain("never-copy-kill-reason");
  expect((await h.request(path(k)+"/alerts",{headers:a.auth})).status).toBe(404);
});
test("existing webhook and authorized Telegram links, failed channel retry and rate bound", async () => {
  const k = await h.fundedKey(), accountId = await account(k);
  const other = await h.fundedKey();
  await put(k,{...base,alerts:{}});
  await h.ctx.db.insert(spendAlerts).values({id:`alerts-${k.hash}`,accountId,kind:"threshold",webhookUrlEnc:encrypt(h.ctx.cfg.appSecret,"https://alerts.example/events")});
  for (const [id,secret] of [[8001,k.secret],[8002,other.secret]] as const) await h.ctx.db.insert(kv).values({key:`telegram:user:${id}`,value:{v:1,key:encrypt(h.ctx.cfg.appSecret,`tg:${id}:${secret}`)}});
  let now = Date.now(), sent = 0, tg = 0;
  for (let n=0;n<12;n++) await h.request(path(k)+"/kill",{method:"POST",headers:k.auth,json:{}});
  const opts = {now:() => now,send:async (_url: string,init: RequestInit) => {sent++; const payload=JSON.parse(init.body as string); expect(Object.keys(payload).sort()).toEqual(["at","id","key_hash","kind","source","type"]); return new Response(null,{status:sent === 1 ? 500 : 200});},telegramFetch:(async (_url: any,init: any) => {tg++; expect(JSON.parse(init.body).chat_id).toBe(8001); return Response.json({ok:true,result:{}});}) as typeof fetch};
  await deliver(opts); expect(sent).toBe(10); expect(tg).toBe(10);
  await deliver(opts); expect(sent).toBe(10);
  now += 60_000; await deliver(opts); expect(sent).toBe(12); expect(tg).toBe(12);
  now += 300_000; await deliver(opts); expect(sent).toBe(13); expect(tg).toBe(12);
  expect((await feed(k)).every((a: any) => a.delivery === "delivered")).toBe(true);
});
test("email-only is feed-only; alerts absent and flag off write nothing", async () => {
  const k = await h.fundedKey(); await put(k,{...base,alerts:{channels:["email"]}});
  await h.request(path(k)+"/kill",{method:"POST",headers:k.auth,json:{}});
  await deliver(); expect((await feed(k))[0].delivery).toBe("feed_only");
  const absent = await h.fundedKey(); await put(absent,base);
  await h.request(path(absent)+"/kill",{method:"POST",headers:absent.auth,json:{}});
  expect(await feed(absent)).toHaveLength(0);
  const off = await startRouter();
  try {
    const key = await off.fundedKey();
    await off.ctx.db.insert(agentPolicies).values({keyHash:key.hash,version:1,spec:{...base,models:{allow:[]},alerts:{}},sha256:"unused",updatedBy:key.hash});
    expect((await off.request("/api/v1/chat/completions",{method:"POST",headers:key.auth,json:{model:MODELS.llama.slug,messages:[{role:"user",content:"no alerts"}],max_tokens:32}})).status).toBe(200);
    expect((await off.request(path(key)+"/alerts",{headers:key.auth})).status).toBe(404);
    expect(await runAgentAlerts(off.ctx)).toEqual({skipped:"disabled",attempted:0});
    expect((await off.ctx.db.select().from(kv).where(eq(kv.key,alertStateKey((await off.ctx.db.select().from(keys).where(eq(keys.keyHash,key.hash)))[0].accountId))))).toHaveLength(0);
  } finally {await off.close();}
});

test("same-millisecond denials count separate transactions and collapse multi-model batches", async () => {
  const k = await h.fundedKey(); await put(k,{...base,alerts:{denials_in_10min:3}});
  const accountId = await account(k), now = new Date();
  for (let batch=0;batch<3;batch++) await h.ctx.db.transaction(async tx => {
    await lockAccount(tx,accountId);
    for (let intent=0;intent<2;intent++) await appendEvent(tx,{keyHash:k.hash,kind:"decision",decision:"deny",policySha256:agentPolicySha256({...base,alerts:{denials_in_10min:3}})},now);
  });
  expect(await feed(k)).toHaveLength(1); expect((await feed(k))[0].count).toBe(3);
  expect((await readAlertState(h.ctx.db,accountId)).denials?.[k.hash]).toHaveLength(3);
});
test("production config loader accepts policy alerts with existing guards intact", () => {
  const address = "0x"+"1".repeat(40);
  const env = {NODE_ENV:"production",ANYROUTE_ENV:"production",RUNTIME_ROLE:"api",AUTO_MIGRATE:"false",HOST:"0.0.0.0",APP_SECRET:"fixture-".repeat(6),ADMIN_TOKEN:"fixture-admin-".repeat(3),PUBLIC_BASE_URL:"https://router.example",DATABASE_URL:"postgres://fixture:fixture-only-credential@localhost/fixture",REDIS_URL:"redis://:fixture-only-credential@localhost:6379",CREDITS_ADDRESS:address,CALLPAY_ADDRESS:address,PROVIDER_BOND_ADDRESS:address,RECEIPT_ANCHOR_ADDRESS:address,ROUTER_PRIVATE_KEY:"0x"+"3".repeat(64),AGENT_POLICY_ENABLED:"true"};
  expect(loadConfig(env).agentPolicyEnabled).toBe(true);
  expect(loadConfig({...env,RUNTIME_ROLE:"worker",WORKER_JOBS:"agent-alerts",ROUTER_PRIVATE_KEY:undefined}).agentPolicyEnabled).toBe(true);
});
