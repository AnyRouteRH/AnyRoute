import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { agentPolicySchema, agentPolicySha256, type AgentPolicy, type AgentIntent } from "../src/agents/policy.ts";
import { evaluateAgentPolicy, type AgentPolicyState } from "../src/agents/evaluate.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { appendEvent, eventJson, policiesFor, policyState, verifyEventChain } from "../src/agents/store.ts";
import { loadBreakerState } from "../src/agents/breaker-state.ts";
import { keys, ledger, holds } from "../src/db/schema.ts";
import { reserve, balanceOf } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const intent: AgentIntent = { kind: "inference", model: MODELS.llama.slug, lane: "public", est_cost_pico: 0n, tools: [], max_output_tokens: 32 };
const blank: AgentPolicyState = { killed: false, spent_pico: { hour: 0n, day: 0n, week: 0n }, breakers: { spent_minute_pico: 0n, requests_minute: 0, denials_10min: 0, distinct_models_hour: 0, models_hour: [] } };
const fields = [
  ["max_spend_usd_per_minute", "spent_minute_pico", usdToPico(2), usdToPico(2) - 1n],
  ["max_requests_per_minute", "requests_minute", 2, 1],
  ["max_denials_per_10min", "denials_10min", 2, 1],
  ["max_distinct_models_per_hour", "distinct_models_hour", 2, 1],
] as const;
for (const [name, field, at, below] of fields) test(`${name}: inclusive recorded threshold, deterministic and restrictive`, () => {
  const p = { ...base, breakers: { [name]: 2 } };
  const state = (value: bigint | number) => ({ ...blank, breakers: { ...blank.breakers!, [field]: value } });
  expect(evaluateAgentPolicy(p, state(below), intent, new Date()).decision).toBe("allow");
  const result = evaluateAgentPolicy(p, state(at), intent, new Date());
  expect(result).toEqual({ decision: "deny", reasons: [{ code: `breaker:${name}`, message: result.reasons[0].message }] });
  expect(evaluateAgentPolicy(p, state(at), intent, new Date())).toEqual(result);
  expect(evaluateAgentPolicy({ ...p, models: { allow: [] } }, state(below), intent, new Date()).reasons[0].code).toBe("model_not_allowed");
});
test("breakers absent preserve canonical SHA and decision; strict optional bounds", () => {
  expect(agentPolicySha256(base)).toBe(sha256(canonicalJson(base)));
  expect(agentPolicySchema.parse(base)).toEqual(base);
  expect(evaluateAgentPolicy(base, blank, intent, new Date())).toEqual({ decision: "allow", reasons: [] });
  for (const [name] of fields) for (const n of [0, -1, Infinity, NaN]) expect(agentPolicySchema.safeParse({ ...base, breakers: { [name]: n } }).success).toBe(false);
  for (const [name] of fields.slice(1)) expect(agentPolicySchema.safeParse({ ...base, breakers: { [name]: 1.5 } }).success).toBe(false);
  expect(agentPolicySchema.safeParse({ ...base, breakers: { max_spend_usd_per_minute: 1_000_001 } }).success).toBe(false);
  expect(agentPolicySchema.safeParse({ ...base, breakers: { unknown: 1 } }).success).toBe(false);
  expect(() => evaluateAgentPolicy({ ...base, breakers: { max_requests_per_minute: 1 } }, { killed: false, spent_pico: blank.spent_pico }, intent, new Date())).toThrow("Breaker state is required");
});
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", ANYROUTE_FEATURE_COUNCIL: "true" } }); });
afterAll(async () => { await h?.close(); });
type Key = Awaited<ReturnType<Harness["fundedKey"]>>;
const path = (k: Key) => `/api/v1/agents/${k.hash}`;
const put = (k: Key, spec: AgentPolicy) => h.request(path(k)+"/policy", { method: "PUT", headers: k.auth, json: spec });
const call = (k: Pick<Key, "auth">, extra: object = {}) => h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "must not appear in breaker events" }], max_tokens: 32, provider: { only: ["alpha"] }, ...extra } });
async function assertTrip(k: Key, name: string) {
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  const wasKilled = (await policiesFor(h.ctx.db,k.hash))[0].killed;
  const before = await balanceOf(h.ctx.db, key.accountId), held = await h.ctx.db.select().from(holds), calls = h.mocks.alpha.stats.requests;
  const r = await call(k); expect(r.status).toBe(403);
  const error = (await r.json()).error; expect(error.type).toBe("agent_killed"); expect(error.metadata.reasons.map((r: any) => r.code)).toContain(wasKilled ? "killed" : `breaker:${name}`);
  expect(await balanceOf(h.ctx.db, key.accountId)).toEqual(before); expect(await h.ctx.db.select().from(holds)).toHaveLength(held.length); expect(h.mocks.alpha.stats.requests).toBe(calls);
  expect((await policiesFor(h.ctx.db, k.hash))[0].killedReason).toBe(`breaker:${name}`);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(events.some(e => e.kind === "killed")).toBe(true); expect(verifyEventChain(events.map(eventJson))).toBe(true);
  expect(JSON.stringify(events)).not.toContain("must not appear");
}
test("request limit admits exactly N concurrent requests, then kills, resume clears; caps retain spend", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, breakers: { max_requests_per_minute: 2 } });
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  const results = await Promise.allSettled([1,2,3,4].map(i => reserve(h.ctx.db, { id: `breaker-${k.hash}-${i}`, accountId: key.accountId, keyHash: k.hash, amount: usdToPico(0.1), agent: { models: [intent.model], lane: "public", max_output_tokens: 32, body: {} } })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2); expect(results.filter(r => r.status === "rejected")).toHaveLength(2);
  for (const r of results) if (r.status === "rejected") expect(r.reason.type).toBe("agent_killed");
  expect((await policiesFor(h.ctx.db, k.hash))[0].killedReason).toBe("breaker:max_requests_per_minute");
  const r = await h.request(path(k)+"/resume", { method:"POST",headers:k.auth }); expect(r.status).toBe(200); expect((await r.json()).data.killed_reason).toBeNull();
  const row = (await policiesFor(h.ctx.db, k.hash))[0]; const state = await policyState(h.ctx.db,row,new Date());
  expect(state.breakers).toEqual(blank.breakers); expect(state.spent_pico.hour).toBe(usdToPico(0.2));
  expect((await call(k)).status).toBe(200);
});
test("recorded spend and open holds trip at exact threshold across concurrent admissions", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, breakers:{max_spend_usd_per_minute:1} });
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash,k.hash));
  await h.ctx.db.insert(ledger).values({ id:`breaker-spend-${k.hash}`,ref:`breaker-spend-${k.hash}`,accountId:key.accountId,keyHash:k.hash,kind:"usage",amount:-usdToPico(0.5) });
  expect((await loadBreakerState(h.ctx.db,k.hash,new Date())).spent_minute_pico).toBe(usdToPico(0.5));
  const results = await Promise.allSettled([1,2].map(i => reserve(h.ctx.db,{id:`breaker-spend-hold-${k.hash}-${i}`,accountId:key.accountId,keyHash:k.hash,amount:usdToPico(0.5),agent:{models:[intent.model],lane:"public",max_output_tokens:32,body:{}}})));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  await assertTrip(k,"max_spend_usd_per_minute");
});
test("exact recorded denial threshold kills even on_breach deny; resume is owner-only", async () => {
  const k = await h.fundedKey(); await put(k,{...base,models:{allow:[]},breakers:{max_denials_per_10min:2}});
  for (let i=0;i<2;i++) { const r=await call(k); expect((await r.json()).error.type).toBe("agent_policy_denied"); expect((await policiesFor(h.ctx.db,k.hash))[0].killed).toBe(false); }
  await assertTrip(k,"max_denials_per_10min");
  const s=(await (await h.request("/api/v1/sessions",{method:"POST",headers:k.auth,json:{budget_usd:1}})).json()).data;
  expect((await h.request(path(k)+"/resume",{method:"POST",headers:{authorization:`Bearer ${s.key}`}})).status).toBe(403);
  expect((await h.request(path(k)+"/resume",{method:"POST",headers:k.auth})).status).toBe(200);
  await put(k,{...base,breakers:{max_denials_per_10min:2}}); expect((await call(k)).status).toBe(200);
});
test("distinct models count metadata across inherited sessions and ignores repeated models", async () => {
  const k=await h.fundedKey(); await put(k,{...base,breakers:{max_distinct_models_per_hour:2}});
  const s=(await (await h.request("/api/v1/sessions",{method:"POST",headers:k.auth,json:{budget_usd:1}})).json()).data;
  const child={auth:{authorization:`Bearer ${s.key}`}};
  for (let i=0;i<2;i++) expect((await call(child)).status).toBe(200);
  expect((await loadBreakerState(h.ctx.db,k.hash,new Date())).distinct_models_hour).toBe(1);
  expect((await call(child,{model:MODELS.qwen.slug})).status).toBe(200);
  expect((await loadBreakerState(h.ctx.db,k.hash,new Date())).distinct_models_hour).toBe(2);
  await assertTrip(k,"max_distinct_models_per_hour");
});
test("dry run is read-only; rolling windows exclude exact lower boundary and future events", async () => {
  const k=await h.fundedKey(); await put(k,{...base,breakers:{max_requests_per_minute:1}});
  const row=(await policiesFor(h.ctx.db,k.hash))[0], now=new Date("2030-01-01T12:00:00Z");
  for (const age of [60_000,600_000,3_600_000,-1]) await appendEvent(h.ctx.db,{keyHash:k.hash,kind:"breaker_request",decision:"deny",intent:{...intent,est_cost_pico:"0"},policySha256:row.sha256},new Date(now.getTime()-age));
  expect(await loadBreakerState(h.ctx.db,k.hash,now)).toEqual({spent_minute_pico:0n,requests_minute:0,denials_10min:1,distinct_models_hour:1,models_hour:[intent.model]});
  const n=(await h.ctx.db.select().from(agentPolicyEvents)).length;
  expect((await h.request("/api/v1/agents/check",{method:"POST",headers:k.auth,json:{...intent,est_cost_pico:"0"}})).status).toBe(200);
  expect(await h.ctx.db.select().from(agentPolicyEvents)).toHaveLength(n); expect((await policiesFor(h.ctx.db,k.hash))[0].killed).toBe(false);
});
test("multi-model admission counts one request, includes every model",async()=>{
  const k=await h.fundedKey(); await put(k,{...base,breakers:{max_requests_per_minute:2}});
  const [key]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,k.hash));
  await reserve(h.ctx.db,{id:`breaker-multi-${k.hash}`,accountId:key.accountId,keyHash:k.hash,amount:1n,agent:{models:[MODELS.llama.slug,MODELS.qwen.slug],lane:"public",max_output_tokens:32,body:{}}});
  const state=await loadBreakerState(h.ctx.db,k.hash,new Date()); expect(state.requests_minute).toBe(1);expect(state.distinct_models_hour).toBe(2);
});

