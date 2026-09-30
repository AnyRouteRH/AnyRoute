import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { autonomySchema } from "../src/agents/autonomy-schema.ts";
import { autonomyDescription, autonomyMultiplier, readAutonomy, recordAutonomyBreaker, replayAutonomy, spendingCapPico } from "../src/agents/autonomy.ts";
import { evaluateAgentPolicy } from "../src/agents/evaluate.ts";
import { agentPolicySchema, agentPolicySha256, canonicalAgentPolicy, type AgentPolicy } from "../src/agents/policy.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { appendEvent, eventJson, lockAccount, policiesFor, pruneAgentPolicyEvents, verifyEventChain } from "../src/agents/store.ts";
import { keys } from "../src/db/schema.ts";
import { reserve } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
const base: AgentPolicy = { version: 1, models: {}, caps: { per_request_usd: 1, per_hour_usd: 2, per_day_usd: 3, per_week_usd: 4, max_output_tokens: 32 }, on_breach: "deny" };
const policy: AgentPolicy = { ...base, autonomy: { rungs: [{ after_days: 1, clean_requests: 2, caps_multiplier: 1.5 }, { after_days: 2, clean_requests: 3, caps_multiplier: 3 }], demote_on: ["deny", "kill", "breaker"] } };
const t = (day: number) => new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
const e = (day: number, kind: string, decision: string | null = null, intent: unknown = null) => ({ ts: t(day), kind, decision, intent, policySha256: "sha" });
const state = { killed: false, spent_pico: { hour: 0n, day: 0n, week: 0n } };
const intent = { kind: "inference" as const, model: "author/model", lane: "public" as const, est_cost_pico: usdToPico(1), max_output_tokens: 32, tools: [] };

