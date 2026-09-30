import { expect, test } from "bun:test";
import { agentPolicySchema, agentPolicySha256, canonicalAgentPolicy, type AgentPolicy, type AgentIntent } from "../src/agents/policy.ts";
import { evaluateAgentPolicy, type AgentPolicyState } from "../src/agents/evaluate.ts";
const policy: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const state: AgentPolicyState = { killed: false, spent_pico: { hour: 0n, day: 0n, week: 0n } };
const intent: AgentIntent = { kind: "inference", model: "author/model", lane: "public", est_cost_pico: 1_000_000_000_000n, max_output_tokens: 100, tools: [] };
const now = new Date("2026-09-28T12:00:00Z");
const run = (p: Partial<AgentPolicy> = {}, s = state, i = intent, at = now) => evaluateAgentPolicy({ ...policy, ...p }, s, i, at);
for (const [code, p, s, i] of [
  ["killed", {}, { ...state, killed: true }, intent],
  ["model_not_allowed", { models: { allow: ["other/*"] } }, state, intent],
  ["lane_not_allowed", { lanes: ["attested"] }, state, intent],
  ["over_per_request", { caps: { per_request_usd: 0.5 } }, state, intent],
  ["over_per_hour", { caps: { per_hour_usd: 0.5 } }, state, intent],
  ["over_per_day", { caps: { per_day_usd: 0.5 } }, state, intent],
  ["over_per_week", { caps: { per_week_usd: 0.5 } }, state, intent],
  ["max_tokens", { caps: { max_output_tokens: 99 } }, state, intent],
  ["tool_not_allowed", { tools: { deny: ["write"] } }, state, { ...intent, tools: ["write"] }],
  ["outside_window", { windows: [{ days: [2], start: "11:00", end: "13:00" }] }, state, intent],
  ["approval_required", { approval: { above_usd: 0.5 } }, state, intent],
] as const) test(`deterministic reason ${code}`, () => {
  const result = run(p as Partial<AgentPolicy>, s, i as AgentIntent);
  expect(result.decision).toBe(code === "approval_required" ? "approval_required" : "deny");
  expect(result.reasons.map(r => r.code)).toEqual([code]);
  expect(run(p as Partial<AgentPolicy>, s, i as AgentIntent)).toEqual(result);
});
test("unrestricted allow; boundaries inclusive and one pico over refuses", () => {
  expect(run()).toEqual({ decision: "allow", reasons: [] });
  for (const key of ["per_request_usd", "per_hour_usd", "per_day_usd", "per_week_usd"] as const) {
    expect(run({ caps: { [key]: 1 } }).decision).toBe("allow");
    expect(run({ caps: { [key]: 1 } }, state, { ...intent, est_cost_pico: intent.est_cost_pico + 1n }).decision).toBe("deny");
  }
  expect(run({ caps: { max_output_tokens: 100 } }).decision).toBe("allow");
  expect(run({ approval: { above_usd: 1 } }).decision).toBe("allow");
});
test("recorded spend participates independently in all rolling caps", () => {
  for (const w of ["hour", "day", "week"] as const) {
    const s = { ...state, spent_pico: { ...state.spent_pico, [w]: 1n } };
    expect(run({ caps: { [`per_${w}_usd`]: 1 } }, s).reasons[0].code).toBe(`over_per_${w}`);
  }
});
test("model author globs, empty allow list and deny precedence", () => {
  expect(run({ models: { allow: ["author/*"] } }).decision).toBe("allow");
  expect(run({ models: { allow: ["author/*"], deny: ["author/model"] } }).decision).toBe("deny");
  expect(run({ models: { allow: ["author/model"], deny: ["author/*"] } }).decision).toBe("deny");
  expect(run({ models: { allow: [] } }).decision).toBe("deny");
  expect(run({ models: { allow: ["auth*"] } }).decision).toBe("deny");
});
test("tool names are exact; MCP tools share the rules and ignore inference caps", () => {
  expect(run({ tools: { allow: ["read"] } }, state, { ...intent, tools: ["read"] }).decision).toBe("allow");
  expect(run({ tools: { allow: ["read"], deny: ["read"] } }, state, { kind: "mcp_tool", name: "read" }).decision).toBe("deny");
  expect(run({ models: { allow: [] }, lanes: [], caps: { per_request_usd: 0.1, max_output_tokens: 1 } }, state, { kind: "mcp_tool", name: "read" }).decision).toBe("allow");
});
test("all UTC windows: inclusive start, exclusive end, overnight Sunday wrap, empty and equal endpoints", () => {
  const windows = [{ days: [1], start: "12:00", end: "13:00" }];
  expect(run({ windows }).decision).toBe("allow");
  expect(run({ windows }, state, intent, new Date("2026-09-28T13:00:00Z")).decision).toBe("deny");
  expect(run({ windows }, state, intent, new Date("2026-09-28T11:59:59Z")).decision).toBe("deny");
  const overnight = [{ days: [0], start: "23:00", end: "01:00" }];
  expect(run({ windows: overnight }, state, intent, new Date("2026-09-27T23:00:00Z")).decision).toBe("allow");
  expect(run({ windows: overnight }, state, intent, new Date("2026-09-28T00:59:00Z")).decision).toBe("allow");
  expect(run({ windows: overnight }, state, intent, new Date("2026-09-28T01:00:00Z")).decision).toBe("deny");
  expect(run({ windows: [] }).decision).toBe("deny");
  expect(run({ windows: [{ days: [1], start: "12:00", end: "12:00" }] }).decision).toBe("deny");
});
test("all refusal reasons accumulate and deny takes precedence over approval", () => {
  const result = run({ models: { allow: [] }, lanes: [], caps: { per_request_usd: 0.1, per_hour_usd: 0.1, per_day_usd: 0.1, per_week_usd: 0.1, max_output_tokens: 1 }, tools: { allow: [] }, windows: [], approval: { above_usd: 0.1 } }, { ...state, killed: true }, { ...intent, tools: ["write"] });
  expect(result.decision).toBe("deny"); expect(result.reasons).toHaveLength(10);
  expect(result.reasons.some(r => r.code === "approval_required")).toBe(false);
});
test("missing output bound fails closed when capped and evaluator never mutates inputs", () => {
  const i = { ...intent, max_output_tokens: undefined };
  expect(run({ caps: { max_output_tokens: 100 } }, state, i).reasons[0].code).toBe("max_tokens");
  const before = canonicalAgentPolicy(policy); run(); expect(canonicalAgentPolicy(policy)).toBe(before);
});
test("strict schema, list and money bounds, canonical hash independent of object order", () => {
  expect(agentPolicySha256(policy)).toBe(agentPolicySha256({ on_breach: "deny", caps: {}, models: {}, version: 1 }));
  for (const p of [{ ...policy, extra: 1 }, { ...policy, models: { allow: Array(65).fill("a") } }, { ...policy, tools: { deny: ["x".repeat(161)] } }, { ...policy, caps: { per_day_usd: 0 } }, { ...policy, caps: { per_day_usd: 1_000_001 } }, { ...policy, caps: { max_output_tokens: 10_000_001 } }, { ...policy, caps: { max_output_tokens: 1.1 } }, { ...policy, caps: { extra: 1 } }, { ...policy, windows: [{ days: [7], start: "12:00", end: "13:00" }] }, { ...policy, windows: [{ days: [1], start: "24:00", end: "13:00" }] }]) expect(agentPolicySchema.safeParse(p).success).toBe(false);
});
