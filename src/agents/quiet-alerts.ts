// D141: quiet settings live outside the rulebook; only existing call/Guard metadata is read.
import { and, asc, desc, eq, gt, inArray, like, lte, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import { agentSessions, keys, kv, ledger } from "../db/schema.ts";
import { agentActionDecisions } from "./guard-schema.ts";
import { lockAccount, policiesFor } from "./store.ts";
import { visibleStop } from "./stop-until.ts";
import { linkedAlertTargets } from "../telegram/delivery.ts";
import { uid } from "../lib/util.ts";

export const QUIET_HOURS = [1, 3, 6, 12, 24, 72] as const;
export type QuietHours = typeof QUIET_HOURS[number] | null;
export const QUIET_PREFIX = "quiet-agent-alert:";
const RETENTION = 90 * 86_400_000;
type Notice = { id: string; at: string; title: string; last_call_at: string | null; hours: number };
type Settings = { hours: QuietHours; enabled_at: string; notified_for: string | null; notices: Notice[] };
const settingKey = (hash: string) => QUIET_PREFIX + hash;

export function quietDue(hours: QuietHours, anchor: string, notifiedFor: string | null, now: Date) {
  return hours !== null && (!notifiedFor || Date.parse(anchor) > Date.parse(notifiedFor)) && now.getTime() - Date.parse(anchor) >= hours * 3_600_000;
}
export function quietTitle(name: string | null, hours: number, lastCall: string | null) {
  const last = lastCall ? `last call ${new Date(lastCall).toISOString().slice(11, 16)} UTC` : "no calls recorded";
  return `${name || "Unnamed agent"} has made no calls for ${hours} ${hours === 1 ? "hour" : "hours"} (${last})`;
}
export async function readQuietSetting(db: Db | Tx, hash: string) {
  const [row] = await db.select().from(kv).where(eq(kv.key, settingKey(hash)));
  return row ? row.value as Settings : null;
}
export async function saveQuietSetting(ctx: Ctx, key: KeyRow, hours: QuietHours, now = new Date()) {
  return ctx.db.transaction(async tx => {
    await lockAccount(tx, key.accountId);
    const old = await readQuietSetting(tx, key.keyHash);
    // Saving the same choice does not restart the clock or re-arm an already reported period.
    const value: Settings = old?.hours === hours ? old : {
      hours, enabled_at: old && old.hours !== null ? old.enabled_at : now.toISOString(), notified_for: old?.notified_for ?? null,
      notices: (old?.notices ?? []).filter(item => Date.parse(item.at) > now.getTime() - RETENTION).slice(-100),
    };
    await tx.insert(kv).values({ key: settingKey(key.keyHash), value, updatedAt: now })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
    return { key_hash: key.keyHash, hours: value.hours };
  });
}

async function lastQuietActivity(db: Db | Tx, key: KeyRow, now: Date) {
  const children = await db.select({ hash: agentSessions.keyHash }).from(agentSessions).innerJoin(keys, eq(keys.keyHash, agentSessions.keyHash))
    .where(and(eq(agentSessions.parentKeyHash, key.keyHash), eq(keys.accountId, key.accountId)));
  const hashes = [key.keyHash, ...children.map(row => row.hash)];
  const [charge] = await db.select({ at: ledger.createdAt }).from(ledger).where(and(
    eq(ledger.accountId, key.accountId), inArray(ledger.keyHash, hashes),
    sql`${ledger.amount} < 0`, inArray(ledger.kind, ["usage", "tool_call", "data_tool"]), lte(ledger.createdAt, now),
  )).orderBy(desc(ledger.createdAt)).limit(1);
  const [decision] = await db.select({ at: agentActionDecisions.createdAt }).from(agentActionDecisions)
    .where(and(inArray(agentActionDecisions.keyHash, hashes), lte(agentActionDecisions.createdAt, now)))
    .orderBy(desc(agentActionDecisions.createdAt)).limit(1);
  const times = [charge?.at, decision?.at].filter((at): at is Date => !!at);
  return times.length ? new Date(Math.max(...times.map(at => at.getTime()))).toISOString() : null;
}

export function registerQuietAlertsJob(ctx: Ctx) {
  if (ctx.cfg.quietAgentAlertsEnabled && ctx.cfg.agentPolicyEnabled && ctx.cfg.runtimeRole !== "api")
    ctx.jobs.register("quiet-agent-alerts", 300_000, () => runQuietAlerts(ctx));
}
export async function runQuietAlerts(ctx: Ctx, opts: { now?: Date; telegramFetch?: typeof fetch } = {}) {
  if (!ctx.cfg.quietAgentAlertsEnabled || !ctx.cfg.agentPolicyEnabled || ctx.cfg.runtimeRole === "api") return { skipped: true, created: 0 };
  const now = opts.now ?? new Date();
  let after = "", created = 0;
  // Keyset pages cover every configured agent, rather than repeatedly selecting only the first page.
  for (;;) {
    const batch = await ctx.db.select({ setting: kv.key, agent: keys }).from(kv).innerJoin(keys, sql`${kv.key} = ${QUIET_PREFIX} || ${keys.keyHash}`)
      .where(and(like(kv.key, QUIET_PREFIX + "%"), gt(kv.key, after))).orderBy(asc(kv.key)).limit(100);
    if (!batch.length) break;
    for (const candidate of batch) {
      after = candidate.setting;
      const outgoing = await ctx.db.transaction(async tx => {
        // Same account lock as Stop and Guard. No ctx.db calls or outbound sends inside this transaction.
        await lockAccount(tx, candidate.agent.accountId);
        const [key] = await tx.select().from(keys).where(eq(keys.keyHash, candidate.agent.keyHash));
        const [saved] = await tx.select().from(kv).where(eq(kv.key, candidate.setting)).for("update");
        if (!key || !saved) return;
        const state = saved.value as Settings;
        const notices = state.notices.filter(item => Date.parse(item.at) > now.getTime() - RETENTION).slice(-100);
        if (notices.length !== state.notices.length) await tx.update(kv).set({ value: { ...state, notices }, updatedAt: now }).where(eq(kv.key, saved.key));
        if (state.hours === null || key.disabled || (key.expiresAt && key.expiresAt <= now)) return;
        if ((await policiesFor(tx, key.keyHash)).some(policy => visibleStop(policy, now).killed)) return;
        const lastCall = await lastQuietActivity(tx, key, now);
        const anchor = lastCall ?? state.enabled_at;
        if (!quietDue(state.hours, anchor, state.notified_for, now)) return;
        const item: Notice = { id: uid("quiet"), at: now.toISOString(), title: quietTitle(key.name, state.hours, lastCall), last_call_at: lastCall, hours: state.hours };
        await tx.update(kv).set({ value: { ...state, notified_for: anchor, notices: [...notices, item].slice(-100) }, updatedAt: now }).where(eq(kv.key, saved.key));
        return { key, item };
      });
      if (!outgoing) continue;
      created++;
      // Claim before sending: a failed send or crash may lose Telegram delivery, but cannot duplicate a claim.
      const targets = await linkedAlertTargets(ctx, outgoing.key.accountId, outgoing.key.keyHash, outgoing.item.title, opts.telegramFetch);
      for (const target of targets) await target.send();
    }
  }
  return { created };
}

export async function quietInboxItems(ctx: Ctx, caller: KeyRow, asOf: string, since?: string) {
  if (!ctx.cfg.quietAgentAlertsEnabled || !ctx.cfg.agentPolicyEnabled) return [];
  // Caller is already checked by inboxScope. Match the current account/team, never a stored team snapshot.
  const rows = await ctx.db.select({ value: kv.value, label: keys.name }).from(kv).innerJoin(keys, sql`${kv.key} = ${QUIET_PREFIX} || ${keys.keyHash}`)
    .where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!)));
  return rows.flatMap(row => (row.value as Settings).notices.map(item => ({
    id: item.id, at: item.at, kind: "quiet-agent", title: item.title, status: "quiet", href: "/agents/", key_label: row.label, unread: true,
  }))).filter(item => Date.parse(item.at) <= Date.parse(asOf) && Date.parse(item.at) > Date.parse(asOf) - RETENTION && (!since || Date.parse(item.at) > Date.parse(since)))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 101);
}
