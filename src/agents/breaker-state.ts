import { desc, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { holds, ledger } from "../db/schema.ts";
import { agentPolicyEvents } from "./schema.ts";
import { appendEvent, type PolicyRow } from "./store.ts";
import { evaluateAgentPolicy, type AgentPolicyState } from "./evaluate.ts";
import { intentJson, type AgentIntent } from "./policy.ts";
import type { BreakerState } from "./breakers.ts";

/** Caller holds the same account lock used by caps. Resume resets breakers, never cap spend. */
export async function loadBreakerState(db: Db | Tx, keyHash: string, now: Date): Promise<BreakerState> {
  const [resume] = await db.select({ id: agentPolicyEvents.id, ts: agentPolicyEvents.ts }).from(agentPolicyEvents).where(sql`${agentPolicyEvents.keyHash} = ${keyHash} and ${agentPolicyEvents.kind} = 'resumed'`).orderBy(desc(agentPolicyEvents.id)).limit(1);
  const since = (ms: number) => new Date(Math.max(now.getTime() - ms, resume?.ts.getTime() ?? 0)).toISOString();
  const scope = sql`(select key_hash from keys where key_hash = ${keyHash} union select key_hash from agent_sessions where parent_key_hash = ${keyHash})`;
  const [charged] = await db.select({ total: sql<string>`coalesce(sum(-${ledger.amount}), 0)` }).from(ledger).where(sql`${ledger.keyHash} in ${scope} and ${ledger.kind} = 'usage' and ${ledger.amount} < 0 and ${ledger.createdAt} > ${since(60_000)} and ${ledger.createdAt} <= ${now.toISOString()}`);
  const [open] = await db.select({ total: sql<string>`coalesce(sum(${holds.amount}), 0)` }).from(holds).where(sql`${holds.keyHash} in ${scope} and ${holds.kind} = 'usage' and ${holds.status} = 'held' and ${resume ? sql`${holds.createdAt} > ${resume.ts.toISOString()}` : sql`true`}`);
  // New batches have one marker, even with multiple models. Older decisions remain observations;
  // suppress their per-model rows when a marker exists at the batch's shared timestamp.
  const observations = sql`select e.* from agent_policy_events e where e.key_hash = ${keyHash} and e.id > ${resume?.id ?? 0} and e.ts > ${since(3_600_000)} and e.ts <= ${now.toISOString()} and (e.kind = 'breaker_request' or (e.kind = 'decision' and not exists (select 1 from agent_policy_events b where b.key_hash = e.key_hash and b.ts = e.ts and b.id < e.id and b.policy_sha256 = e.policy_sha256 and b.kind = 'breaker_request')))`;
  const result = await db.execute(sql`with observations as (${observations}) select
    count(*) filter (where ts > ${since(60_000)})::text as requests,
    count(*) filter (where ts > ${since(600_000)} and decision = 'deny')::text as denials,
    (select count(distinct i->>'model') from observations o cross join lateral jsonb_array_elements(case when o.intent ? 'intents' then o.intent->'intents' else jsonb_build_array(o.intent) end) i where i->>'kind' = 'inference')::text as models,
    (select coalesce(jsonb_agg(distinct i->>'model'), '[]'::jsonb) from observations o cross join lateral jsonb_array_elements(case when o.intent ? 'intents' then o.intent->'intents' else jsonb_build_array(o.intent) end) i where i->>'kind' = 'inference') as model_ids
    from observations`);
  const row = ((result as { rows?: unknown[] }).rows ?? result) as { requests: string; denials: string; models: string; model_ids: string[] }[];
  return { spent_minute_pico: BigInt(charged.total) + BigInt(open.total), requests_minute: Number(row[0].requests), denials_10min: Number(row[0].denials), distinct_models_hour: Number(row[0].models), models_hour: row[0].model_ids };
}
/** One observation per admission batch; only bounded Intent metadata is retained. */
export async function recordBreakerRequest(tx: Tx, row: PolicyRow, state: AgentPolicyState, intents: AgentIntent[], now: Date) {
  if (!row.spec.breakers) return;
  const decisions = intents.map(intent => evaluateAgentPolicy(row.spec, state, intent, now));
  const decision = decisions.some(d => d.decision === "deny") ? "deny" : decisions.some(d => d.decision === "approval_required") ? "approval_required" : "allow";
  await appendEvent(tx, { keyHash: row.keyHash, kind: "breaker_request", decision, reasons: [], intent: intents.length === 1 ? intentJson(intents[0]) : { intents: intents.map(intentJson) }, policySha256: row.sha256 }, now);
}

/** Evaluate a multi-model admission atomically against the complete requested set. */
export function withBreakerModels(state: AgentPolicyState, intents: AgentIntent[]): AgentPolicyState {
  return state.breakers ? { ...state, breakers: { ...state.breakers, requested_models: intents.flatMap(i => i.kind === "inference" ? [i.model] : []) } } : state;
}