test("optional schema leaves canonical hashes unchanged and validates ascending bounded rungs", () => {
  expect(canonicalAgentPolicy(base)).toBe(canonicalJson(base));
  expect(agentPolicySha256(base)).toBe(sha256(canonicalJson(base)));
  expect(agentPolicySchema.parse(base)).toEqual(base);
  expect(agentPolicySchema.parse(policy)).toEqual(policy);
  for (const rungs of [[], Array(6).fill(policy.autonomy!.rungs[0]), [{ after_days: -1, clean_requests: 2, caps_multiplier: 2 }], [{ after_days: 1.5, clean_requests: 2, caps_multiplier: 2 }], [{ after_days: 1, clean_requests: 2.5, caps_multiplier: 2 }], [{ after_days: 1, clean_requests: 2, caps_multiplier: 10.01 }], [{ after_days: 1, clean_requests: 2, caps_multiplier: 1 }], [{ after_days: 2, clean_requests: 2, caps_multiplier: 3 }, { after_days: 1, clean_requests: 3, caps_multiplier: 4 }], [{ after_days: 1, clean_requests: 3, caps_multiplier: 3 }, { after_days: 2, clean_requests: 2, caps_multiplier: 4 }]]) expect(autonomySchema.safeParse({ rungs, demote_on: [] }).success).toBe(false);
  expect(autonomySchema.safeParse({ ...policy.autonomy, demote_on: ["other"] }).success).toBe(false);
});
test("both thresholds are necessary, counters restart and elapsed-time promotion is deterministic", () => {
  const history = [e(0, "policy_set"), e(0.2, "autonomy_clean"), e(0.4, "autonomy_clean")];
  expect(replayAutonomy(policy, "sha", history, t(0.9)).rung).toBe(0);
  expect(replayAutonomy(policy, "sha", history.slice(0, 2), t(3)).rung).toBe(0);
  const first = replayAutonomy(policy, "sha", history, t(2));
  expect(first).toEqual({ rung: 1, since: t(1).toISOString(), clean_requests: 0, last_clean_at: null });
  const more = [...history, e(2, "autonomy_clean"), e(2.1, "autonomy_clean"), e(2.2, "autonomy_clean")];
  expect(replayAutonomy(policy, "sha", more, t(2.9)).rung).toBe(1);
  expect(replayAutonomy(policy, "sha", more, t(4))).toEqual({ rung: 2, since: t(3).toISOString(), clean_requests: 0, last_clean_at: null });
  expect(replayAutonomy(policy, "sha", [e(0, "policy_set"), e(2, "autonomy_clean"), e(4, "autonomy_clean")], t(4)).since).toBe(t(4).toISOString());
});
test("selected demotions drop to zero and clear all progress; approvals and ordinary decisions earn nothing", () => {
  const history = [e(0, "policy_set"), e(1, "autonomy_clean"), e(1, "autonomy_clean")];
  for (const event of [e(2, "decision", "deny"), e(2, "killed"), e(2, "breaker")]) {
    expect(replayAutonomy(policy, "sha", [...history, event], t(2))).toEqual({ rung: 0, since: t(2).toISOString(), clean_requests: 0, last_clean_at: null });
    expect(replayAutonomy({ ...policy, autonomy: { ...policy.autonomy!, demote_on: [] } }, "sha", [...history, event], t(2)).rung).toBe(1);
  }
  expect(replayAutonomy(policy, "sha", [e(0, "policy_set"), e(1, "decision", "allow"), e(1, "decision", "approval_required"), e(1, "approval_used")], t(2)).rung).toBe(0);
  expect(replayAutonomy(policy, "sha", [...history, e(2, "policy_set")], t(2)).rung).toBe(0);
});
test("money caps scale exactly while token/model/lane/tool/window/approval rules do not", () => {
  const progress = replayAutonomy(policy, "sha", [e(0, "policy_set"), e(1, "autonomy_clean"), e(1, "autonomy_clean")], t(1));
  const current = { ...state, autonomy: progress };
  expect(autonomyMultiplier(policy, progress)).toBe(1.5);
  expect(spendingCapPico(0.1, 3)).toBe(300000000000n);
  expect(spendingCapPico(0.000000000001, 1.5)).toBe(1n);
  expect(spendingCapPico(1e-7, 1.00000000000001)).toBe(100000n);
  expect(evaluateAgentPolicy(policy, current, { ...intent, est_cost_pico: usdToPico(1.5) }, t(1)).decision).toBe("allow");
  expect(evaluateAgentPolicy(policy, current, { ...intent, est_cost_pico: usdToPico(1.5) + 1n }, t(1)).reasons[0].code).toBe("over_per_request");
  for (const [window, cap] of [["hour", 3], ["day", 4.5], ["week", 6]] as const) {
    const exact = { ...current, spent_pico: { ...state.spent_pico, [window]: usdToPico(cap - 1) } };
    expect(evaluateAgentPolicy(policy, exact, intent, t(1)).decision).toBe("allow");
    expect(evaluateAgentPolicy(policy, { ...exact, spent_pico: { ...exact.spent_pico, [window]: exact.spent_pico[window] + 1n } }, intent, t(1)).reasons.some(r => r.code === `over_per_${window}`)).toBe(true);
  }
  for (const [patch, request, code] of [[{ models: { allow: [] } }, intent, "model_not_allowed"], [{ lanes: ["attested"] }, intent, "lane_not_allowed"], [{ tools: { deny: ["x"] } }, { ...intent, tools: ["x"] }, "tool_not_allowed"], [{ windows: [] }, intent, "outside_window"], [{}, { ...intent, max_output_tokens: 33 }, "max_tokens"], [{ approval: { above_usd: 0.5 } }, intent, "approval_required"]] as const)
    expect(evaluateAgentPolicy({ ...policy, ...patch } as AgentPolicy, current, request, t(1)).reasons.some(r => r.code === code)).toBe(true);
  expect(evaluateAgentPolicy(base, current, { ...intent, est_cost_pico: usdToPico(1.1) }, t(1))).toEqual(evaluateAgentPolicy(base, state, { ...intent, est_cost_pico: usdToPico(1.1) }, t(1)));
  expect(autonomyDescription(base, undefined, t(1))).toEqual({});
});

