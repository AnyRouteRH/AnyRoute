// K195: account-locked crossing claims and the existing Stop operations, with no new schema.
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts, keys, kv } from "../db/schema.ts";
import { agentPolicies } from "../agents/schema.ts";
import { changeAllStops } from "../agents/stop-all.ts";
import { changeKill, lockAccount } from "../agents/store.ts";
import { securityContext } from "../security-alerts/records.ts";
import { accountLinks, validPrincipal } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";
import { channelEnabled } from "../notifications/prefs.ts";
import { rotatedExpiry } from "../key-rotation/store.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { uid } from "../lib/util.ts";
import { crossing } from "./low-balance.ts";

export const pauseKey = (account: string) => `low-balance-pause:${account}`;
export const RESUME_ALL_HREF = "/agents/?command=resume-all";
type Notice = { id: string; at: string; threshold: string; balance: string; count: number; actor: string };
export type PauseSetting = { threshold: string | null; actor: string; alerted: boolean; notices: Notice[] };
const empty = (): PauseSetting => ({ threshold: null, actor: "", alerted: false, notices: [] });
export const pauseAvailable = (ctx: Ctx) => ctx.cfg.lowBalancePauseEnabled && ctx.cfg.agentPolicyEnabled;
export async function readPause(db: Db | Tx, account: string): Promise<PauseSetting> {
  const [row] = await db.select().from(kv).where(eq(kv.key, pauseKey(account)));
  return row ? row.value as PauseSetting : empty();
}
async function writePause(db: Db | Tx, account: string, value: PauseSetting) {
  await db.insert(kv).values({ key: pauseKey(account), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}
export async function pauseOwner(ctx: Ctx, account: string, hash: string) {
  const caller = await validPrincipal(ctx, { account, key_hash: hash });
  if (!caller.management || caller.scope === "read" || caller.scope === "inference") fail(403, "Use an account management key to pause all agents.", "forbidden");
  const expiry = await rotatedExpiry(ctx.db, caller.keyHash, caller.expiresAt);
  if (expiry && expiry <= new Date()) fail(403, "This key has expired.", "forbidden");
  return caller;
}
export const pauseResponse = (ctx: Ctx, value: PauseSetting) => ({ low_balance_usd: value.threshold === null ? null : picoToUsd(BigInt(value.threshold)), enabled: pauseAvailable(ctx) });
export async function savePause(ctx: Ctx, account: string, actor: string, amount: number | null) {
  return ctx.db.transaction(async tx => {
    await lockAccount(tx, account);
    await pauseOwner({ ...ctx, db: tx as unknown as Db }, account, actor);
    const current = await readPause(tx, account), threshold = amount === null ? null : usdToPico(amount).toString();
    const value = { ...current, threshold, actor, alerted: threshold === current.threshold ? current.alerted : false };
    await writePause(tx, account, value);
    return pauseResponse(ctx, value);
  });
}
export const pauseReason = (threshold: bigint) => `Paused: balance below $${picoToUsdString(threshold)}`;
export const pauseText = (notice: Notice, site: string) => `${pauseReason(BigInt(notice.threshold))}. ${notice.count} ${notice.count === 1 ? "agent is" : "agents are"} stopped until you resume. Resume all: ${site}${RESUME_ALL_HREF}`;
export function registerLowBalancePauseJob(ctx: Ctx) {
  if (pauseAvailable(ctx)) ctx.jobs.register("low-balance-pause", 60_000, () => runLowBalancePause(ctx));
}
export async function runLowBalancePause(ctx: Ctx, fetchImpl?: typeof fetch) {
  if (!pauseAvailable(ctx)) return { skipped: true };
  const candidates = await ctx.db.select({ key: kv.key }).from(kv).where(and(like(kv.key, "low-balance-pause:%"), sql`${kv.value}->>'threshold' is not null`)).orderBy(kv.key);
  let paused = 0, rearmed = 0;
  for (const candidate of candidates) {
    const accountId = candidate.key.slice("low-balance-pause:".length);
    const notice = await ctx.db.transaction(async tx => {
      await lockAccount(tx, accountId);
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
      const value = await readPause(tx, accountId);
      if (!account || value.threshold === null) return null;
      const threshold = BigInt(value.threshold), state = crossing(account.balance, threshold, value.alerted);
      if (state === "rearm") { await writePause(tx, accountId, { ...value, alerted: false }); rearmed++; }
      if (state !== "alert") return null;
      const scoped = { ...ctx, db: tx as unknown as Db };
      let caller;
      try { caller = await pauseOwner(scoped, accountId, value.actor); }
      catch (error) { if (error instanceof ApiError && error.status === 403) return null; throw error; }
      const reason = pauseReason(threshold);
      const result = await changeAllStops(scoped, tx, caller, true, reason, null);
      // Bulk Stop preserves active timed Stops. Extend those through changeKill so none auto-resume.
      const timed = await tx.select({ policy: agentPolicies }).from(agentPolicies).innerJoin(keys, eq(keys.keyHash, agentPolicies.keyHash)).where(and(eq(keys.accountId, accountId), eq(agentPolicies.killed, true), isNotNull(agentPolicies.killUntil))).orderBy(agentPolicies.keyHash);
      for (const { policy } of timed) {
        await securityContext.run(scoped, () => changeKill(tx, policy, true, reason, caller.keyHash, null));
        result.count++;
      }
      const item: Notice | null = result.count ? { id: uid("lbp_"), at: new Date().toISOString(), threshold: value.threshold, balance: account.balance.toString(), count: result.count, actor: caller.keyHash } : null;
      await writePause(tx, accountId, { ...value, alerted: true, notices: item ? [item, ...value.notices].slice(0, 100) : value.notices });
      return item;
    });
    if (!notice) continue;
    paused += notice.count;
    // The Stop events, inbox history and crossing claim commit before one outbound attempt per live link.
    for (const link of await accountLinks(ctx.db, accountId)) await sendLinkedAlert(ctx, link, pauseText(notice, ctx.cfg.siteUrl), link.key_hash, fetchImpl, async (scoped, caller) => pauseOwner(scoped, accountId, caller.keyHash), "low_balance_pause");
  }
  return { paused, rearmed };
}
export async function lowBalancePauseInbox(ctx: Ctx, account: string, asOf: string, since?: string) {
  if (!pauseAvailable(ctx) || !await channelEnabled(ctx, account, "low_balance_pause", "inbox")) return [];
  return (await readPause(ctx.db, account)).notices.filter(item => item.at <= asOf && (!since || item.at > since)).map(item => ({ id: `low-balance-pause:${item.id}`, at: item.at, kind: "low_balance_pause", title: `${pauseReason(BigInt(item.threshold))}. Resume all`, href: RESUME_ALL_HREF, amount: picoToUsdString(BigInt(item.balance)), status: null, unread: true }));
}
