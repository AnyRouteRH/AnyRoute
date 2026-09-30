import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import type { AgentPolicy } from "./policy.ts";
import { agentPolicies, agentPolicyEvents } from "./schema.ts";
import { appendEvent, type PolicyRow } from "./store.ts";

const DAY = 86_400_000;
export type AutonomyState = { rung: number; since: string; clean_requests: number; last_clean_at: string | null };
type Event = { ts: Date; kind: string; decision: string | null; policySha256: string; intent: unknown };
const initial = (now: Date): AutonomyState => ({ rung: 0, since: now.toISOString(), clean_requests: 0, last_clean_at: null });
export function advanceAutonomy(policy: AgentPolicy, state: AutonomyState, now: Date): AutonomyState {
  let next = { ...state };
  for (const target of policy.autonomy?.rungs.slice(next.rung) ?? []) {
    const reached = new Date(next.since).getTime() + target.after_days * DAY;
    if (now.getTime() < reached || next.clean_requests < target.clean_requests) break;
    // A positive request threshold is reached at an event's time. Zero-request rungs can advance on time alone.
    const since = Math.max(reached, target.clean_requests === 0 ? reached : new Date(next.last_clean_at ?? next.since).getTime());
    next = { rung: next.rung + 1, since: new Date(since).toISOString(), clean_requests: 0, last_clean_at: null };
  }
  return next;
}
/** Replay in event-id order. A retained checkpoint seeds a pruned prefix; with complete history snapshots are ignored. */
export function replayAutonomy(policy: AgentPolicy, sha: string, events: Event[], now: Date): AutonomyState {
  let state: AutonomyState | undefined;
  for (const event of events) {
    if (event.ts > now) continue;
    if (event.kind === "policy_set") { state = initial(event.ts); continue; }
    if (event.policySha256 !== sha) continue;
    if (event.kind === "autonomy_state") {
      if (!state) state = { ...(event.intent as AutonomyState) };
      continue;
    }
    state ??= initial(event.ts);
    const demotion = event.kind === "killed" ? "kill" : event.kind === "breaker" ? "breaker" : event.kind === "decision" && event.decision === "deny" ? "deny" : undefined;
    if (demotion && policy.autonomy?.demote_on.includes(demotion)) { state = initial(event.ts); continue; }
    state = advanceAutonomy(policy, state, event.ts);
    if (event.kind === "autonomy_clean") state = advanceAutonomy(policy, { ...state, clean_requests: state.clean_requests + 1, last_clean_at: event.ts.toISOString() }, event.ts);
  }
  return advanceAutonomy(policy, state ?? initial(now), now);
}
/** No replica cache. Account locks serialize writers; checkpoints avoid scanning the whole history per request. */
export async function readAutonomy(db: Db | Tx, row: Pick<PolicyRow, "keyHash" | "sha256" | "spec">, now: Date) {
  if (!row.spec.autonomy) return undefined;
  const [checkpoint] = await db.select({ id: agentPolicyEvents.id }).from(agentPolicyEvents).where(and(eq(agentPolicyEvents.keyHash, row.keyHash), eq(agentPolicyEvents.kind, "autonomy_state"), eq(agentPolicyEvents.policySha256, row.sha256), lte(agentPolicyEvents.ts, now))).orderBy(desc(agentPolicyEvents.id)).limit(1);
  const events = await db.select().from(agentPolicyEvents).where(and(eq(agentPolicyEvents.keyHash, row.keyHash), checkpoint ? gte(agentPolicyEvents.id, checkpoint.id) : undefined, lte(agentPolicyEvents.ts, now))).orderBy(asc(agentPolicyEvents.id));
  return replayAutonomy(row.spec, row.sha256, events, now);
}
/** Called under the existing account lock, after an event append. Never changes rulebooks without autonomy. */
export async function checkpointAutonomy(db: Db | Tx, event: Event & { keyHash: string }, now: Date) {
  if (!["policy_set", "autonomy_clean", "killed", "breaker"].includes(event.kind) && !(event.kind === "decision" && event.decision === "deny")) return;
  const [row] = await db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, event.keyHash));
  if (!row?.spec.autonomy) return;
  const state = event.kind === "policy_set" ? initial(now) : await readAutonomy(db, row, now);
  await appendEvent(db, { keyHash: row.keyHash, kind: "autonomy_state", policySha256: row.sha256, intent: state }, now);
}
/** One clean event per rulebook after the complete request passes and its reservation succeeds. */
export async function recordAutonomyClean(db: Db | Tx, rows: PolicyRow[], now: Date) {
  for (const row of rows) if (row.spec.autonomy) await appendEvent(db, { keyHash: row.keyHash, kind: "autonomy_clean", policySha256: row.sha256 }, now);
}
/** Breaker integrations call this under the same account lock as the state change. No prompt or address is accepted. */
export async function recordAutonomyBreaker(db: Db | Tx, row: PolicyRow, now = new Date()) {
  if (row.spec.autonomy) await appendEvent(db, { keyHash: row.keyHash, kind: "breaker", policySha256: row.sha256 }, now);
}
export const autonomyMultiplier = (policy: AgentPolicy, state?: AutonomyState) => state ? policy.autonomy?.rungs[state.rung - 1]?.caps_multiplier ?? 1 : 1;
/** Multiply decimal inputs as integers, rounding a fractional pico down. Never use binary floating point for caps. */
export function spendingCapPico(cap: number, multiplier = 1): bigint {
  if (multiplier === 1) return usdToPico(cap);
  const parts = (n: number) => {
    const [mantissa, exponent = "0"] = n.toString().toLowerCase().split("e");
    const [whole, fraction = ""] = mantissa.split(".");
    return { digits: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  };
  const a = parts(cap), b = parts(multiplier), shift = 12 - a.scale - b.scale;
  const product = a.digits * b.digits;
  return shift >= 0 ? product * 10n ** BigInt(shift) : product / 10n ** BigInt(-shift);
}
export function autonomyDescription(policy: AgentPolicy, state: AutonomyState | undefined, now: Date) {
  if (!policy.autonomy || !state) return {};
  const multiplier = autonomyMultiplier(policy, state), next = policy.autonomy.rungs[state.rung];
  const elapsed = Math.max(0, (now.getTime() - new Date(state.since).getTime()) / DAY);
  return { autonomy: { ...state, caps_multiplier: multiplier, next: next ? { rung: state.rung + 1, ...next, elapsed_days: elapsed, days_remaining: Math.max(0, next.after_days - elapsed), requests_remaining: Math.max(0, next.clean_requests - state.clean_requests) } : null }, effective_caps: Object.fromEntries(Object.entries(policy.caps).map(([k, v]) => [k, k === "max_output_tokens" ? v : picoToUsd(spendingCapPico(v!, multiplier))])) };
}
/** Keep the latest checkpoint and its suffix for active autonomy rulebooks, even when idle for over 90 days. */
export const autonomyRetention = sql`not exists (select 1 from agent_policies ap where ap.key_hash = agent_policy_events.key_hash and ap.spec->'autonomy' is not null and agent_policy_events.id >= (select max(cp.id) from agent_policy_events cp where cp.key_hash = ap.key_hash and cp.kind = 'autonomy_state' and cp.policy_sha256 = ap.sha256))`;
