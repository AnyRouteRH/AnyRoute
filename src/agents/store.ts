import { actionState } from "./guard-state.ts";
import { loadBreakerState } from "./breaker-state.ts";
import { and, desc, eq, getTableColumns, lt, sql } from "drizzle-orm";
import { checkpointAutonomy, readAutonomy, autonomyRetention } from "./autonomy.ts";
import { linkLedgerEvent } from "./ledger-context.ts";
import { captureAgentAlert } from "./alerts.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts, holds, keys, ledger } from "../db/schema.ts";
import { agentPolicies, agentPolicyEvents } from "./schema.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { fail } from "../lib/errors.ts";
import { agentPolicySha256, type AgentPolicy } from "./policy.ts";
import type { AgentPolicyState } from "./evaluate.ts";
export type PolicyRow = typeof agentPolicies.$inferSelect;
export type EventRow = typeof agentPolicyEvents.$inferSelect;
export const GENESIS = "0".repeat(64);
export const eventJson = (r: EventRow) => ({ id: r.id, key_hash: r.keyHash, ts: r.ts.toISOString(), kind: r.kind, decision: r.decision, reasons: r.reasons, intent: r.intent, policy_sha256: r.policySha256, prev_hash: r.prevHash, hash: r.hash });
export function eventHash(prev: string, entry: Omit<ReturnType<typeof eventJson>, "id" | "prev_hash" | "hash">) {
  return sha256(Buffer.concat([Buffer.from(prev, "hex"), Buffer.from(canonicalJson(entry))]));
}
/** Caller holds the account row lock; events and policy changes share that lock across replicas. */
export async function appendEvent(tx: Db | Tx, entry: Pick<EventRow, "keyHash" | "kind" | "policySha256"> & Partial<Pick<EventRow, "decision" | "reasons" | "intent">>, now = new Date()) {
  const [last] = await tx.select({ hash: agentPolicyEvents.hash }).from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, entry.keyHash)).orderBy(desc(agentPolicyEvents.id)).limit(1);
  const prevHash = last?.hash ?? GENESIS;
  const row = { ...entry, ts: now, decision: entry.decision ?? null, reasons: entry.reasons ?? [], intent: entry.intent ?? null, prevHash };
  const hash = eventHash(prevHash, { key_hash: row.keyHash, ts: now.toISOString(), kind: row.kind, decision: row.decision, reasons: row.reasons, intent: row.intent, policy_sha256: row.policySha256 });
  const [inserted] = await tx.insert(agentPolicyEvents).values({ ...row, hash }).returning();
  await checkpointAutonomy(tx, inserted, now);
  await linkLedgerEvent(tx, inserted.id, inserted.kind, now);
  await captureAgentAlert(tx, inserted);
  return eventJson(inserted);
}
export async function lockAccount(tx: Db | Tx, accountId: string) {
  await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for("update");
}
/** One indexed lookup, including the session's parent. No process cache. */
export async function policiesFor(db: Db | Tx, keyHash: string): Promise<PolicyRow[]> {
  return db.selectDistinct(getTableColumns(agentPolicies)).from(agentPolicies).where(sql`${agentPolicies.keyHash} = ${keyHash} or ${agentPolicies.keyHash} in (select parent_key_hash from agent_sessions where key_hash = ${keyHash})`);
}
export async function policyState(db: Db | Tx, policy: Pick<PolicyRow, "keyHash" | "killed"> & Partial<Pick<PolicyRow, "spec" | "sha256">>, now: Date): Promise<AgentPolicyState> {
  const scope = sql`(select key_hash from keys where key_hash = ${policy.keyHash} union select key_hash from agent_sessions where parent_key_hash = ${policy.keyHash})`;
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const [charges] = await db.select({
    hour: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} > ${since(3_600_000)}), 0)`,
    day: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} > ${since(86_400_000)}), 0)`,
    week: sql<string>`coalesce(sum(-${ledger.amount}), 0)`,
  }).from(ledger).where(sql`${ledger.keyHash} in ${scope} and ${ledger.amount} < 0 and ${ledger.kind} in ('usage', 'tool_call') and ${ledger.createdAt} > ${since(604_800_000)} and ${ledger.createdAt} <= ${now.toISOString()}`);
  const [open] = await db.select({ total: sql<string>`coalesce(sum(${holds.amount}), 0)` }).from(holds).where(sql`${holds.keyHash} in ${scope} and ${holds.status} = 'held' and ${holds.kind} in ('usage', 'tool_call')`);
  const inflight = BigInt(open.total);
  // v6 T: paid tool spend (charged plus open tool holds) over the rolling day, for tools.daily_budget.
  let tools: bigint | undefined;
  if (policy.spec?.tools?.daily_budget !== undefined) {
    const [t] = await db.select({ charged: sql<string>`coalesce(sum(-${ledger.amount}), 0)` }).from(ledger).where(sql`${ledger.keyHash} in ${scope} and ${ledger.amount} < 0 and ${ledger.kind} = 'tool_call' and ${ledger.createdAt} > ${since(86_400_000)} and ${ledger.createdAt} <= ${now.toISOString()}`);
    const [h] = await db.select({ held: sql<string>`coalesce(sum(${holds.amount}), 0)` }).from(holds).where(sql`${holds.keyHash} in ${scope} and ${holds.status} = 'held' and ${holds.kind} = 'tool_call'`);
    tools = BigInt(t.charged) + BigInt(h.held);
  }
  return { ...(policy.spec?.actions ? await actionState(db, scope, now) : {}), ...(policy.spec?.autonomy ? { autonomy: await readAutonomy(db, policy as PolicyRow, now) } : {}), ...(policy.spec?.breakers ? { breakers: await loadBreakerState(db, policy.keyHash, now) } : {}), ...(policy.spec?.approval?.above_calls_per_hour !== undefined ? { calls_hour: await callsInHour(db, policy.keyHash, scope, now) } : {}), killed: policy.killed, spent_pico: { hour: BigInt(charges.hour) + inflight, day: BigInt(charges.day) + inflight, week: BigInt(charges.week) + inflight }, ...(tools !== undefined ? { tools_spent_pico_day: tools } : {}) };
}
/**
 * B: model calls this rulebook admitted in the rolling hour, from its own hash-chained events: its "allow" decisions for
 * inference intents, plus approvals used by the keys it covers (an approved call is recorded as approval_required, then used).
 */
