import { and, asc, desc, eq, like, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { keys, kv } from "../db/schema.ts";
import { accountLinks, validPrincipal } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";
import { preferenceKey, type SecurityNotice } from "./records.ts";
import type { KeyRow } from "../api/auth.ts";

const CURSOR = "security-alerts:cursor";
export function registerSecurityAlertsJob(ctx: Ctx) {
  if (ctx.cfg.securityAlertsEnabled && ctx.cfg.runtimeRole !== "api") ctx.jobs.register("security-alerts", 30_000, () => runSecurityAlerts(ctx));
}
export async function runSecurityAlerts(ctx: Ctx, fetchImpl?: typeof fetch) {
  if (!ctx.cfg.securityAlertsEnabled || ctx.cfg.runtimeRole === "api") return { skipped: true, created: 0 };
  const outgoing = await ctx.db.transaction(async tx => {
    await tx.insert(kv).values({ key: CURSOR, value: { processed: 0 } }).onConflictDoNothing();
    const [cursor] = await tx.select().from(kv).where(eq(kv.key, CURSOR)).for("update");
    // The per-event state is the durable cursor: late commits and equal timestamps cannot be skipped.
    const pending = await tx.select().from(kv).where(and(like(kv.key, "security-alerts:event:%"), sql`${kv.value}->>'state' = 'pending'`)).orderBy(asc(kv.updatedAt), asc(kv.key)).limit(500);
    const outgoing: SecurityNotice[] = [];
    for (const row of pending) {
      const notice = row.value as SecurityNotice;
      const [preference] = await tx.select().from(kv).where(eq(kv.key, preferenceKey(notice.account)));
      const enabled = (preference?.value as { enabled?: boolean } | undefined)?.enabled !== false;
      if (enabled) notice.at = new Date().toISOString(); // Inbox arrival time keeps a pending alert outside an earlier seen snapshot.
      await tx.update(kv).set({ value: { ...notice, state: enabled ? "inbox" : "muted" }, updatedAt: new Date() }).where(eq(kv.key, row.key));
      if (enabled) outgoing.push(notice);
    }
    await tx.update(kv).set({ value: { processed: Number((cursor.value as { processed?: number }).processed ?? 0) + pending.length }, updatedAt: new Date() }).where(eq(kv.key, CURSOR));
    await tx.delete(kv).where(and(like(kv.key, "security-alerts:event:%"), lt(kv.updatedAt, new Date(Date.now() - 90 * 86_400_000)), sql`${kv.value}->>'state' <> 'pending'`));
    return outgoing;
  });
  // Claim before one send attempt. A crash or ambiguous failure can leave an inbox item without a Telegram message.
  for (const notice of outgoing) for (const link of await accountLinks(ctx.db, notice.account)) {
    try {
      await ctx.db.transaction(async tx => {
        await tx.select({ hash: keys.keyHash }).from(keys).where(eq(keys.keyHash, link.key_hash)).for("share");
        const scoped = { ...ctx, db: tx as unknown as Db };
        const principal = await validPrincipal(scoped, link);
        if (!principal.management && (!notice.team || principal.teamId !== notice.team)) return;
        const [pref] = await tx.select().from(kv).where(eq(kv.key, preferenceKey(notice.account)));
        if ((pref?.value as { enabled?: boolean } | undefined)?.enabled === false) return;
        await sendLinkedAlert(scoped, link, notice.title, link.key_hash, fetchImpl);
      });
    } catch { /* Revoked links receive nothing. */ }
  }
  return { created: outgoing.length };
}
export async function securityInbox(ctx: Ctx, key: KeyRow, whole: boolean, since?: string, asOf = new Date().toISOString()) {
  if (!ctx.cfg.securityAlertsEnabled || !whole) return [];
  const rows = await ctx.db.select().from(kv).where(and(like(kv.key, "security-alerts:event:%"), sql`${kv.value}->>'account' = ${key.accountId}`, sql`${kv.value}->>'state' = 'inbox'`, key.management ? undefined : sql`${kv.value}->>'team' = ${key.teamId ?? ""}`, since ? sql`${kv.value}->>'at' > ${since}` : undefined, sql`${kv.value}->>'at' <= ${asOf}`)).orderBy(desc(kv.updatedAt), desc(kv.key)).limit(101);
  return rows.map(row => { const notice = row.value as SecurityNotice; return { id: row.key, at: notice.at, kind: "security", title: notice.title, href: "/dashboard/#settings", status: null, unread: true }; });
}
