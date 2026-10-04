import { keys } from "../src/db/schema.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { createPublicKey, verify } from "node:crypto";
import { agentPolicySchema, agentIntentSchema, intentJson, canonicalJson } from "../src/agents/policy.ts";
import { evaluateAgentPolicy, type AgentPolicyState } from "../src/agents/evaluate.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { agentActionDecisions } from "../src/agents/guard-schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { appendEvent, lockAccount, policyState, eventJson, verifyEventChain } from "../src/agents/store.ts";
import { consumeCode } from "../src/telegram/linking.ts";
import { TelegramApi } from "../src/services/telegram.ts";
import { handleLinkedUpdate, deliverTelegramApprovals } from "../src/telegram/delivery.ts";
import { approvalText } from "../src/telegram/delivery.ts";
import { guardMcpArgs, guardMcpTools } from "../src/api/mcp-agent.ts";
import { loadConfig } from "../src/config.ts";
import { inferenceRouteAllowed } from "../src/provisioning/scope.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { GUARD_STARTERS } from "../web/lib/agent-guard.js";
import { readFileSync } from "node:fs";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true", TOOLS_MARKET_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123:fixture-only-bot-token-value" } }); });
afterAll(async () => { await h?.close(); });
const policy = (actions?: Record<string, unknown>, extra = {}) => agentPolicySchema.parse({ version: 1, models: {}, caps: {}, on_breach: "deny", ...(actions === undefined ? {} : { actions }), ...extra });
const state: AgentPolicyState = { killed: false, spent_pico: { hour: 0n, day: 0n, week: 0n }, actions_pico_day: 0n, actions_hour: 0 };
const intent = (extra = {}) => agentIntentSchema.parse({ kind: "action", action: "trade.order", amount_pico: "360000000000000", target: "NVDA", ...extra });
const now = new Date("2026-10-02T15:00:00Z");
const codes = (p: ReturnType<typeof policy>, i = intent(), s = state, at = now) => evaluateAgentPolicy(p, s, i, at).reasons.map(r => r.code);
const hash = "sha256:" + "a".repeat(64);
type Auth = { auth: Record<string, string>; hash?: string };
const decide = async (k: Auth, body = {}, router = h) => (await router.request("/api/v1/guard/decide", { method: "POST", headers: k.auth, json: { action: "trade.order", target: "NVDA", amount_usd: "360.00", details_sha256: hash, ...body } })).json();
const put = (owner: Auth, target: string, p: unknown) => h.request(`/api/v1/agents/${target}/policy`, { method: "PUT", headers: owner.auth, json: p });
const approve = (owner: Auth, id: string) => h.request(`/api/v1/agents/approvals/${id}/approve`, { method: "POST", headers: owner.auth });
const outcome = (key: Auth, id: string, status = "executed", amount_usd?: string) => h.request(`/api/v1/guard/decisions/${id}/outcome`, { method: "POST", headers: key.auth, json: { status, ...(amount_usd === undefined ? {} : { amount_usd }) } });