async function callsInHour(db: Db | Tx, keyHash: string, scope: ReturnType<typeof sql>, now: Date) {
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const [row] = await db.select({ n: sql<string>`count(*)::text` }).from(agentPolicyEvents).where(sql`${agentPolicyEvents.ts} > ${since} and ${agentPolicyEvents.ts} <= ${now.toISOString()} and (
    (${agentPolicyEvents.keyHash} = ${keyHash} and ${agentPolicyEvents.kind} = 'decision' and ${agentPolicyEvents.decision} = 'allow' and ${agentPolicyEvents.intent}->>'kind' = 'inference')
    or (${agentPolicyEvents.keyHash} in ${scope} and ${agentPolicyEvents.kind} = 'approval_used' and coalesce(${agentPolicyEvents.intent}->>'kind', '') <> 'action'))`);
  return Number(row.n);
}
/** U115: a key follows a playbook or keeps its own rulebook, not both. Its own rules change only after it stops following. */
export async function assertOwnRulebook(tx: Db | Tx, keyHash: string) {
  const [row] = await tx.select({ playbookId: agentPolicies.playbookId }).from(agentPolicies).where(eq(agentPolicies.keyHash, keyHash));
  if (row?.playbookId) fail(409, "This key follows a playbook. Change the playbook, or stop following it first (POST /api/v1/agents/:key_hash/playbook with playbook_id null); the key then keeps the playbook's rules as its own.", "playbook_linked", { playbook_id: row.playbookId });
}
export async function setPolicy(db: Db, accountId: string, keyHash: string, policy: AgentPolicy, actor: string) {
  return db.transaction(async tx => {
    await lockAccount(tx, accountId);
    await assertOwnRulebook(tx, keyHash);
    const sha256 = agentPolicySha256(policy);
    const [row] = await tx.insert(agentPolicies).values({ keyHash, version: policy.version, spec: policy, sha256, updatedBy: actor }).onConflictDoUpdate({ target: agentPolicies.keyHash, set: { version: policy.version, spec: policy, sha256, updatedBy: actor, updatedAt: new Date() } }).returning();
    await appendEvent(tx, { keyHash, kind: "policy_set", policySha256: sha256 });
    return row;
  });
}
export async function changeKill(tx: Db | Tx, row: PolicyRow, killed: boolean, reason: string | null, actor: string) {
  const [updated] = await tx.update(agentPolicies).set({ killed, killedAt: killed ? new Date() : null, killedReason: killed ? reason : null, updatedAt: new Date(), updatedBy: actor }).where(eq(agentPolicies.keyHash, row.keyHash)).returning();
  await appendEvent(tx, { keyHash: row.keyHash, kind: killed ? "killed" : "resumed", policySha256: row.sha256 });
  return updated;
}
/** A retained suffix can be checked using its first prev_hash as an external checkpoint. */
export function verifyEventChain(entries: ReturnType<typeof eventJson>[], genesis = GENESIS) {
  let prev = genesis;
  for (const { id: _id, prev_hash, hash, ...entry } of entries) {
    if (prev_hash !== prev || eventHash(prev, entry) !== hash) return false;
    prev = hash;
  }
  return true;
}
export async function pruneAgentPolicyEvents(db: Db, now = new Date()) {
  // Lock owning accounts so pruning cannot remove a chain head during an append.
  return db.transaction(async tx => {
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    const rows = await tx.selectDistinct({ accountId: keys.accountId }).from(keys).innerJoin(agentPolicyEvents, eq(keys.keyHash, agentPolicyEvents.keyHash)).where(lt(agentPolicyEvents.ts, cutoff));
    for (const row of rows.sort((a, b) => a.accountId.localeCompare(b.accountId))) await lockAccount(tx, row.accountId);
    return (await tx.delete(agentPolicyEvents).where(and(lt(agentPolicyEvents.ts, cutoff), autonomyRetention)).returning({ id: agentPolicyEvents.id })).length;
  });
}
