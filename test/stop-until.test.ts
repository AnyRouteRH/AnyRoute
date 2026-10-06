// B117: timed stops use the existing authorization, account lock and event chain.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { killBody, MAX_STOP_MS, stopExpired, combinedStopFields } from "../src/agents/stop-until.ts";
import { timedAlertText } from "../src/agents/stop-text.ts";
import { agentAlertPayload } from "../src/agents/alert-delivery.ts";
import { readAlertState } from "../src/agents/alerts.ts";
import { keys } from "../src/db/schema.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
let h: Harness;
const policy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const future = () => new Date(Date.now() + 3_600_000).toISOString();
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
type Key = { hash: string; auth: Record<string, string> };
const path = (k: Key) => `/api/v1/agents/${k.hash}`;
const post = (k: Key, action: string, json?: unknown, auth = k.auth) => h.request(path(k) + "/" + action, { method: "POST", headers: auth, json });
const setup = async (extra = {}) => { const k = await h.fundedKey(); expect((await h.request(path(k) + "/policy", { method: "PUT", headers: k.auth, json: { ...policy, ...extra } })).status).toBe(200); return k; };
const row = async (k: Key) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, k.hash)))[0];
const events = async (k: Key) => (await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash)).orderBy(asc(agentPolicyEvents.id))).map(eventJson);
const expire = (k: Key) => h.ctx.db.update(agentPolicies).set({ killUntil: new Date(Date.now() - 1000) }).where(eq(agentPolicies.keyHash, k.hash));
const chat = (k: Key, extra = {}) => h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 32, provider: { only: ["alpha"] }, ...extra } });

