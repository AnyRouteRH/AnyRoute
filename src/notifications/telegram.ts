import { and, eq, like } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import { ownedKey } from "../api/agents.ts";
import { keys, kv } from "../db/schema.ts";
import { encrypt, decrypt, genId, sha256 } from "../lib/util.ts";
import { lockLinks, readLink, validPrincipal, type Link } from "../telegram/linking.ts";
import { TelegramApi } from "../services/telegram.ts";
import { scheduleNoticeOwner } from "../schedules/caller.ts";
import { readPreferences, quietUntil, type NoticeType } from "./prefs.ts";
import { noticeFeatureEnabled } from "./config.ts";
const QUEUE = "notification-quiet:";
type Queued = { account: string; uid: number; generation: string; key_hash: string; principal_hash: string; team: string | null; management: boolean; type: NoticeType; due: string; created: string; sealed: string; legacy: boolean };
/** True means skipped or durably queued. Call under the sender's existing authority/transaction lock. */
export async function deferTelegram(ctx: Ctx, link: Link, keyHash: string, text: string, type: NoticeType, caller: KeyRow, now = new Date(), legacy = false) {
  const prefs = await readPreferences(ctx.db, link.account);
  if (!prefs.channels[type].telegram) return true;
  const due = type === "approvals" || !ctx.cfg.notificationQuietHoursEnabled ? null : quietUntil(prefs.quiet_hours, now);
  if (!due) return false;
  const value: Queued = { account: link.account, uid: link.uid, generation: link.generation, key_hash: keyHash, principal_hash: caller.keyHash, team: caller.teamId, management: caller.management, type, due: due.toISOString(), created: now.toISOString(), sealed: encrypt(ctx.cfg.appSecret, text), legacy };
  await ctx.db.insert(kv).values({ key: QUEUE + genId(), value });
  return true;
}
export function registerNotificationQuietJob(ctx: Ctx) {
  if (ctx.cfg.notificationQuietHoursEnabled && ctx.cfg.telegram.linkingEnabled && ctx.cfg.telegram.botToken && ctx.cfg.runtimeRole !== "api") ctx.jobs.register("notification-quiet", 60_000, () => flushQuietNotifications(ctx));
}
/** Recheck current link, role, team, ownership and switches before sending one bounded bundle per recipient. */
export async function flushQuietNotifications(ctx: Ctx, fetchImpl?: typeof fetch, now = new Date()) {
  if (!ctx.cfg.notificationQuietHoursEnabled || !ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken || ctx.cfg.runtimeRole === "api") return { sent: 0, skipped: "disabled" };
  return ctx.db.transaction(async tx => {
    await lockLinks(tx);
    const scoped = { ...ctx, db: tx as unknown as Db };
    const rows = await tx.select().from(kv).where(like(kv.key, QUEUE + "%")).orderBy(kv.updatedAt, kv.key).limit(500);
    const groups = new Map<string, { uid: number; rows: string[]; texts: string[] }>();
    for (const row of rows) {
      const item = row.value as Queued;
      try {
        if (now.getTime() - Date.parse(item.created) > 7 * 86_400_000) throw new Error("expired");
        let link: Link | undefined;
        if (item.legacy) {
          const [saved] = await tx.select().from(kv).where(eq(kv.key, `telegram:user:${item.uid}`));
          const sealed = (saved?.value as { key?: string })?.key;
          const plain = sealed ? decrypt(ctx.cfg.appSecret, sealed) : "", prefix = `tg:${item.uid}:`;
          if (!plain.startsWith(prefix) || sha256(plain.slice(prefix.length)) !== item.principal_hash) throw new Error("unlinked");
          link = { account: item.account, key_hash: item.principal_hash, uid: item.uid, generation: item.generation, linked_at: item.created };
        } else link = await readLink(tx, item.uid);
        if (!link || link.generation !== item.generation || link.account !== item.account) throw new Error("unlinked");
        // Prevent authority from changing while the bundled send is in flight.
        await tx.select({ hash: keys.keyHash }).from(keys).where(and(eq(keys.keyHash, link.key_hash), eq(keys.accountId, item.account))).for("share");
        const caller = await validPrincipal(scoped, link);
        if (caller.teamId !== item.team || caller.management !== item.management) throw new Error("scope_changed");
        await ownedKey(scoped, caller, item.key_hash);
        if (item.type === "scheduled_results") await scheduleNoticeOwner(scoped, caller);
        const prefs = await readPreferences(tx, item.account);
        if (!prefs.channels[item.type].telegram) throw new Error("muted");
        if (!noticeFeatureEnabled(scoped, item.type)) continue;
        if (quietUntil(prefs.quiet_hours, now)) continue;
        const id = `${item.uid}:${item.generation}`, group = groups.get(id) ?? { uid: item.uid, rows: [], texts: [] };
        group.rows.push(row.key); group.texts.push(decrypt(ctx.cfg.appSecret, item.sealed)); groups.set(id, group);
      } catch { await tx.delete(kv).where(eq(kv.key, row.key)); }
    }
    let sent = 0;
    for (const group of groups.values()) {
      const excerpts = group.texts.map(text => text.replace(/\s+/g, " ").slice(0, 180));
      const title = `Anyroute: ${group.texts.length} notifications\n`;
      let text = title;
      for (const excerpt of excerpts) if ((text + excerpt + "\n").length < 3850) text += excerpt + "\n";
      text += "Read all notices: https://anyroute.tech/dashboard/#inbox";
      try {
        await new TelegramApi(ctx.cfg.telegram.botToken!, fetchImpl).call("sendMessage", { chat_id: group.uid, text, link_preview_options: { is_disabled: true } }, AbortSignal.timeout(5_000));
        for (const key of group.rows) await tx.delete(kv).where(eq(kv.key, key));
        sent++;
      } catch { /* Keep the encrypted queue for the next enabled tick, up to seven days. */ }
    }
    return { sent };
  });
}
