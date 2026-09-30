import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { startRouter, type Harness, MODELS } from "./helpers.ts";
import type { AgentPolicy } from "../src/agents/policy.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
const base: AgentPolicy = { version: 1, models: {}, caps: { per_hour_usd: 1, per_day_usd: 2, per_week_usd: 3 }, on_breach: "deny" };
const inference = { kind: "inference", model: MODELS.llama.slug, lane: "public", est_cost_pico: "20240000", max_output_tokens: 32, tools: [] };
const rpc = (name: string, args: object, auth: Record<string, string> = {}) => h.request("/mcp", { method: "POST", headers: auth, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
const put = (k: { hash: string; auth: Record<string, string> }, policy: AgentPolicy) => h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: policy });
test("list describes rulebook tools and refusal guidance", async () => {
  const r = await h.request("/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  const tools = (await r.json()).result.tools.filter((t: any) => t.name.startsWith("anyroute_agent_"));
  expect(tools).toHaveLength(2);
  for (const t of tools) { expect(t.description).toContain("Check before expensive calls"); expect(t.description).toContain("Never retry a denied call unchanged"); expect(t.inputSchema.type).toBe("object"); }
});
test("rules and checks match REST, price tokens, and record no events even when tools are denied or killed", async () => {
  const k = await h.fundedKey();
  await put(k, { ...base, models: { deny: [MODELS.llama.slug] }, tools: { allow: [] }, on_breach: "kill" });
  const events = () => h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash));
  const before = await events();
  const rest = (await (await h.request("/api/v1/agents/me", { headers: k.auth })).json()).data;
  const rules = (await (await rpc("anyroute_agent_rules", {}, k.auth)).json()).result.structuredContent;
  expect(rules).toEqual(rest); expect(rules.remaining).toEqual({ hour: 1, day: 2, week: 3 });
  const expected = (await (await h.request("/api/v1/agents/check", { method: "POST", headers: k.auth, json: inference })).json()).data;
  const estimated = (await (await rpc("anyroute_agent_check", { model: inference.model, lane: "public", est_input_tokens: 100, max_output_tokens: 32 }, k.auth)).json()).result.structuredContent;
  expect(estimated).toEqual(expected); expect(expected.decision).toBe("deny");
  const exact = (await (await rpc("anyroute_agent_check", { model: inference.model, lane: "public", est_cost_pico: inference.est_cost_pico, max_output_tokens: 32, tools: [] }, k.auth)).json()).result.structuredContent;
  expect(exact).toEqual(expected); expect(await events()).toEqual(before);
  await h.request(`/api/v1/agents/${k.hash}/kill`, { method: "POST", headers: k.auth, json: { reason: "stop" } });
  expect((await (await rpc("anyroute_agent_rules", {}, k.auth)).json()).result.structuredContent.killed).toBe(true);
  const killed = (await (await rpc("anyroute_agent_check", { model: inference.model, lane: "public", est_cost_pico: "0" }, k.auth)).json()).result.structuredContent;
  expect(killed.reasons.some((r: any) => r.code === "killed")).toBe(true);
});
for (const [type, policy, kill] of [["agent_policy_denied", { models: { allow: [] } }, false], ["agent_killed", {}, true], ["agent_approval_required", { approval: { above_usd: 0.000000001 } }, false]] as const) test(`chat preserves ${type} reasons verbatim`, async () => {
  const k = await h.fundedKey(); await put(k, { ...base, ...policy });
  if (kill) await h.request(`/api/v1/agents/${k.hash}/kill`, { method: "POST", headers: k.auth, json: {} });
  const r = await rpc("chat", { model: MODELS.llama.slug, prompt: "hi", max_tokens: 32 }, k.auth);
  expect(r.status).toBe(403);
  const error = (await r.json()).error;
  expect(error.type).toBe(type); expect(error.message).toBe(error.metadata.reasons.map((r: any) => r.message).join(" ")); expect(error.metadata.policy_sha256).toHaveLength(64);
});
test("rulebook tools need keys, validate estimates, and honor disabled REST", async () => {
  expect((await (await rpc("anyroute_agent_rules", {})).json()).result.structuredContent.error.type).toBe("missing_key");
  expect((await (await rpc("anyroute_agent_check", { model: "m", lane: "public" })).json()).error.code).toBe(-32602);
  const off = await startRouter();
  try {
    const k = await off.fundedKey();
    const r = await off.request("/mcp", { method: "POST", headers: k.auth, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "anyroute_agent_rules", arguments: {} } } });
    expect((await r.json()).result.structuredContent.error.type).toBe("not_found");
  } finally { await off.close(); }
});
