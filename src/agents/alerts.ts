import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import type { Ctx } from "../context.ts";
import { keys, kv } from "../db/schema.ts";
import { usdToPico } from "../lib/money.ts";
import { agentPolicies, agentPolicyEvents } from "./schema.ts";
import type { AgentPolicy } from "./policy.ts";
import type { AgentPolicyState } from "./evaluate.ts";

export const ALERT_RETENTION_MS = 90 * 86_400_000;
export const ALERT_FEED_LIMIT = 100;
export const ALERT_RATE = 10;
export const alertStateKey = (account: string) => `agent-alerts:${account}`;
export type AgentAlert = { id: string; key_hash: string; at: string; kind: "cap" | "denials" | "killed" | "approval"; window?: string; percent?: number; count?: number; channels: string[]; delivery: "pending" | "delivered" | "failed" | "feed_only"; attempts: number; delivered_targets?: string[]; next_attempt: number };
const denialBatches = new WeakMap<object, string>();
export type AlertState = { denials?: Record<string, { at: number; batch: string }[]>; feed: AgentAlert[]; dedupe: Record<string, number>; rate: { minute: number; count: number } };
const empty = (): AlertState => ({ feed: [], dedupe: {}, rate: { minute: 0, count: 0 } });
export const windowMs = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
export async function readAlertState(db: Db | Tx, account: string): Promise<AlertState> {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, alertStateKey(account)));
  return (row?.value as AlertState | undefined) ?? empty();
}
export async function saveAlertState(db: Db | Tx, account: string, state: AlertState, now: number) {
  state.feed = state.feed.filter(a => Date.parse(a.at) > now - ALERT_RETENTION_MS).slice(0, ALERT_FEED_LIMIT);
  if (state.denials) state.denials = Object.fromEntries(Object.entries(state.denials).map(([key, entries]) => [key, entries.filter(e => e.at > now - 600_000).slice(-10_000)] as const).filter(([, entries]) => entries.length));
  state.dedupe = Object.fromEntries(Object.entries(state.dedupe).filter(([, until]) => until > now));
  await db.insert(kv).values({ key: alertStateKey(account), value: state }).onConflictDoUpdate({ target: kv.key, set: { value: state, updatedAt: new Date(now) } });
}
/** Caller owns the existing account lock. Each threshold has a rolling-window cooldown, not a calendar reset. */
export function addAlert(state: AlertState, keyHash: string, policy: AgentPolicy, data: Pick<AgentAlert, "kind" | "window" | "percent" | "count">, dedupe: string, duration: number, now: number) {
  if (!policy.alerts || (state.dedupe[dedupe] ?? 0) > now) return false;
  state.dedupe[dedupe] = now + duration;
  state.feed.unshift({ id: randomUUID(), key_hash: keyHash, at: new Date(now).toISOString(), ...data, channels: [...new Set(policy.alerts.channels ?? ["webhook", "telegram"])], delivery: "pending", attempts: 0, next_attempt: 0 });
  return true;
}
export function capAlerts(state: AlertState, keyHash: string, policy: AgentPolicy, spent: AgentPolicyState["spent_pico"], now: number) {
  for (const window of ["hour", "day", "week"] as const) {
    const cap = policy.caps[`per_${window}_usd`];
    if (cap === undefined) continue;
    for (const percent of new Set(policy.alerts?.at_percent ?? [80, 100])) {
      if (spent[window] * 100n >= usdToPico(cap) * BigInt(percent)) addAlert(state, keyHash, policy, { kind: "cap", window, percent }, `${keyHash}:${window}:${percent}`, windowMs[window], now);
    }
  }
}
/** Only fixed event kinds and counts are projected. No intent, arbitrary reason or request text enters the feed. */
export async function captureAgentAlert(tx: Db | Tx, event: typeof agentPolicyEvents.$inferSelect) {
  if (!["killed", "approval_requested", "decision"].includes(event.kind) || (event.kind === "decision" && event.decision !== "deny")) return;
  const [key] = await tx.select().from(keys).where(eq(keys.keyHash, event.keyHash));
  if (!key) return;
  const rows = await tx.select().from(agentPolicies).where(sql`${agentPolicies.keyHash} = ${key.keyHash} or ${agentPolicies.keyHash} in (select parent_key_hash from agent_sessions where key_hash = ${key.keyHash})`);
  const policy = rows.find(r => r.keyHash === key.keyHash && r.spec.alerts)?.spec ?? rows.find(r => r.spec.alerts)?.spec;
  if (!policy) return;
  const now = event.ts.getTime(), state = await readAlertState(tx, key.accountId);
  if (event.kind === "decision") {
    // Each router decision transaction is one request batch, even when several model intents deny.
    const batch = denialBatches.get(tx) ?? randomUUID();
    denialBatches.set(tx, batch);
    state.denials ??= {};
    const entries = (state.denials[key.keyHash] ?? []).filter(e => e.at > now - 600_000);
    if (!entries.some(e => e.batch === batch)) entries.push({ at: now, batch });
    state.denials[key.keyHash] = entries.slice(-10_000);
    const count = state.denials[key.keyHash].length;
    if (count >= (policy.alerts?.denials_in_10min ?? 5)) addAlert(state, key.keyHash, policy, { kind: "denials", count }, `${key.keyHash}:denials`, 600_000, now);
  } else addAlert(state, key.keyHash, policy, { kind: event.kind === "killed" ? "killed" : "approval" }, `${key.keyHash}:event:${event.id}`, 0, now);
  await saveAlertState(tx, key.accountId, state, now);
}
/** Called after a successful reservation under the account lock; counts actual charges plus open reservations. */
export async function captureAgentCaps(tx: Db | Tx, rows: { keyHash: string; spec: AgentPolicy; killed: boolean }[], account: string, stateFor: (row: { keyHash: string; killed: boolean }) => Promise<AgentPolicyState>, now = Date.now()) {
  if (!rows.some(r => r.spec.alerts)) return;
  const state = await readAlertState(tx, account);
  for (const row of rows.filter(r => r.spec.alerts)) capAlerts(state, row.keyHash, row.spec, (await stateFor(row)).spent_pico, now);
  await saveAlertState(tx, account, state, now);
}
export async function pruneAgentAlerts(ctx: Ctx, now = Date.now()) {
  if (!ctx.cfg.agentPolicyEnabled) return;
  // All mutations serialize with the same account lock, including delivery claims and retention.
  const rows = await ctx.db.select({ key: kv.key }).from(kv).where(like(kv.key, "agent-alerts:%"));
  for (const row of rows) {
    const account = row.key.slice("agent-alerts:".length);
    await ctx.db.transaction(async tx => {
      const { lockAccount } = await import("./store.ts");
      await lockAccount(tx, account);
      await saveAlertState(tx, account, await readAlertState(tx, account), now);
    });
  }
}