test("action evaluator fails closed, exact/prefix deny wins, targets ignore case but approvals do not", () => {
  expect(codes(policy())).toEqual(["actions_not_configured"]);
  expect(codes(policy({ allow: ["trade.*"], deny: ["trade.cancel"] }))).toEqual([]);
  expect(codes(policy({ allow: ["trade.*"], deny: ["trade.*"] }))).toContain("action_not_allowed");
  expect(codes(policy({ allow: ["trade"] }))).toContain("action_not_allowed");
  expect(codes(policy({ targets: { allow: ["nvda"] } }))).toEqual([]);
  expect(codes(policy({ targets: { allow: ["nvda"] } }), intent({ target: undefined }))).toContain("target_not_allowed");
  expect(codes(policy({ targets: { allow: ["NVDA"], deny: ["nvda"] } }))).toContain("target_not_allowed");
  expect(intentJson(intent()).amount_pico).toBe("360000000000000");
  for (const action of ["trade-order", "Trade.order", ".trade", "trade.*", "a".repeat(65)]) expect(() => intent({ action })).toThrow();
});
test("separate action caps, rolling counts, windows, approval threshold and killed state", () => {
  expect(codes(policy({ per_action_usd: 359 }))).toContain("over_action_per_request");
  expect(codes(policy({ per_day_usd: 500 }), intent(), { ...state, actions_pico_day: 141000000000000n })).toContain("over_action_per_day");
  expect(codes(policy({ max_per_hour: 2 }), intent(), { ...state, actions_hour: 2 })).toContain("over_action_per_hour");
  expect(codes(policy({}, { caps: { per_request_usd: 0.001, per_day_usd: 0.001 }, breakers: { max_spend_usd_per_minute: 1 } }), intent(), { ...state, breakers: { spent_minute_pico: 0n, requests_minute: 0, denials_10min: 0, distinct_models_hour: 0 } })).toEqual([]);
  const p = policy({ approval_above_usd: 250 }, { windows: [{ days: [1, 2, 3, 4, 5], start: "13:30", end: "20:00" }] });
  expect(evaluateAgentPolicy(p, state, intent(), now).decision).toBe("approval_required");
  expect(codes(p)).toEqual(["approval_action_amount"]);
  expect(evaluateAgentPolicy(p, state, intent({ amount_pico: "250000000000000" }), now).decision).toBe("allow");
  expect(codes(p, intent(), state, new Date("2026-10-02T20:00:00Z"))).toContain("outside_window");
  expect(codes(p, intent(), { ...state, killed: true })).toContain("killed");
});
test("configuration dependency, exact scope boundaries and all starter copies parse", () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).agentGuardEnabled).toBe(false);
  expect(() => loadConfig({ ANYROUTE_ENV: "test", AGENT_GUARD_ENABLED: "true" })).toThrow("requires AGENT_POLICY_ENABLED");
  for (const path of ["/mcp", "/api/v1/guard/decide", "/api/v1/guard/decisions/id/outcome"]) expect(inferenceRouteAllowed("POST", path)).toBe(true);
  for (const path of ["/api/v1/agents/me", "/api/v1/agents/approvals/id"]) expect(inferenceRouteAllowed("GET", path)).toBe(true);
  for (const path of ["/api/v1/agents/id/resume", "/api/v1/agents/id/kill", "/api/v1/agents/approvals/id/approve", "/api/v1/agents/approvals/id/deny"]) expect(inferenceRouteAllowed("POST", path)).toBe(false);
  expect(inferenceRouteAllowed("PUT", "/api/v1/agents/id/policy")).toBe(false);
  for (const [method, path] of [["POST", "/mcp"], ["GET", "/api/v1/agents/me"], ["GET", "/api/v1/agents/approvals/id"]]) expect(inferenceRouteAllowed(method!, path!, false)).toBe(false);
  for (const s of GUARD_STARTERS) {
    expect(agentPolicySchema.parse(s.policy)).toEqual(s.policy);
    expect(JSON.parse(readFileSync(`integrations/robinhood-agents/rulebooks/${s.id}.json`, "utf8"))).toEqual(s.policy);
  }
});
test("no rulebook denial, every decision signed and chained, zero cancellation and input precision", async () => {
  const key = await h.fundedKey();
  expect((await (await h.request("/api/v1/status")).json()).data.agent_guard).toEqual({ enabled: true });
  const denied = await decide(key); expect(denied.data.decision).toBe("deny"); expect(denied.data.reasons[0].code).toBe("no_rulebook");
  await put(key, key.hash, policy({}));
  const allow = (await decide(key, { amount_usd: "0", action: "trade.cancel" })).data;
  expect(allow.decision).toBe("allow"); expect(allow.signed.payload.intent.amount_pico).toBe("0");
  const jwks = await (await h.request("/.well-known/anyroute-receipt-keys.json")).json();
  const jwk = jwks.keys.find((k: any) => k.kid === allow.signed.key_id);
  expect(verify(null, Buffer.from(canonicalJson(allow.signed.payload)), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }), Buffer.from(allow.signed.sig, "base64"))).toBe(true);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, key.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
  expect(events.some(e => e.kind === "action_decision")).toBe(true);
  for (const value of [360, "-1", "1e3", "1.0000001", "1234567890123", " 1"])
    expect((await h.request("/api/v1/guard/decide", { method: "POST", headers: key.auth, json: { action: "trade.order", amount_usd: value } })).status).toBe(400);
});
test("approvals bind exact target/details and amount, are single-use, and recheck new rules", async () => {
  const key = await h.fundedKey(); await put(key, key.hash, policy({ approval_above_usd: 250 }));
  const waiting = (await decide(key)).data; expect(waiting.decision).toBe("approval_required");
  expect((await approve(key, waiting.approval_id)).status).toBe(200);
  for (const changed of [{ amount_usd: "361" }, { target: "nvda" }, { details_sha256: "sha256:" + "b".repeat(64) }, { action: "trade.cancel" }]) {
    const r = (await decide(key, { ...changed, approval_id: waiting.approval_id })).data;
    expect(r.decision).toBe("deny"); expect(r.reasons[0].code).toBe("agent_approval_invalid");
  }
  const attempts = await Promise.all([1, 2].map(() => decide(key, { amount_usd: "350", approval_id: waiting.approval_id })));
  expect(attempts.map(r => r.data.decision).sort()).toEqual(["allow", "deny"]);
  const newer = (await decide(key)).data; await approve(key, newer.approval_id);
  await put(key, key.hash, policy({ approval_above_usd: 250, deny: ["trade.*"] }));
  expect((await decide(key, { approval_id: newer.approval_id })).data.decision).toBe("deny");
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, newer.approval_id)))[0].status).toBe("approved");
});
test("rolling daily holds, executed real amounts, skipped/failed release, hourly count and session children", async () => {
  const key = await h.fundedKey(); await put(key, key.hash, policy({ per_day_usd: 500, max_per_hour: 3 }));
  const first = (await decide(key)).data;
  expect((await decide(key)).data.reasons[0].code).toBe("over_action_per_day");
  expect((await outcome(key, first.decision_id, "skipped")).status).toBe(200);
  const second = (await decide(key)).data; expect(second.decision).toBe("allow");
  expect((await outcome(key, second.decision_id, "executed", "400")).status).toBe(200);
  const third = (await decide(key, { amount_usd: "100" })).data; expect(third.decision).toBe("allow");
  expect((await outcome(key, third.decision_id, "failed")).status).toBe(200);
  const [row] = await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, key.hash));
  const state = await policyState(h.ctx.db, row, new Date()); expect(state.actions_pico_day).toBe(400000000000000n); expect(state.actions_hour).toBe(3);
  expect((await decide(key, { amount_usd: "0" })).data.reasons[0].code).toBe("over_action_per_hour");
  const parent = await h.fundedKey(); await put(parent, parent.hash, policy({ per_day_usd: 500 }));
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: parent.auth, json: { budget_usd: 1 } })).json()).data;
  const child = { auth: { authorization: `Bearer ${session.key}` } };
  expect((await decide(child)).data.decision).toBe("allow");
  expect((await decide(parent)).data.reasons[0].code).toBe("over_action_per_day");
});
test("outcomes require deciding key and allow; only once, required actual amount and over_allowed chained", async () => {
  const key = await h.fundedKey(), other = await h.fundedKey(); await put(key, key.hash, policy({}));
  const id = (await decide(key)).data.decision_id;
  expect((await outcome(other, id, "executed", "360")).status).toBe(404);
  expect((await outcome(key, id)).status).toBe(400);
  const r = await outcome(key, id, "executed", "361"); expect(r.status).toBe(200); expect((await r.json()).data.over_allowed).toBe(true);
  expect((await outcome(key, id, "failed")).status).toBe(409);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, key.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
  expect(events.find(e => e.kind === "action_outcome")?.intent).toMatchObject({ over_allowed: true, amount_pico: "361000000000000" });
  const denied = (await decide(other)).data; expect((await outcome(other, denied.decision_id, "failed")).status).toBe(409);
});
test("breach kill stops later actions until owner resumes", async () => {
  const key = await h.fundedKey(); await put(key, key.hash, policy({ deny: ["trade.*"] }, { on_breach: "kill" }));
  expect((await decide(key)).data.decision).toBe("deny");
  expect((await decide(key, { action: "swap" })).data.reasons.some((r: any) => r.code === "killed")).toBe(true);
  expect((await h.request(`/api/v1/agents/${key.hash}/resume`, { method: "POST", headers: key.auth })).status).toBe(200);
  expect((await decide(key, { action: "swap" })).data.decision).toBe("allow");
});
const mcp = (key: Auth, method: string, params?: unknown, router = h) => router.request("/mcp", { method: "POST", headers: key.auth, json: { jsonrpc: "2.0", id: 1, method, params } });
test("inference keys decide, poll, report and use MCP, but cannot manage; internal scope rechecked", async () => {
  const owner = await h.fundedKey();
  const created = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "guard-agent", scope: "inference" } })).json();
  const key = { hash: created.data.hash, auth: { authorization: `Bearer ${created.key}` } };
  await put(owner, key.hash, policy({ approval_above_usd: 250, per_day_usd: 1000, max_per_hour: 5 }));
  const tools = (await (await mcp(key, "tools/list")).json()).result.tools;
  for (const t of guardMcpTools) expect(tools.some((r: any) => r.name === t.name)).toBe(true);
  const call = async (name: string, args: unknown) => (await (await mcp(key, "tools/call", { name, arguments: args })).json()).result.structuredContent;
  const waiting = await call("anyroute_guard_decide", { action: "trade.order", target: "NVDA", amount_usd: "360" });
  expect(waiting.decision).toBe("approval_required");
  expect((await h.request(`/api/v1/agents/approvals/${waiting.approval_id}`, { headers: key.auth })).status).toBe(200);
  for (const path of [`/api/v1/agents/${key.hash}/resume`, `/api/v1/agents/${key.hash}/kill`, `/api/v1/agents/approvals/${waiting.approval_id}/approve`, `/api/v1/agents/approvals/${waiting.approval_id}/deny`]) expect((await h.request(path, { method: "POST", headers: key.auth, json: {} })).status).toBe(403);
  expect((await put(key, key.hash, policy({}))).status).toBe(403);
  await approve(owner, waiting.approval_id);
  expect((await call("anyroute_guard_wait", { approval_id: waiting.approval_id, timeout_s: 1 })).status).toBe("approved");
  const allowed = await call("anyroute_guard_decide", { action: "trade.order", target: "NVDA", amount_usd: "360", approval_id: waiting.approval_id });
  expect(allowed.decision).toBe("allow");
  expect((await call("anyroute_guard_report", { decision_id: allowed.decision_id, status: "executed", amount_usd: "355" })).status).toBe("executed");
  const rules = await call("anyroute_agent_rules", {}); expect(rules.actions_remaining).toEqual({ per_day_usd: "645", per_hour: 4 });
  const forbidden = await mcp(key, "tools/call", { name: "anyroute_tools_call", arguments: { resource: "https://tools.example/quote", max_price: "1" } });
  expect(JSON.stringify(await forbidden.json())).toContain("inference_only");
});
test("Telegram action text snapshot and maximum cost in dollars", async () => {
  const key = await h.fundedKey(); await put(key, key.hash, policy({ approval_above_usd: 250 }));
  const id = (await decide(key)).data.approval_id;
  const [saved] = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id));
  const row = { ...saved, requestedAt: new Date("2026-10-02T13:50:00Z"), expiresAt: new Date("2026-10-02T14:05:00Z") };
  expect(approvalText(row, "Trading agent", "b".repeat(64), true)).toBe("AnyRoute: your agent asks first\nAgent: Trading agent\nAction: trade.order\nTarget: NVDA\nAmount: $360.00\nOrder hash: sha256:aaaaaaaa…aaaaa\nRulebook: bbbbbbbbbbbb\nExpires: 14:05 UTC (15 min)");
  expect(approvalText(row)).toBe(`AnyRoute approval ${row.id}\nIntent: ${JSON.stringify(row.intent).slice(0, 2600)}\nMaximum cost: ${row.maxCostPico} pico-USD\nExpires: ${row.expiresAt.toISOString()}\nStatus: expired`);
  expect(approvalText({ ...row, intent: { kind: "mcp_tool", name: "read" } }, undefined, undefined, true)).toContain("Maximum cost: $360");
});
test("flag off hides guard tools/routes and leaves existing agent rules unchanged", async () => {
  const off = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
  try {
    const key = await off.fundedKey();
    expect((await off.request("/api/v1/guard/decide", { method: "POST", headers: key.auth, json: {} })).status).toBe(404);
    expect((await off.request("/api/v1/guard/decisions/id/outcome", { method: "POST", headers: key.auth, json: {} })).status).toBe(404);
    const list = (await (await mcp(key, "tools/list", undefined, off)).json()).result.tools;
    expect(list.some((t: any) => t.name.startsWith("anyroute_guard_"))).toBe(false);
    const unknown = await (await mcp(key, "tools/call", { name: "anyroute_guard_decide", arguments: {} }, off)).json(); expect(unknown.error.message).toContain("Unknown tool");
    const [storedKey] = await off.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
    const me = await (await off.request("/api/v1/agents/me", { headers: key.auth })).text();
    expect(me).toBe(JSON.stringify({ data: { key_hash: key.hash, name: storedKey.name, policy: null, sha256: null, killed: false, remaining: { hour: null, day: null, week: null }, policies: [] } }));
    expect(await off.ctx.db.select().from(agentActionDecisions)).toHaveLength(0);
    expect((await (await off.request("/api/v1/status")).json()).data.agent_guard).toBeUndefined();
  } finally { await off.close(); }
});
test("guard MCP schema bounds and defaults", () => {
  expect(guardMcpArgs.anyroute_guard_wait.parse({ approval_id: "id" }).timeout_s).toBe(25);
  for (const timeout_s of [0, 51]) expect(() => guardMcpArgs.anyroute_guard_wait.parse({ approval_id: "id", timeout_s })).toThrow();
  expect(() => guardMcpArgs.anyroute_guard_report.parse({ decision_id: "id", status: "executed" })).toThrow();
});