test("deadline schema rejects past, timezone-free, malformed, and more than 30 days; deadline boundary is inclusive", () => {
  for (const until of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + MAX_STOP_MS + 10000).toISOString(), "tomorrow", "2027-01-01T09:00:00"]) expect(killBody.safeParse({ until }).success).toBe(false);
  expect(killBody.parse({ until: future() }).until).toBeDefined();
  const now = new Date(); expect(stopExpired({ killed: true, killUntil: now }, now)).toBe(true);
  expect(stopExpired({ killed: true, killUntil: null }, now)).toBe(false);
  expect(combinedStopFields([{ killed: true, stopped_until: future() }, { killed: true }])).toEqual({});
});
test("invalid deadlines are rejected without changing policy or appending an event", async () => {
  const k = await setup(); const before = await events(k);
  for (const until of [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + MAX_STOP_MS + 10000).toISOString(), "invalid"]) expect((await post(k, "kill", { until })).status).toBe(400);
  expect((await row(k)).killed).toBe(false); expect(await events(k)).toEqual(before);
});
test("stop reports ISO deadline via me, policy, list and MCP and refuses inference until expiry", async () => {
  const k = await setup(); const until = future();
  const stopped = await post(k, "kill", { until, reason: "review" }); expect(stopped.status).toBe(200); expect((await stopped.json()).data.stopped_until).toBe(until);
  for (const endpoint of [path(k) + "/policy", "/api/v1/agents/me"]) expect((await (await h.request(endpoint, { headers: k.auth })).json()).data.stopped_until).toBe(until);
  const listed = (await (await h.request("/api/v1/agents", { headers: k.auth })).json()).data.find((r: any) => r.key_hash === k.hash); expect(listed.stopped_until).toBe(until);
  const mcp = await h.request("/mcp", { method: "POST", headers: k.auth, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "anyroute_agent_rules", arguments: {} } } });
  expect(mcp.status).toBe(200); const result = (await mcp.json()).result; expect(JSON.parse(result.content[0].text).stopped_until).toBe(until);
  expect((await chat(k)).status).toBe(403); expect((await row(k)).killUntil?.toISOString()).toBe(until);
});
test("first concurrent requests after expiry resume exactly once and the hash chain verifies", async () => {
  const k = await setup(); await post(k, "kill", { until: future() }); await expire(k);
  const before = await events(k);
  expect((await (await h.request("/api/v1/agents/me", { headers: k.auth })).json()).data.killed).toBe(false);
  const check = await h.request("/api/v1/agents/check", { method: "POST", headers: k.auth, json: { kind: "inference", model: MODELS.llama.slug, lane: "public", est_cost_pico: "0", tools: [] } });
  expect((await check.json()).data.decision).toBe("allow"); expect(await events(k)).toEqual(before);
  const responses = await Promise.all([chat(k), chat(k)]); expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect((await row(k)).killed).toBe(false); expect((await row(k)).killUntil).toBeNull();
  const chain = await events(k); const resumed = chain.filter(e => e.kind === "resume"); expect(resumed).toHaveLength(1);
  expect(resumed[0].reasons).toEqual([{ code: "scheduled", message: "Scheduled stop ended." }]); expect(verifyEventChain(chain)).toBe(true);
});
test("manual resume clears deadline and preserves the legacy resumed event", async () => {
  const k = await setup(); await post(k, "kill", { until: future() });
  const r = await post(k, "resume"); expect(r.status).toBe(200); expect((await r.json()).data).not.toHaveProperty("stopped_until");
  expect((await row(k)).killUntil).toBeNull(); expect((await chat(k)).status).toBe(200);
  expect((await events(k)).filter(e => e.kind === "resumed")).toHaveLength(1); expect((await events(k)).filter(e => e.kind === "resume")).toHaveLength(0);
});
test("stop without until retains exact legacy fields, events, and indefinite enforcement", async () => {
  const k = await setup(); const data = (await (await post(k, "kill", {})).json()).data;
  expect(data).toEqual({ policy, sha256: (await row(k)).sha256, version: 1, killed: true, killed_at: (await row(k)).killedAt!.toISOString(), killed_reason: null });
  expect((await row(k)).killUntil).toBeNull(); expect((await events(k)).at(-1)?.kind).toBe("killed"); expect((await events(k)).at(-1)?.reasons).toEqual([]);
  expect((await chat(k)).status).toBe(403); expect((await row(k)).killed).toBe(true);
});
test("authentication, cross-account and inference-only guards refuse stop and resume", async () => {
  const k = await setup(), stranger = await h.fundedKey();
  const child = (await (await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { scope: "inference" } })).json());
  for (const action of ["kill", "resume"]) {
    expect((await post(k, action, {}, {})).status).toBe(401);
    expect((await post(k, action, {}, stranger.auth)).status).toBe(404);
    const denied = await post(k, action, { until: future() }, { authorization: `Bearer ${child.key}` }); expect(denied.status).toBe(403); expect((await denied.json()).error.type).toBe("inference_only");
  }
  expect((await row(k)).killed).toBe(false);
});
test("scheduled resume on a playbook follower still enforces the playbook and commits even on denial", async () => {
  const k = await setup();
  const book = (await (await h.request("/api/v1/playbooks", { method: "POST", headers: k.auth, json: { name: "Timed stop rules", policy: { ...policy, models: { allow: [] } } } })).json()).data;
  expect(book.id).toBeDefined(); expect((await post(k, "playbook", { playbook_id: book.id })).status).toBe(200);
  await post(k, "kill", { until: future() }); await expire(k);
  expect((await chat(k)).status).toBe(403); expect((await row(k)).killed).toBe(false); expect((await row(k)).playbookId).toBe(book.id);
  expect((await events(k)).filter(e => e.kind === "resume")).toHaveLength(1); expect(verifyEventChain(await events(k))).toBe(true);
});
test("action checks, inherited session and cache-hit enforcement resume after expiry", async () => {
  const k = await setup({ actions: {} });
  expect((await chat(k, { cache: { mode: "exact" } })).status).toBe(200);
  await post(k, "kill", { until: future() }); await expire(k);
  expect((await chat(k, { cache: { mode: "exact" } })).status).toBe(200); expect((await row(k)).killed).toBe(false);
  await post(k, "kill", { until: future() }); await expire(k);
  const d = await h.request("/api/v1/guard/decide", { method: "POST", headers: k.auth, json: { action: "trade.cancel", amount_usd: "0" } }); expect((await d.json()).data.decision).toBe("allow");
  const s = (await (await h.request("/api/v1/sessions", { method: "POST", headers: k.auth, json: { budget_usd: 1 } })).json()).data;
  await post(k, "kill", { until: future() }); await expire(k);
  expect((await chat({ hash: s.key_hash, auth: { authorization: `Bearer ${s.key}` } })).status).toBe(200);
  expect((await events(k)).filter(e => e.kind === "resume")).toHaveLength(3);
});
test("timed stop alerts retain and deliver the captured deadline", async () => {
  const k = await setup({ alerts: { channels: ["telegram"] } }); const until = future(); await post(k, "kill", { until });
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  const alert = (await readAlertState(h.ctx.db, key.accountId)).feed.find(a => a.kind === "killed")!;
  expect(alert.stopped_until).toBe(until); expect(agentAlertPayload(alert).stopped_until).toBe(until); expect(timedAlertText(alert)).toContain(until);
  for (const endpoint of ["/api/v1/activity?kind=alert", "/api/v1/inbox"]) {
    const r = await h.request(endpoint, { headers: k.auth }); expect(r.status).toBe(200); expect(JSON.stringify(await r.json())).toContain(`Agent stopped until ${until}`);
  }
  await post(k, "resume"); expect((await readAlertState(h.ctx.db, key.accountId)).feed[0].stopped_until).toBe(until);
});
test("default-off routes and enforcement do not resume a stored expired stop", async () => {
  const off = await startRouter();
  try {
    const k = await off.fundedKey(); await off.ctx.db.insert(agentPolicies).values({ keyHash: k.hash, version: 1, spec: policy as any, sha256: "unused", updatedBy: k.hash, killed: true, killUntil: new Date(0) });
    for (const action of ["kill", "resume"]) expect((await off.request(path(k) + "/" + action, { method: "POST", headers: k.auth, json: { until: future() } })).status).toBe(404);
    expect((await off.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 32 } })).status).toBe(200);
    expect((await off.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, k.hash)))[0].killed).toBe(true); expect(await off.ctx.db.select().from(agentPolicyEvents)).toHaveLength(0);
  } finally { await off.close(); }
});
