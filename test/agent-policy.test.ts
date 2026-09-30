import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, policiesFor, policyState, pruneAgentPolicyEvents, verifyEventChain } from "../src/agents/store.ts";
import { accounts, holds, keys, ledger } from "../src/db/schema.ts";
import { reserve, settle, balanceOf } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { loadConfig } from "../src/config.ts";
import { startRouter, type Harness, MODELS } from "./helpers.ts";
import type { AgentPolicy } from "../src/agents/policy.ts";
let h: Harness;
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const inference = { kind: "inference", model: MODELS.llama.slug, lane: "public", est_cost_pico: "100000000000", max_output_tokens: 32, tools: [] };
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", ANYROUTE_FEATURE_COUNCIL: "true" } }); });
afterAll(async () => { await h?.close(); });
const path = (k: { hash: string }) => `/api/v1/agents/${k.hash}`;
const put = (k: { hash: string; auth: Record<string, string> }, policy: AgentPolicy) => h.request(path(k) + "/policy", { method: "PUT", headers: k.auth, json: policy });
const call = (k: { auth: Record<string, string> }, extra: object = {}, endpoint = "/api/v1/chat/completions") => h.request(endpoint, { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "prompt must never be retained in policy events" }], max_tokens: 32, provider: { only: ["alpha"] }, ...extra } });
const count = async (table: typeof holds | typeof agentPolicyEvents) => (await h.ctx.db.select().from(table)).length;