test("linked Telegram owners receive action buttons and can resume only an owned agent", async () => {
  const owner = await h.fundedKey(), stranger = await h.fundedKey();
  await put(owner, owner.hash, policy({ approval_above_usd: 250 }));
  const id = (await decide(owner)).data.approval_id;
  const calls: { method: string; params: any }[] = [];
  const api = new TelegramApi("123:fixture-only-bot-token-value", (async (input: any, init: any) => { calls.push({ method: String(input).split("/").at(-1)!, params: JSON.parse(init.body) }); return Response.json({ ok: true, result: { message_id: 100 } }); }) as typeof fetch);
  const issued = (await (await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth })).json()).data;
  await consumeCode(h.ctx, 180901, issued.code);
  await deliverTelegramApprovals(h.ctx, api);
  const sent = calls.find(c => c.method === "sendMessage");
  expect(sent?.params.text).toContain("AnyRoute: your agent asks first");
  expect(sent?.params.text).toContain("Rulebook: ");
  expect(sent?.params.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["Approve", "Deny"]);
  await h.request(`/api/v1/agents/${owner.hash}/kill`, { method: "POST", headers: owner.auth, json: {} });
  const update = (uid: number) => ({ update_id: 1, message: { message_id: 100, from: { id: uid }, chat: { type: "private", id: uid }, text: `/resume ${owner.hash}` } });
  await handleLinkedUpdate(h.ctx, api, update(180902));
  expect((await decide(owner)).data.reasons.some((r: any) => r.code === "killed")).toBe(true);
  const strangerCode = (await (await h.request("/api/v1/telegram/link", { method: "POST", headers: stranger.auth })).json()).data;
  await consumeCode(h.ctx, 180902, strangerCode.code);
  await handleLinkedUpdate(h.ctx, api, update(180902));
  expect((await decide(owner)).data.reasons.some((r: any) => r.code === "killed")).toBe(true);
  await handleLinkedUpdate(h.ctx, api, update(180901));
  expect((await decide(owner)).data.decision).toBe("approval_required");
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0].status).toBe("pending");
});

