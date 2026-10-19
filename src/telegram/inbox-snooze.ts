// K187: use the existing linked sender, lock, channel switch and quiet-hour delivery pattern.
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { readInbox } from "../inbox/read.ts";
import { snoozeKey, type Snooze } from "../inbox/snooze.ts";
import { channelEnabled, quietUntil, readPreferences } from "../notifications/prefs.ts";
import { accountLinks } from "./linking.ts";
import { sendLinkedAlert } from "./delivery.ts";
import { inboxNoticeType } from "../notifications/inbox.ts";
export async function sendSnoozeReminder(ctx: Ctx, record: Snooze, item: { id: string; kind: string; title: string }, fetchImpl?: typeof fetch) {
  const type = inboxNoticeType(item.kind);
  let sent = 0;
  for (const link of await accountLinks(ctx.db, record.account)) {
    const delivered = await sendLinkedAlert(ctx, link, `Reminder: ${item.title.replace(/\s+/g, " ").slice(0, 180)}`, link.key_hash, fetchImpl, async (scoped, caller) => {
      if (!scoped.cfg.inboxSnoozeRemindersEnabled || (type && !await channelEnabled(scoped, record.account, type, "telegram"))) throw new Error("muted");
      const prefs = await readPreferences(scoped.db, record.account);
      if (quietUntil(prefs.quiet_hours)) throw new Error("muted or quiet");
      // Recheck the source with the recipient's current authority under the link lock.
      const page = await readInbox(scoped, caller, undefined, { ignoreSnooze: true });
      if (!page.data.some(row => row.id === record.id)) throw new Error("notice unavailable");
      const [saved] = await scoped.db.select().from(kv).where(eq(kv.key, snoozeKey(record.account, record.scope, record.id)));
      const live = saved?.value as Snooze | undefined;
      if (!live || live.until !== record.until || !live.claimed) throw new Error("snooze changed");
    }, "inbox_snooze");
    if (delivered) sent++;
  }
  return sent;
}
