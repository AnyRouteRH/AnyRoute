import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentPolicySchema, agentIntentSchema, type AgentPolicy } from "../src/agents/policy.ts";
import { evaluateAgentPolicy, type AgentPolicyState } from "../src/agents/evaluate.ts";
import { STARTER_RULEBOOKS } from "../web/lib/agent-starters.js";
import { startRouter, MODELS, type Harness } from "./helpers.ts";

// B: the three trading rulebooks in integrations/robinhood-agents/rulebooks are importable as they are (PUT
// /api/v1/agents/:key_hash/policy), match the starters on /agents, and are enforced: a model allowlist, a daily model
// budget, and ask-first once the rolling hour holds N admitted model calls.

const DIR = join(import.meta.dir, "../integrations/robinhood-agents/rulebooks");
const files = Object.fromEntries(readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(DIR, f), "utf8"))]));
const state: AgentPolicyState = { killed: false, spent_pico: { hour: 0n, day: 0n, week: 0n }, breakers: { spent_minute_pico: 0n, requests_minute: 0, denials_10min: 0, distinct_models_hour: 0 }, calls_hour: 0 };
const now = new Date("2026-10-02T15:00:00Z");
const intent = (model: string, cost = 0n) => agentIntentSchema.parse({ kind: "inference", model, lane: "public", est_cost_pico: cost.toString(), max_output_tokens: 1000, tools: ["place_order", "get_quote"] });
const codes = (policy: AgentPolicy, s: AgentPolicyState, i = intent("openai/gpt-5.4")) => evaluateAgentPolicy(policy, s, i, now).reasons.map((r) => r.code);

describe("trading rulebook files", () => {
  test("exactly the three trading starters, validated by the enforced schema without change", () => {
    expect(Object.keys(files).sort()).toEqual(["trading-allowlist", "trading-ask-first", "trading-budget"]);
    for (const [id, policy] of Object.entries(files)) {
      expect(agentPolicySchema.parse(policy)).toEqual(policy);
      expect(policy).toEqual(STARTER_RULEBOOKS.find((t: { id: string }) => t.id === id)!.policy);
      // Agent platforms declare their own tools (quotes, orders): the rulebook leaves them alone.
      expect(policy.tools).toBeUndefined();
      expect(evaluateAgentPolicy(policy, state, intent("openai/gpt-5.4"), now).decision).toBe("allow");
    }
  });

  test("allowlist: only the listed model families", () => {
    const p = agentPolicySchema.parse(files["trading-allowlist"]);
    expect(codes(p, state, intent("meta-llama/llama-3.3-70b-instruct"))).toEqual(["model_not_allowed"]);
    for (const m of ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "google/gemini-2.5-pro"]) expect(codes(p, state, intent(m))).toEqual([]);
  });

  test("daily model budget: the rolling day stops at $5, the hour at $1.50, and above ten cents asks first", () => {
    const p = agentPolicySchema.parse(files["trading-budget"]);
    const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 1_000_000n;
    expect(codes(p, { ...state, spent_pico: { hour: 0n, day: usd(4.99), week: usd(4.99) } }, intent("openai/gpt-5.4", usd(0.02)))).toEqual(["over_per_day"]);
    expect(codes(p, { ...state, spent_pico: { hour: usd(1.49), day: usd(1.49), week: usd(1.49) } }, intent("openai/gpt-5.4", usd(0.02)))).toEqual(["over_per_hour"]);
    const ask = evaluateAgentPolicy(p, state, intent("openai/gpt-5.4", usd(0.11)), now);
    expect([ask.decision, ask.reasons.map((r) => r.code)]).toEqual(["approval_required", ["approval_required"]]);
  });

  test("ask first: the 61st call in a rolling hour waits for approval; a missing count is an error, not an allow", () => {
    const p = agentPolicySchema.parse(files["trading-ask-first"]);
    expect(p.approval?.above_calls_per_hour).toBe(60);
    expect(evaluateAgentPolicy(p, { ...state, calls_hour: 59 }, intent("openai/gpt-5.4"), now).decision).toBe("allow");
    const d = evaluateAgentPolicy(p, { ...state, calls_hour: 60 }, intent("openai/gpt-5.4"), now);
    expect(d).toEqual({ decision: "approval_required", reasons: [{ code: "approval_calls_per_hour", message: expect.stringContaining("approval") }] });
    // A denial still wins over asking.
    expect(evaluateAgentPolicy(p, { ...state, calls_hour: 60, killed: true }, intent("openai/gpt-5.4"), now).decision).toBe("deny");
    const { calls_hour: _omit, ...missing } = state;
    expect(() => evaluateAgentPolicy(p, missing, intent("openai/gpt-5.4"), now)).toThrow(/Hourly call state/);
  });

  test("the schema bounds the call count and keeps the approval amount required", () => {
    const base = files["trading-ask-first"];
    for (const bad of [0, -1, 1.5, 1_000_001, "60"]) expect(agentPolicySchema.safeParse({ ...base, approval: { above_usd: 0.1, above_calls_per_hour: bad } }).success).toBe(false);
    expect(agentPolicySchema.safeParse({ ...base, approval: { above_calls_per_hour: 60 } }).success).toBe(false);
    expect(agentPolicySchema.safeParse({ ...base, approval: { above_usd: 0.1, above_calls_per_hour: 60, extra: true } }).success).toBe(false);
  });
});

