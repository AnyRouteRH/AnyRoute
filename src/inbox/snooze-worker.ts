// K187: waking the inbox is read-time behavior; only Telegram needs a worker.
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { keys, kv } from "../db/schema.ts";
import { inboxScope, readInbox } from "./read.ts";
import { lockSnoozes, type Snooze } from "./snooze.ts";
import { rotatedExpiry } from "../key-rotation/store.ts";
import { sendSnoozeReminder } from "../telegram/inbox-snooze.ts";
import { quietUntil, readPreferences } from "../notifications/prefs.ts";
export function registerInboxSnooze(ctx: Ctx) {
  if (ctx.cfg.inboxSnoozeRemindersEnabled && ctx.cfg.telegram.linkingEnabled && ctx.cfg.telegram.botToken && ctx.cfg.runtimeRole !== "api") ctx.jobs.register("inbox-snooze", 60_000, () => runInboxSnooze(ctx));
}
export async function runInboxSnooze(ctx: Ctx, fetchImpl?: typeof fetch, now = new Date()) {
  if (!ctx.cfg.inboxSnoozeRemindersEnabled || !ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken || ctx.cfg.runtimeRole === "api") return { attempted: 0, skipped: "disabled" };
  const old = await ctx.db.select({ key: kv.key }).from(kv).where(and(like(kv.key, "inbox-snooze:%"), sql`${kv.value}->>'until' < ${new Date(now.getTime() - 30 * 86_400_000).toISOString()}`)).limit(500);
  if (old.length) await ctx.db.delete(kv).where(and(inArray(kv.key, old.map(row => row.key)), sql`${kv.value}->>'until' < ${new Date(now.getTime() - 30 * 86_400_000).toISOString()}`));
  const rows = await ctx.db.select().from(kv).where(and(like(kv.key, "inbox-snooze:%"), sql`${kv.value}->>'claimed' = 'false'`, sql`${kv.value}->>'until' <= ${now.toISOString()}`)).orderBy(kv.updatedAt, kv.key).limit(500);
  let attempted = 0;
  for (const row of rows) {
    const saved = row.value as Snooze;
    if (saved.claimed || saved.until > now.toISOString()) continue;
    // Claim commits before delivery. Interrupted/failed sends are not retried or duplicated next tick.
    const claimed = await ctx.db.transaction(async tx => {
      await lockSnoozes(tx, saved.account);
      const [live] = await tx.select().from(kv).where(eq(kv.key, row.key)), record = live?.value as Snooze | undefined;
      if (!record || record.claimed || record.until !== saved.until) return false;
      const prefs = await readPreferences(tx, saved.account);
      if (quietUntil(prefs.quiet_hours, now)) { await tx.update(kv).set({ updatedAt: now }).where(eq(kv.key, row.key)); return false; }
      await tx.update(kv).set({ value: { ...record, claimed: true }, updatedAt: now }).where(eq(kv.key, row.key));
      return true;
    });
    if (!claimed) continue;
    try {
      const [principal] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, saved.principal), eq(keys.accountId, saved.account)));
      if (!principal || principal.disabled) continue;
      const expiry = await rotatedExpiry(ctx.db, principal.keyHash, principal.expiresAt); if (expiry && expiry <= now) continue;
      if ((await inboxScope(ctx, principal)).seenScope !== saved.scope) continue;
      const page = await readInbox(ctx, principal, undefined, { ignoreSnooze: true });
      const item = page.data.find(item => item.id === saved.id);
      if (!item) continue;
      attempted += await sendSnoozeReminder(ctx, saved, item, fetchImpl);
    } catch { /* Revoked or changed authority never produces a reminder. */ }
  }
  return { attempted };
}