let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
const put = (key: { hash: string; auth: Record<string, string> }, spec: AgentPolicy) => h.request(`/api/v1/agents/${key.hash}/policy`, { method: "PUT", headers: key.auth, json: spec });
const reserveFor = async (key: { hash: string }, amount: bigint, models = [MODELS.llama.slug]) => {
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  return reserve(h.ctx.db, { id: `autonomy-${crypto.randomUUID()}`, accountId: k.accountId, keyHash: key.hash, amount, agent: { models, lane: "public", max_output_tokens: 32, body: {} } });
};
test("stored checkpoints equal full event replay, real caps scale, and /me reports progress", async () => {
  const k = await h.fundedKey();
  const spec: AgentPolicy = { ...base, autonomy: { rungs: [{ after_days: 0, clean_requests: 2, caps_multiplier: 2 }], demote_on: ["deny", "kill", "breaker"] } };
  expect((await put(k, spec)).status).toBe(200);
  await reserveFor(k, 1n, [MODELS.llama.slug, MODELS.qwen.slug]);
  let me = (await (await h.request("/api/v1/agents/me", { headers: k.auth })).json()).data;
  expect(me.autonomy.rung).toBe(0); expect(me.autonomy.clean_requests).toBe(1); expect(me.autonomy.next.requests_remaining).toBe(1);
  await reserveFor(k, 1n);
  await reserveFor(k, usdToPico(1.5));
  me = (await (await h.request("/api/v1/agents/me", { headers: k.auth })).json()).data;
  expect(me.autonomy.rung).toBe(1); expect(me.autonomy.next).toBeNull(); expect(me.effective_caps.per_request_usd).toBe(2); expect(me.effective_caps.max_output_tokens).toBe(32);
  expect(me.remaining.hour).toBeLessThan(4); expect(me.remaining.hour).toBeGreaterThan(2.49);
  const [row] = await policiesFor(h.ctx.db, k.hash), now = new Date();
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash)).orderBy(asc(agentPolicyEvents.id));
  const recomputed = replayAutonomy(spec, row.sha256, events, now);
  expect(await readAutonomy(h.ctx.db, row, now)).toEqual(recomputed);
  expect(events.filter(e => e.kind === "autonomy_state").at(-1)!.intent).toEqual(recomputed);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
  await expect(reserveFor(k, usdToPico(2) + 1n)).rejects.toMatchObject({ type: "agent_policy_denied" });
  expect((await readAutonomy(h.ctx.db, row, new Date()))!.rung).toBe(0);
});
test("failed reservation and dry run earn nothing; persisted breaker/kill events demote", async () => {
  const k = await h.fundedKey();
  const spec: AgentPolicy = { ...base, caps: {}, autonomy: { rungs: [{ after_days: 0, clean_requests: 1, caps_multiplier: 2 }], demote_on: ["breaker", "kill"] } };
  await put(k, spec);
  await expect(reserveFor(k, usdToPico(1_000_000))).rejects.toBeDefined();
  const [row] = await policiesFor(h.ctx.db, k.hash);
  expect((await readAutonomy(h.ctx.db, row, new Date()))!.clean_requests).toBe(0);
  const n = (await h.ctx.db.select().from(agentPolicyEvents)).length;
  await h.request("/api/v1/agents/check", { method: "POST", headers: k.auth, json: { ...intent, est_cost_pico: "1" } });
  expect((await h.ctx.db.select().from(agentPolicyEvents)).length).toBe(n);
  await reserveFor(k, 1n); expect((await readAutonomy(h.ctx.db, row, new Date()))!.rung).toBe(1);
  await h.ctx.db.transaction(async tx => { await lockAccount(tx, (await tx.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId); await recordAutonomyBreaker(tx, row); });
  expect((await readAutonomy(h.ctx.db, row, new Date()))!.rung).toBe(0);
  await reserveFor(k, 1n);
  await h.request(`/api/v1/agents/${k.hash}/kill`, { method: "POST", headers: k.auth, json: {} });
  expect((await readAutonomy(h.ctx.db, row, new Date()))!.rung).toBe(0);
  await h.request(`/api/v1/agents/${k.hash}/resume`, { method: "POST", headers: k.auth, json: {} });
  expect((await readAutonomy(h.ctx.db, row, new Date()))!.rung).toBe(0);
});
test("retention keeps a recomputable checkpoint during inactivity and removes it after rulebook deletion", async () => {
  const k = await h.fundedKey();
  const spec: AgentPolicy = { ...base, autonomy: { rungs: [{ after_days: 0, clean_requests: 1, caps_multiplier: 2 }], demote_on: ["deny"] } };
  await put(k, spec);
  const [row] = await policiesFor(h.ctx.db, k.hash);
  const past = new Date(Date.now() - 100 * 86_400_000);
  await h.ctx.db.transaction(async tx => { await lockAccount(tx, (await tx.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId); await appendEvent(tx, { keyHash: k.hash, kind: "policy_set", policySha256: row.sha256 }, past); await appendEvent(tx, { keyHash: k.hash, kind: "autonomy_clean", policySha256: row.sha256 }, past); });
  const before = await readAutonomy(h.ctx.db, row, new Date());
  await pruneAgentPolicyEvents(h.ctx.db);
  const remaining = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(remaining.filter(e => e.ts <= past && e.kind === "autonomy_state")).toHaveLength(1);
  expect(await readAutonomy(h.ctx.db, row, new Date())).toEqual(before);
  expect(verifyEventChain(remaining.filter(e => e.ts <= past).map(eventJson), remaining.filter(e => e.ts <= past)[0].prevHash)).toBe(true);
  await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "DELETE", headers: k.auth });
  await pruneAgentPolicyEvents(h.ctx.db);
  expect((await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash))).filter(e => e.ts <= past)).toHaveLength(0);
});
test("without autonomy no checkpoints or new API fields are produced", async () => {
  const k = await h.fundedKey(); await put(k, base); await reserveFor(k, 1n);
  const me = (await (await h.request("/api/v1/agents/me", { headers: k.auth })).json()).data;
  expect(me.autonomy).toBeUndefined(); expect(me.effective_caps).toBeUndefined();
  expect(me.policies[0].autonomy).toBeUndefined();
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash));
  expect(events.map(e => e.kind)).toEqual(["policy_set", "decision"]);
});
