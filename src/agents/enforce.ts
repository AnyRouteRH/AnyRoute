import { AsyncLocalStorage } from "node:async_hooks";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import type { ReserveInput } from "../ledger/ledger.ts";
import { ApiError } from "../lib/errors.ts";
import { evaluateAgentPolicy, type AgentDecision } from "./evaluate.ts";
import { intentJson, type AgentIntent } from "./policy.ts";
import { appendEvent, changeKill, lockAccount, policiesFor, policyState, type PolicyRow } from "./store.ts";
import { requireKey } from "../api/auth.ts";
const enabled = new WeakMap<Db, boolean>();
const checked = new AsyncLocalStorage<boolean>();
export const configureAgentPolicies = (ctx: Ctx) => enabled.set(ctx.db, ctx.cfg.agentPolicyEnabled);
export type AgentReservation = { models: string[]; lane: "public" | "attested" | "unlinkable"; max_output_tokens: number; body: Record<string, unknown> };
/** Read only declared identifiers from the already-parsed body; never save tool arguments or descriptions. */
export function declaredTools(body: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const tool of [...(Array.isArray(body.tools) ? body.tools : []), ...(Array.isArray(body.functions) ? body.functions : [])]) {
    if (!tool || typeof tool !== "object") continue;
    const name = tool.function?.name ?? tool.name;
    if (typeof name === "string") names.push(name);
  }
  return [...new Set(names)];
}
export function agentReservation(ctx: Ctx, build: () => AgentReservation) {
  return ctx.cfg.agentPolicyEnabled ? { agent: () => {
    const intent = build();
    return { ...intent, max_output_tokens: intent.max_output_tokens * Math.max(1, Number(intent.body.n ?? 1), Number(intent.body.best_of ?? 1)) };
  } } : {};
}
export function decisionError(decision: AgentDecision, row: PolicyRow) {
  const type = decision.reasons.some(r => r.code === "killed") ? "agent_killed" : decision.decision === "approval_required" ? "agent_approval_required" : "agent_policy_denied";
  return new ApiError(403, decision.reasons.map(r => r.message).join(" "), type, { reasons: decision.reasons, policy_sha256: row.sha256 });
}
async function recordDecisions(tx: Tx, rows: PolicyRow[], intents: AgentIntent[], actor: string, now: Date) {
  let refusal: ApiError | undefined;
  for (const row of rows) {
    const state = await policyState(tx, row, now);
    for (const intent of intents) {
      const decision = evaluateAgentPolicy(row.spec, state, intent, now);
      await appendEvent(tx, { keyHash: row.keyHash, kind: "decision", decision: decision.decision, reasons: decision.reasons, intent: intentJson(intent), policySha256: row.sha256 }, now);
      if (decision.decision !== "allow") {
        const error = decisionError(decision, row);
        const priority = (e: ApiError) => e.type === "agent_killed" ? 3 : e.type === "agent_policy_denied" ? 2 : 1;
        if (!refusal || priority(error) > priority(refusal)) refusal = error;
        if (decision.decision === "deny" && row.spec.on_breach === "kill" && !state.killed) {
          await changeKill(tx, row, true, decision.reasons.map(r => r.code).join(","), actor);
          state.killed = true;
        }
      }
    }
  }
  return refusal;
}
/** Serialize policy decisions with reserve/settle and principal edits using the existing account lock. */
export async function enforceAgentReservation(db: Db, r: ReserveInput, reserve: (db: Db) => Promise<bigint>, hasPolicy = false): Promise<bigint> {
  if (checked.getStore() || !enabled.get(db) || !r.keyHash) return reserve(db);
  if (!hasPolicy && !(await policiesFor(db, r.keyHash)).length) return reserve(db);
  const outcome = await db.transaction(async tx => {
    await lockAccount(tx, r.accountId);
    const rows = await policiesFor(tx, r.keyHash!);
    // Non-inference purchases still honor kill and schedule restrictions; payment rules are reserved for a later version.
    const agent = typeof r.agent === "function" ? r.agent() : r.agent;
    const intents: AgentIntent[] = agent ? [...new Set(agent.models)].map(model => ({ kind: "inference", model, lane: agent.lane, est_cost_pico: r.amount, max_output_tokens: agent.max_output_tokens, tools: declaredTools(agent.body) })) : [{ kind: "mcp_tool", name: r.kind ?? "usage" }];
    const error = await recordDecisions(tx, rows, intents, r.keyHash!, new Date());
    if (error) return { error };
    try { return { value: await reserve(tx as unknown as Db) }; } catch (error) { return { error }; }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value!;
}
export async function enforceAgentCached(ctx: Ctx, key: { keyHash: string; accountId: string } | undefined, model: string, lane: AgentReservation["lane"], body: Record<string, unknown>) {
  if (!ctx.cfg.agentPolicyEnabled || !key || !(await policiesFor(ctx.db, key.keyHash)).length) return;
  const error = await ctx.db.transaction(async tx => {
    await lockAccount(tx, key.accountId);
    return recordDecisions(tx, await policiesFor(tx, key.keyHash), [{ kind: "inference", model, lane, est_cost_pico: 0n, max_output_tokens: Number(body.max_completion_tokens ?? body.max_tokens ?? 10_000_000), tools: declaredTools(body) }], key.keyHash, new Date());
  });
  if (error) throw error;
}
export async function enforceAgentTool(ctx: Ctx, authorization: string | undefined, name: string) {
  if (!ctx.cfg.agentPolicyEnabled || !authorization) return;
  const key = await requireKey(ctx, authorization);
  if (!(await policiesFor(ctx.db, key.keyHash)).length) return;
  const error = await ctx.db.transaction(async tx => {
    await lockAccount(tx, key.accountId);
    return recordDecisions(tx, await policiesFor(tx, key.keyHash), [{ kind: "mcp_tool", name }], key.keyHash, new Date());
  });
  if (error) throw error;
}

/** Council/dual calls form one intent with several models: refuse every leg before creating any hold. */
export async function enforceAgentCouncil(ctx: Ctx, billing: { accountId: string; key?: { keyHash: string } }, buildLegs: () => { models: string[]; max_output_tokens: number; hold: bigint; body: Record<string, unknown> }[], lane: AgentReservation["lane"], run: (ctx: Ctx) => Promise<void>) {
  if (!ctx.cfg.agentPolicyEnabled || !billing.key) return run(ctx);
  if (!(await policiesFor(ctx.db, billing.key.keyHash)).length) return checked.run(true, () => run(ctx));
  const legs = buildLegs();
  const amount = legs.reduce((sum, leg) => sum + leg.hold, 0n);
  await enforceAgentReservation(ctx.db, { id: "council-policy", accountId: billing.accountId, keyHash: billing.key.keyHash, amount, agent: { models: legs.flatMap(l => l.models), lane, max_output_tokens: Math.max(...legs.map(l => l.max_output_tokens)), body: { tools: legs.flatMap(l => Array.isArray(l.body.tools) ? l.body.tools : []), functions: legs.flatMap(l => Array.isArray(l.body.functions) ? l.body.functions : []) } } }, async db => { await checked.run(true, () => run({ ...ctx, db })); return amount; }, true);
}
