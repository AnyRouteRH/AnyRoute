import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { approvalRequest } from "../src/agents/approvals.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { keys, holds } from "../src/db/schema.ts";
import { reserve } from "../src/ledger/ledger.ts";
import { loadConfig } from "../src/config.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", ANYROUTE_FEATURE_COUNCIL: "true", AGENT_APPROVAL_TTL_S: "900" }, providers: [{ id:"alpha", name:"Alpha", models:[MODELS.llama,MODELS.qwen,MODELS.embed], reply: prompt => prompt.includes("Valid winners") ? '{"winner":"A"}' : undefined }, { id:"beta", name:"Beta", models:[MODELS.llamaPricey] }] }); });
afterAll(async () => { await h?.close(); });
type Auth = { auth: Record<string, string> };
const base = { version: 1, models: {}, caps: {}, approval: { above_usd: 0.000000001 }, on_breach: "deny" };
const body = { model: MODELS.llama.slug, messages: [{ role: "user", content: "approval prompt sentinel" }], max_tokens: 32, provider: { only: ["alpha"] } };
const call = (key: Auth, id?: string, extra = {}, endpoint = "/api/v1/chat/completions") => h.request(endpoint, { method: "POST", headers: { ...key.auth, ...(id === undefined ? {} : { "x-agent-approval": id }) }, json: { ...body, ...extra } });
const decision = (key: Auth, id: string, action = "approve") => h.request(`/api/v1/agents/approvals/${id}/${action}`, { method: "POST", headers: key.auth });
const put = (key: Auth & { hash: string }, spec = base) => h.request(`/api/v1/agents/${key.hash}/policy`, { method: "PUT", headers: key.auth, json: spec });
async function waiting(key: Auth) {
  const r = await call(key); expect(r.status).toBe(403);
  const error = (await r.json()).error; expect(error.type).toBe("agent_approval_required");
  expect(error.metadata.poll).toBe(`/api/v1/agents/approvals/${error.metadata.approval_id}`);
  return error.metadata.approval_id as string;
}
test("end-to-end request, reuse, status-only poll, principal approval, one use and chained events", async () => {
  const owner = await h.fundedKey();
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Research" } })).json();
  const agent = { hash: child.data.hash, auth: { authorization: `Bearer ${child.key}` } };
  await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: base });
  const before = h.mocks.alpha.stats.requests, id = await waiting(agent);
  expect(await waiting(agent)).toBe(id); expect(h.mocks.alpha.stats.requests).toBe(before);
  expect(await Promise.all([waiting(agent), waiting(agent)])).toEqual([id,id]);
  const [stored] = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id));
  expect(stored.expiresAt.getTime() - stored.requestedAt.getTime()).toBe(900000);
  expect(JSON.stringify(stored.intent)).not.toContain("approval prompt sentinel");
  const poll = await h.request(`/api/v1/agents/approvals/${id}`, { headers: agent.auth });
  expect(poll.headers.get("cache-control")).toBe("no-store");
  expect(await poll.json()).toEqual({ data: { id, status: "pending", expires_at: stored.expiresAt.toISOString() } });
  expect((await h.request("/api/v1/agents/approvals?status=pending", { headers: agent.auth })).status).toBe(403);
  expect((await decision(agent, id)).status).toBe(403);
  const list = await h.request("/api/v1/agents/approvals?status=pending", { headers: owner.auth });
  expect((await list.json()).data.some((r: any) => r.id === id)).toBe(true);
  expect((await decision(owner, id)).status).toBe(200);
  expect((await decision(owner, id, "deny")).status).toBe(409);
  expect((await call(agent, id)).status).toBe(200);
  expect((await call(agent, id)).status).toBe(403);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash)).orderBy(asc(agentPolicyEvents.id));
  for (const kind of ["approval_requested", "approval_approved", "approval_used"]) expect(events.filter(e => e.kind === kind)).toHaveLength(1);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
  expect(JSON.stringify(events)).not.toContain("approval prompt sentinel");
});
test("pending, denied, expired and random identifiers are refused; expiry permits a new pending row", async () => {
  const k = await h.fundedKey(); await put(k);
  const id = await waiting(k);
  expect((await call(k, id)).status).toBe(403);
  expect((await call(k, "unavailable")).status).toBe(403);
  expect((await decision(k, id, "deny")).status).toBe(200);
  expect((await call(k, id)).status).toBe(403);
  const newer = await waiting(k); expect(newer).not.toBe(id);
  await h.ctx.db.update(agentApprovals).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(agentApprovals.id, newer));
  expect((await (await h.request(`/api/v1/agents/approvals/${newer}`, { headers: k.auth })).json()).data.status).toBe("expired");
  expect((await decision(k, newer)).status).toBe(409);
  expect(await waiting(k)).not.toBe(newer);
  const approved = await waiting(k); await decision(k, approved);
  await h.ctx.db.update(agentApprovals).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(agentApprovals.id, approved));
  expect((await call(k, approved)).status).toBe(403);
  const kinds = (await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash))).map(e => e.kind);
  expect(kinds).toContain("approval_denied");
});
test("different key, model, lane, tools, output limit and increased cost cannot use approval", async () => {
  const k = await h.fundedKey(), other = await h.fundedKey(); await put(k); await put(other);
  const id = await waiting(k); await decision(k, id);
  expect((await call(other, id)).status).toBe(403);
  for (const extra of [{ model: MODELS.qwen.slug }, { provider: { lane: "attested", only: ["alpha"] } }, { tools: [{ type: "function", function: { name: "write", description: "secret description", parameters: {} } }] }, { max_tokens: 33 }]) expect((await call(k, id, extra)).ok).toBe(false);
  await h.ctx.db.update(agentApprovals).set({ maxCostPico: 0n }).where(eq(agentApprovals.id, id));
  expect((await call(k, id)).status).toBe(403);
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0].status).toBe("approved");
});
test("a cheaper matching intent is permitted, simultaneous attempts consume exactly once", async () => {
  const k = await h.fundedKey(); await put(k);
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  const agent = { models: [MODELS.llama.slug], lane: "public" as const, max_output_tokens: 32, body: {} };
  await expect(reserve(h.ctx.db, { id: `request-${k.hash}`, accountId: key.accountId, keyHash: k.hash, amount: 100000n, agent })).rejects.toHaveProperty("type", "agent_approval_required");
  const [approval] = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.keyHash, k.hash));
  await decision(k, approval.id);
  for (const changed of [{ ...agent, lane: "attested" as const }, { ...agent, body: { tools:[{ function:{ name:"write" } }] } }]) {
    await expect(approvalRequest.run(approval.id, () => reserve(h.ctx.db, { id:`mismatch-${k.hash}`,accountId:key.accountId,keyHash:k.hash,amount:50000n,agent:changed }))).rejects.toHaveProperty("type","agent_approval_invalid");
  }
  await expect(approvalRequest.run(approval.id, () => reserve(h.ctx.db, { id:`cost-${k.hash}`,accountId:key.accountId,keyHash:k.hash,amount:150000n,agent }))).rejects.toHaveProperty("type","agent_approval_invalid");
  const attempts = await Promise.allSettled([1,2].map(n => approvalRequest.run(approval.id, () => reserve(h.ctx.db, { id: `use-${k.hash}-${n}`, accountId: key.accountId, keyHash: k.hash, amount: 50000n, agent }))));
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(await h.ctx.db.select().from(holds).where(eq(holds.keyHash, k.hash))).toHaveLength(1);
});
test("approvals never override a newly denied rulebook or parent kill", async () => {
  const k = await h.fundedKey(); await put(k); const id = await waiting(k); await decision(k, id);
  await put(k, { ...base, models: { deny: [MODELS.llama.slug] } });
  expect((await (await call(k,id)).json()).error.type).toBe("agent_policy_denied");
  await put(k); await h.request(`/api/v1/agents/${k.hash}/kill`, { method: "POST", headers: k.auth, json: {} });
  expect((await (await call(k,id)).json()).error.type).toBe("agent_killed");
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id,id)))[0].status).toBe("approved");
});
test("failed reservation leaves approval available; cache hits cannot replay a used approval", async () => {
  const empty = await h.fundedKey(0n); await put(empty); const id = await waiting(empty); await decision(empty,id);
  expect((await call(empty,id)).ok).toBe(false);
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id,id)))[0].status).toBe("approved");
  const k = await h.fundedKey(); await put(k);
  const required = await call(k,undefined,{ cache:{ mode:"exact" } });
  expect(required.status).toBe(403); const cachedId = (await required.json()).error.metadata.approval_id; await decision(k,cachedId);
  expect((await call(k,cachedId,{ cache:{ mode:"exact" } })).status).toBe(200);
  const count = h.mocks.alpha.stats.requests;
  expect((await call(k,cachedId,{ cache:{ mode:"exact" } })).status).toBe(403);
  expect(h.mocks.alpha.stats.requests).toBe(count);
});
test("principal auth isolates accounts, team admins and sessions", async () => {
  const owner = await h.fundedKey(), stranger = await h.fundedKey(); await put(owner); const id = await waiting(owner);
  expect((await decision(stranger,id)).status).toBe(404);
  expect((await h.request(`/api/v1/agents/approvals/${id}`, { headers: stranger.auth })).status).toBe(404);
  expect((await h.request(`/api/v1/agents/approvals/${id}/approve`, { method:"POST" })).status).toBe(401);
  const team = (await (await h.request("/api/v1/teams",{ method:"POST",headers:owner.auth,json:{ name:"approval-team" } })).json()).data;
  const target = await (await h.request("/api/v1/keys",{ method:"POST",headers:owner.auth,json:{ team:team.id } })).json();
  const agent = { hash:target.data.hash,auth:{ authorization:`Bearer ${target.key}` } };
  await h.request(`/api/v1/agents/${agent.hash}/policy`,{ method:"PUT",headers:owner.auth,json:base }); const teamId = await waiting(agent);
  for (const role of ["member","viewer","admin"] as const) {
    const created = await (await h.request("/api/v1/keys",{ method:"POST",headers:owner.auth,json:{ team:team.id,role } })).json();
    const key = { auth:{ authorization:`Bearer ${created.key}` } };
    expect((await decision(key,id)).status).toBe(403);
    expect((await decision(key,teamId)).status).toBe(role === "admin" ? 200 : 403);
  }
  const session = (await (await h.request("/api/v1/sessions",{ method:"POST",headers:owner.auth,json:{ budget_usd:1 } })).json()).data;
  expect((await decision({ auth:{ authorization:`Bearer ${session.key}` } },id)).status).toBe(403);
});
test("approval header survives in-process responses adapter and council binds all models", async () => {
  const k = await h.fundedKey(); await put(k);
  const r = await call(k,undefined,{ input:"hello",messages:undefined },"/v1/responses");
  expect(r.status).toBe(403); const id = (await r.json()).error.metadata.approval_id; await decision(k,id);
  expect((await call(k,id,{ input:"hello",messages:undefined },"/v1/responses")).status).toBe(200);
  const extra = { model:"anyroute/council",council:{ models:[MODELS.llama.slug,MODELS.qwen.slug],judge:MODELS.llama.slug } };
  const council = await call(k,undefined,extra); expect(council.status).toBe(403); const cid = (await council.json()).error.metadata.approval_id; await decision(k,cid);
  expect((await call(k,cid)).status).toBe(403);
  expect((await call(k,cid,extra)).status).toBe(200);
});
test("flag off preserves requests, hides every approval endpoint and records nothing", async () => {
  const off = await startRouter();
  try {
    const k = await off.fundedKey();
    for (const [path,method] of [["","GET"],["/absent","GET"],["/absent/approve","POST"],["/absent/deny","POST"]]) expect((await off.request('/api/v1/agents/approvals'+path,{ method,headers:k.auth })).status).toBe(404);
    expect((await off.request('/api/v1/chat/completions',{ method:"POST",headers:{ ...k.auth,"x-agent-approval":"absent" },json:body })).status).toBe(200);
    expect(await off.ctx.db.select().from(agentApprovals)).toHaveLength(0);
  } finally { await off.close(); }
});
test("production loader accepts enabled approvals and validates TTL", () => {
  const address = '0x'+'1'.repeat(40);
  const env = { NODE_ENV:'production',ANYROUTE_ENV:'production',RUNTIME_ROLE:'api',AUTO_MIGRATE:'false',HOST:'0.0.0.0',APP_SECRET:'fixture-'.repeat(6),ADMIN_TOKEN:'fixture-admin-'.repeat(3),PUBLIC_BASE_URL:'https://router.example',DATABASE_URL:'postgres://fixture:fixture-only-credential@localhost/fixture',REDIS_URL:'redis://:fixture-only-credential@localhost:6379',CREDITS_ADDRESS:address,CALLPAY_ADDRESS:address,PROVIDER_BOND_ADDRESS:address,RECEIPT_ANCHOR_ADDRESS:address,ROUTER_PRIVATE_KEY:'0x'+'3'.repeat(64),AGENT_POLICY_ENABLED:'true',AGENT_APPROVAL_TTL_S:'600' };
  expect(loadConfig(env).agentApprovalTtlS).toBe(600);
  expect(loadConfig({ ANYROUTE_ENV:'test' }).agentApprovalTtlS).toBe(900);
  expect(() => loadConfig({ ...env,AGENT_APPROVAL_TTL_S:'0' })).toThrow();
});