test("flag defaults off, all routes 404, existing inference unchanged even with stored rulebook", async () => {
  const off = await startRouter();
  try {
    const k = await off.fundedKey();
    await off.ctx.db.insert(agentPolicies).values({ keyHash: k.hash, version: 1, spec: { ...base, models: { allow: [] } }, sha256: "unused", updatedBy: k.hash, killed: true });
    for (const [p, method] of [["", "GET"], ["/me", "GET"], ["/check", "POST"], [`/${k.hash}/policy`, "GET"], [`/${k.hash}/policy`, "PUT"], [`/${k.hash}/policy`, "DELETE"], [`/${k.hash}/kill`, "POST"], [`/${k.hash}/resume`, "POST"], [`/${k.hash}/events`, "GET"]]) {
      const r = await off.request(`/api/v1/agents${p}`, { method, headers: k.auth, json: method === "POST" || method === "PUT" ? {} : undefined });
      expect(r.status).toBe(404); expect((await r.json()).error.type).toBe("not_found");
    }
    expect((await off.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 32 } })).status).toBe(200);
    expect(await off.ctx.db.select().from(agentPolicyEvents)).toHaveLength(0);
  } finally { await off.close(); }
});
test("keys without a rulebook create no policy events", async () => {
  const k = await h.fundedKey(); const n = await count(agentPolicyEvents);
  expect((await call(k)).status).toBe(200); expect(await count(agentPolicyEvents)).toBe(n);
});
for (const [code, spec, extra] of [
  ["model_not_allowed", { models: { allow: ["other/*"] } }, {}],
  ["lane_not_allowed", { lanes: ["attested"] }, {}],
  ["over_per_request", { caps: { per_request_usd: 0.000000001 } }, {}],
  ["over_per_hour", { caps: { per_hour_usd: 0.000000001 } }, {}],
  ["over_per_day", { caps: { per_day_usd: 0.000000001 } }, {}],
  ["over_per_week", { caps: { per_week_usd: 0.000000001 } }, {}],
  ["max_tokens", { caps: { max_output_tokens: 31 } }, {}],
  ["tool_not_allowed", { tools: { deny: ["write"] } }, { tools: [{ type: "function", function: { name: "write", description: "never store this tool description", parameters: { type: "object" } } }] }],
  ["outside_window", { windows: [] }, {}],
  ["approval_required", { approval: { above_usd: 0.000000001 } }, {}],
] as const) test(`HTTP denial ${code} persists metadata and reserves/charges nothing`, async () => {
  const k = await h.fundedKey(); expect((await put(k, { ...base, ...spec } as AgentPolicy)).status).toBe(200);
  const before = await balanceOf(h.ctx.db, (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId);
  const held = await count(holds); const calls = h.mocks.alpha.stats.requests;
  const r = await call(k, extra); expect(r.status).toBe(403);
  const err = (await r.json()).error;
  expect(err.type).toBe(code === "approval_required" ? "agent_approval_required" : "agent_policy_denied");
  expect(err.metadata.reasons.map((r: any) => r.code)).toContain(code); expect(err.metadata.policy_sha256).toHaveLength(64);
  expect(await count(holds)).toBe(held); expect(h.mocks.alpha.stats.requests).toBe(calls);
  expect(await balanceOf(h.ctx.db, (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId)).toEqual(before);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash));
  expect(events).toHaveLength(code === "approval_required" ? 3 : 2); expect(events[1].decision).toBe(code === "approval_required" ? "approval_required" : "deny");
  expect(JSON.stringify(events)).not.toContain("prompt must never"); expect(JSON.stringify(events)).not.toContain("never store this tool description");
});
test("charged spend rolling hour/day/week, older charges excluded and open holds counted", async () => {
  const k = await h.fundedKey(20n); await put(k, base);
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  for (const [age, cost] of [[0.5, 1], [2, 2], [30, 3], [180, 4]]) await h.ctx.db.insert(ledger).values({ id: `agent-${k.hash}-${age}`, accountId: key.accountId, keyHash: k.hash, amount: -usdToPico(cost), kind: "usage", ref: `agent-${k.hash}-${age}`, createdAt: new Date(Date.now() - age * 3_600_000) });
  const [row] = await policiesFor(h.ctx.db, k.hash);
  expect((await policyState(h.ctx.db, row, new Date())).spent_pico).toEqual({ hour: usdToPico(1), day: usdToPico(3), week: usdToPico(6) });
  for (const [window, cap] of [["hour", 1], ["day", 3], ["week", 6]] as const) {
    await put(k, { ...base, caps: { [`per_${window}_usd`]: cap } });
    expect((await call(k)).status).toBe(403);
  }
  await put(k, base);
  await reserve(h.ctx.db, { id: `agent-hold-${k.hash}`, accountId: key.accountId, keyHash: k.hash, amount: usdToPico(0.25), agent: { models: [MODELS.llama.slug], lane: "public", max_output_tokens: 32, body: {} } });
  expect((await policyState(h.ctx.db, row, new Date())).spent_pico).toEqual({ hour: usdToPico(1.25), day: usdToPico(3.25), week: usdToPico(6.25) });
});
test("simultaneous reservations cannot race past the rolling cap", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, caps: { per_hour_usd: 1 } });
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  const results = await Promise.allSettled([1, 2].map(i => reserve(h.ctx.db, { id: `agent-race-${k.hash}-${i}`, accountId: key.accountId, keyHash: k.hash, amount: usdToPico(0.6), agent: { models: [MODELS.llama.slug], lane: "public", max_output_tokens: 32, body: {} } })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
});
test("session must pass both own and parent rules; parent spend includes child charges", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, models: { deny: [MODELS.llama.slug] } });
  const s = (await (await h.request("/api/v1/sessions", { method: "POST", headers: k.auth, json: { budget_usd: 1 } })).json()).data;
  const session = { hash: s.key_hash, auth: { authorization: `Bearer ${s.key}` } };
  expect((await call(session)).status).toBe(403);
  await put(k, base);
  expect((await h.request(path(session) + "/policy", { method: "PUT", headers: k.auth, json: { ...base, models: { deny: [MODELS.llama.slug] } } })).status).toBe(200);
  expect((await call(session)).status).toBe(403);
  await h.request(path(session) + "/policy", { method: "DELETE", headers: k.auth });
  expect((await call(session)).status).toBe(200);
  expect((await policyState(h.ctx.db, (await policiesFor(h.ctx.db, k.hash))[0], new Date())).spent_pico.hour).toBeGreaterThan(0n);
  const me = (await (await h.request("/api/v1/agents/me", { headers: session.auth })).json()).data;
  expect(me.policies[0].inherited).toBe(true);
  expect((await h.request("/api/v1/agents", { headers: session.auth })).status).toBe(403);
});
test("principal kill is immediately visible on a second app sharing the database; policy update never clears it", async () => {
  const k = await h.fundedKey(); await put(k, base);
  const other = await createApp({ env: { ANYROUTE_ENV: "test", DATABASE_URL: h.ctx.cfg.databaseUrl, REDIS_URL: process.env.TEST_REDIS_URL ?? "", AGENT_POLICY_ENABLED: "true", APP_SECRET: h.ctx.cfg.appSecret, LOG_LEVEL: "error", WORKERS: "false", ALLOW_DEV_ATTESTATION: "true" }, chain: h.chain, startJobs: false });
  try {
    expect((await h.request(path(k) + "/kill", { method: "POST", headers: k.auth, json: { reason: "principal stop" } })).status).toBe(200);
    await put(k, base);
    const r = await other.app.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "content-type": "application/json" }, body: JSON.stringify({ model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 32 }) });
    expect(r.status).toBe(403); expect((await r.json()).error.type).toBe("agent_killed");
    expect((await h.request(path(k) + "/resume", { method: "POST", headers: k.auth })).status).toBe(200);
    expect((await call(k)).status).toBe(200);
  } finally { await other.close(); }
});
test("on_breach kill commits with denied event; dry run never records or kills", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, models: { allow: [] }, on_breach: "kill" });
  const n = await count(agentPolicyEvents);
  const check = await h.request("/api/v1/agents/check", { method: "POST", headers: k.auth, json: inference });
  expect((await check.json()).data.decision).toBe("deny"); expect(await count(agentPolicyEvents)).toBe(n);
  expect((await policiesFor(h.ctx.db, k.hash))[0].killed).toBe(false);
  expect((await call(k)).status).toBe(403); expect((await policiesFor(h.ctx.db, k.hash))[0].killed).toBe(true);
  const next = await call(k); expect((await next.json()).error.type).toBe("agent_killed");
});
test("principal permission follows key editing: member/viewer forbidden, other account hidden, admin scoped", async () => {
  const owner = await h.fundedKey(), stranger = await h.fundedKey();
  const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "agent-role" } })).json()).data;
  const target = (await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team: team.id } })).json()).data;
  for (const role of ["member", "viewer", "admin"] as const) {
    const created = (await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team: team.id, role } })).json());
    const auth = { authorization: `Bearer ${created.key}` };
    const r = await h.request(`/api/v1/agents/${target.hash}/policy`, { method: "PUT", headers: auth, json: base });
    expect(r.status).toBe(role === "admin" ? 200 : 403);
    if (role === "admin") expect((await h.request(path(owner) + "/policy", { method: "PUT", headers: auth, json: base })).status).toBe(403);
  }
  expect((await h.request(`/api/v1/agents/${target.hash}/policy`, { method: "PUT", headers: stranger.auth, json: base })).status).toBe(404);
});
test("adapters, embeddings and MCP pass through enforcement; legacy functions and Anthropic names collected", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, tools: { deny: ["write", "list_models"] } });
  expect((await call(k, { functions: [{ name: "write", parameters: {} }] }, "/api/v1/completions")).status).toBe(400); // Completion requires a prompt.
  expect((await call(k, { prompt: "hi", functions: [{ name: "write", parameters: {} }] }, "/api/v1/completions")).status).toBe(403);
  expect((await call(k, { input: "hi", tools: [{ type: "function", name: "write", parameters: {} }] }, "/v1/responses")).status).toBe(403);
  expect((await call(k, { tools: [{ name: "write", input_schema: { type: "object" } }] }, "/v1/messages")).status).toBe(403);
  const mcp = await h.request("/mcp", { method: "POST", headers: k.auth, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_models", arguments: {} } } });
  expect(mcp.status).toBe(403); expect((await mcp.json()).error.type).toBe("agent_policy_denied");
  await put(k, { ...base, models: { allow: [] } });
  expect((await call(k, { model: MODELS.embed.slug, input: "hi" }, "/api/v1/embeddings")).status).toBe(403);
  expect((await h.request("/mcp", { method: "POST", headers: k.auth, json: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chat", arguments: { model: MODELS.llama.slug, prompt: "hi", max_tokens: 32 } } } })).status).toBe(403);
});
test("event chain verifies, tampering fails, cursor pages 50 newest first; retention expires old events", async () => {
  const k = await h.fundedKey(); await put(k, base); expect((await call(k)).status).toBe(200);
  for (let i = 0; i < 51; i++) await put(k, base);
  const rows = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(rows.some(r => r.decision === "allow")).toBe(true); const events = rows.map(eventJson);
  expect(verifyEventChain(events)).toBe(true); expect(verifyEventChain(events.map((r, i) => i === 1 ? { ...r, kind: "resumed" } : r))).toBe(false);
  const page = (await (await h.request(path(k) + "/events", { headers: k.auth })).json()); expect(page.data).toHaveLength(50);
  const next = (await (await h.request(path(k) + `/events?cursor=${page.next_cursor}`, { headers: k.auth })).json()); expect(next.data).toHaveLength(3);
  expect(next.data[0].id).toBeLessThan(page.data.at(-1).id);
  expect(await pruneAgentPolicyEvents(h.ctx.db, new Date(Date.now() + 91 * 86_400_000))).toBeGreaterThan(0);
  expect(await h.ctx.db.select().from(agentPolicyEvents)).toHaveLength(0);
});
test("real production loader starts API and cleanup worker with policy enabled", () => {
  const address = "0x" + "1".repeat(40);
  const env = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), AGENT_POLICY_ENABLED: "true" };
  expect(loadConfig(env).agentPolicyEnabled).toBe(true);
  expect(loadConfig({ ...env, RUNTIME_ROLE: "worker", WORKER_JOBS: "agent-policy-retention", ROUTER_PRIVATE_KEY: "" }).agentPolicyEnabled).toBe(true);
  expect(loadConfig({ ANYROUTE_ENV: "test" }).agentPolicyEnabled).toBe(false);
});

test("council denies a later seat before any hold or provider call; stream also refuses before headers", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, models: { deny: [MODELS.qwen.slug] } });
  const held = await count(holds), calls = h.mocks.alpha.stats.requests;
  const r = await call(k, { model: "anyroute/council", council: { models: [MODELS.llama.slug, MODELS.qwen.slug], judge: MODELS.llama.slug } });
  expect(r.status).toBe(403); expect((await r.json()).error.type).toBe("agent_policy_denied");
  expect(await count(holds)).toBe(held); expect(h.mocks.alpha.stats.requests).toBe(calls);
  await put(k, { ...base, models: { allow: [] } });
  const stream = await call(k, { stream: true }); expect(stream.status).toBe(403); expect(stream.headers.get("content-type")).toContain("application/json");
});
test("cache hits still honor a committed kill", async () => {
  const k = await h.fundedKey(); await put(k, base);
  expect((await call(k, { cache: { mode: "exact" } })).status).toBe(200);
  const n = h.mocks.alpha.stats.requests;
  expect((await call(k, { cache: { mode: "exact" } })).status).toBe(200); expect(h.mocks.alpha.stats.requests).toBe(n);
  await h.request(path(k) + "/kill", { method: "POST", headers: k.auth, json: {} });
  expect((await call(k, { cache: { mode: "exact" } })).status).toBe(403); expect(h.mocks.alpha.stats.requests).toBe(n);
});
test("a session denial takes precedence over an inherited approval requirement", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, approval: { above_usd: 0.000000001 } });
  const s = (await (await h.request("/api/v1/sessions", { method: "POST", headers: k.auth, json: { budget_usd: 1 } })).json()).data;
  await h.request(`/api/v1/agents/${s.key_hash}/policy`, { method: "PUT", headers: k.auth, json: { ...base, models: { allow: [] } } });
  const r = await call({ auth: { authorization: `Bearer ${s.key}` } });
  expect(r.status).toBe(403); expect((await r.json()).error.type).toBe("agent_policy_denied");
});
test("no-rulebook reservation never builds intent metadata; output caps include all choices", async () => {
  const k = await h.fundedKey(); const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  await reserve(h.ctx.db, { id: `no-policy-${k.hash}`, accountId: key.accountId, keyHash: k.hash, amount: 1n, agent: () => { throw new Error("must not inspect intent without a rulebook"); } });
  await put(k, { ...base, caps: { max_output_tokens: 32 } });
  expect((await call(k, { n: 2 })).status).toBe(403);
});
test("me reports the tightest remaining rolling cap across parent and session policies", async () => {
  const k = await h.fundedKey(); await put(k, { ...base, caps: { per_hour_usd: 1, per_day_usd: 4 } });
  const s = (await (await h.request("/api/v1/sessions", { method: "POST", headers: k.auth, json: { budget_usd: 5 } })).json()).data;
  await h.request(`/api/v1/agents/${s.key_hash}/policy`, { method: "PUT", headers: k.auth, json: { ...base, caps: { per_hour_usd: 3, per_day_usd: 2 } } });
  const r = await h.request("/api/v1/agents/me", { headers: { authorization: `Bearer ${s.key}` } });
  expect((await r.json()).data.remaining).toEqual({ hour: 1, day: 2, week: null });
});