test("projected spend cannot cross the limit under concurrent reservations",async()=>{
 const k=await h.fundedKey();await put(k,{...base,breakers:{max_spend_usd_per_minute:1}});
 const [key]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,k.hash));
 const results=await Promise.allSettled([1,2].map(i=>reserve(h.ctx.db,{id:`breaker-cross-${k.hash}-${i}`,accountId:key.accountId,keyHash:k.hash,amount:usdToPico(0.6),agent:{models:[intent.model],lane:"public",max_output_tokens:32,body:{}}})));
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
 expect((await loadBreakerState(h.ctx.db,k.hash,new Date())).spent_minute_pico).toBe(usdToPico(0.6));
});
test("one batch cannot cross the distinct-model limit before any model is admitted",async()=>{
 const k=await h.fundedKey();await put(k,{...base,breakers:{max_distinct_models_per_hour:1}});
 const [key]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,k.hash));
 await expect(reserve(h.ctx.db,{id:`breaker-cross-model-${k.hash}`,accountId:key.accountId,keyHash:k.hash,amount:1n,agent:{models:[MODELS.llama.slug,MODELS.qwen.slug],lane:"public",max_output_tokens:32,body:{}}})).rejects.toMatchObject({type:"agent_killed"});
 expect(await h.ctx.db.select().from(holds).where(eq(holds.keyHash,k.hash))).toHaveLength(0);
});
