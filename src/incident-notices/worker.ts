import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { kv, statusIncidents } from "../db/schema.ts";
import { sha256 } from "../lib/util.ts";
import { fail } from "../lib/errors.ts";
import { channelEnabled } from "../notifications/prefs.ts";
import { isPublicIncident, type IncidentRow, type IncidentUpdate } from "../services/slo.ts";
import { accountLinks } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";
import { type IncidentSubscription } from "./preferences.ts";
const WINDOW_MS = 90 * 86_400_000;
const labels: Record<string, string> = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
type Notice = { id: string; account: string; at: string; incident: string; title: string; text: string; inbox: boolean };
const noticePrefix = (account: string) => `incident-notices:change:${sha256(account)}:`;
/** Index disambiguates even two identical public updates posted in the same millisecond. */
export function incidentChanges(row: IncidentRow) {
  if (!isPublicIncident(row)) return [];
  return (row.updates as IncidentUpdate[]).flatMap((update, index) => labels[update.status] ? [{
    change: sha256(JSON.stringify([row.id, index, update.at, update.status, update.text])),
    at: update.at, incident: row.id, title: `${labels[update.status]}: ${row.title}`, text: update.text,
  }] : []);
}
export function registerIncidentNoticesJob(ctx: Ctx) {
  if (ctx.cfg.statusIncidentNoticesEnabled && ctx.cfg.runtimeRole !== "api") ctx.jobs.register("incident-notices", 60_000, () => runIncidentNotices(ctx));
}
export async function runIncidentNotices(ctx: Ctx, opts: { now?: Date; telegramFetch?: typeof fetch } = {}) {
  if (!ctx.cfg.statusIncidentNoticesEnabled || ctx.cfg.runtimeRole === "api") return { created: 0, skipped: "disabled" };
  const now = opts.now ?? new Date(), cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
  const rows = await ctx.db.select().from(statusIncidents).where(gte(statusIncidents.updatedAt, new Date(cutoff)));
  const changes = rows.flatMap(incidentChanges).filter(item => item.at >= cutoff && item.at <= now.toISOString());
  const subscriptions = await ctx.db.select({ key: kv.key }).from(kv).where(like(kv.key, "incident-notices:subscription:%"));
  let created = 0;
  for (const subscription of subscriptions) {
    const outgoing = await ctx.db.transaction(async tx => {
      // Settings saves and competing replicas serialize on the same subscription row.
      const [saved] = await tx.select().from(kv).where(eq(kv.key, subscription.key)).for("update");
      if (!saved) return [];
      const account = subscription.key.slice("incident-notices:subscription:".length), since = saved.value as IncidentSubscription;
      const scoped = { ...ctx, db: tx as unknown as Db };
      const inbox = await channelEnabled(scoped, account, "status_incidents", "inbox"), telegram = await channelEnabled(scoped, account, "status_incidents", "telegram");
      const outgoing: Notice[] = [];
      for (const change of changes) {
        const show = inbox && !!since.inbox && change.at >= since.inbox;
        const send = telegram && !!since.telegram && change.at >= since.telegram;
        if (!show && !send) continue;
        const id = noticePrefix(account) + change.change;
        const item: Notice = { id, account, at: change.at, incident: change.incident, title: change.title, text: change.text, inbox: show };
        const claimed = await tx.insert(kv).values({ key: id, value: item, updatedAt: now }).onConflictDoNothing().returning({ key: kv.key });
        if (!claimed.length) continue;
        created++;
        if (send) outgoing.push(item);
      }
      return outgoing;
    });
    // Durable claim precedes a single outbound attempt; never retry an ambiguous send.
    for (const item of outgoing) for (const link of await accountLinks(ctx.db, item.account)) {
      await sendLinkedAlert(ctx, link, `${item.title}\n${item.text}\nhttps://anyroute.tech/status/`, link.key_hash, opts.telegramFetch, async (scoped, key) => {
        if (!scoped.cfg.statusIncidentNoticesEnabled || !key.management || key.accountId !== item.account) fail(403, "Account management access required.", "forbidden");
      }, "status_incidents");
    }
  }
  // Claims survive the entire replay window. Flag off pauses pruning as well as sending.
  await ctx.db.delete(kv).where(and(like(kv.key, "incident-notices:change:%"), sql`${kv.value}->>'at' < ${cutoff}`));
  return { created, skipped: false };
}
export async function incidentNoticeItems(ctx: Ctx, account: string, asOf: string, since?: string) {
  if (!ctx.cfg.statusIncidentNoticesEnabled) return [];
  const rows = await ctx.db.select().from(kv).where(and(like(kv.key, noticePrefix(account) + "%"), sql`${kv.value}->>'inbox' = 'true'`)).orderBy(desc(sql`${kv.value}->>'at'`), desc(kv.key)).limit(101);
  return rows.map(row => row.value as Notice).filter(item => item.at <= asOf && (!since || item.at > since))
    .map(item => ({ id: item.id, at: item.at, kind: "status_incidents", title: item.title, status: null, href: "/status/", unread: true }));
}