describe("trading rulebooks through the router", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });
  const body = { model: MODELS.llama.slug, messages: [{ role: "user", content: "should the agent buy?" }], max_tokens: 32 };
  async function agent(policy: unknown) {
    const owner = await h.fundedKey();
    const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Trading agent" } })).json();
    const key = { hash: child.data.hash as string, auth: { authorization: `Bearer ${child.key}` } };
    const put = await h.request(`/api/v1/agents/${key.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy });
    expect(put.status).toBe(200);
    return { owner, key };
  }
  const call = (auth: Record<string, string>, approval?: string) => h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth, ...(approval ? { "x-agent-approval": approval } : {}) }, json: body });

  test("the allowlist file, imported as it is, refuses a model outside it", async () => {
    const { key } = await agent(files["trading-allowlist"]);
    const r = await call(key.auth);
    expect(r.status).toBe(403);
    expect((await r.json()).error.metadata.reasons.map((x: { code: string }) => x.code)).toEqual(["model_not_allowed"]);
  });

  test("ask first after N calls: N calls pass, the next asks, one approval admits one call, and the next asks again", async () => {
    const { owner, key } = await agent({ ...files["trading-ask-first"], approval: { above_usd: 0.1, above_calls_per_hour: 2 } });
    for (let i = 0; i < 2; i++) expect((await call(key.auth)).status).toBe(200);
    const asked = await call(key.auth);
    expect(asked.status).toBe(403);
    const error = (await asked.json()).error;
    expect(error.type).toBe("agent_approval_required");
    expect(error.metadata.reasons.map((x: { code: string }) => x.code)).toEqual(["approval_calls_per_hour"]);
    expect((await h.request(`/api/v1/agents/approvals/${error.metadata.approval_id}/approve`, { method: "POST", headers: owner.auth })).status).toBe(200);
    expect((await call(key.auth, error.metadata.approval_id)).status).toBe(200);
    const again = await call(key.auth);
    expect(again.status).toBe(403);
    expect((await again.json()).error.metadata.reasons.map((x: { code: string }) => x.code)).toEqual(["approval_calls_per_hour"]);
    // The dry run sees the same count.
    const check = await h.request("/api/v1/agents/check", { method: "POST", headers: key.auth, json: { kind: "inference", model: MODELS.llama.slug, lane: "public", est_cost_pico: "0", max_output_tokens: 32, tools: [] } });
    expect((await check.json()).data.decision).toBe("approval_required");
  });
});