test("action approvals do not inflate existing model call counters; other historic approvals retain their count", async () => {
  const key = await h.fundedKey(); await put(key, key.hash, policy({}, { approval: { above_usd: 1, above_calls_per_hour: 3 } }));
  const [row] = await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, key.hash));
  const [storedKey] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.transaction(async tx => {
    await lockAccount(tx, storedKey.accountId);
    for (const kind of ["action", "paid_tool", "inference"])
      await appendEvent(tx, { keyHash: key.hash, kind: "approval_used", policySha256: row.sha256, intent: { kind } });
  });
  expect((await policyState(h.ctx.db, row, new Date())).calls_hour).toBe(2);
});

test("MCP public receipt helpers retain both credential transports and cannot escape inference ownership", async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey();
  const created = (await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "receipt-reader", scope: "inference" } })).json());
  const key = { auth: { authorization: `Bearer ${created.key}` } };
  const generate = async (auth: Auth) => (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: auth.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "receipt scope fixture" }], max_tokens: 32, provider: { only: ["alpha"] } } })).json()).id;
  const ownId = await generate(key), otherId = await generate(other);
  expect(typeof ownId).toBe("string"); expect(typeof otherId).toBe("string");
  for (const auth of [key, { auth: { "x-api-key": created.key } }]) {
    for (const name of ["get_receipt", "verify_receipt"]) {
      const foreign = (await (await mcp(auth, "tools/call", { name, arguments: { id: otherId } })).json()).result;
      expect(foreign.isError).toBe(true); expect(foreign.structuredContent.error.type).toBe("not_found");
      const own = (await (await mcp(auth, "tools/call", { name, arguments: { id: ownId } })).json()).result;
      expect(own.isError).toBeUndefined();
    }
  }
});
