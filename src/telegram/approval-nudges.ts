// G164: reuse approval callback identities and current link/decision authorization.
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { keys, kv } from "../db/schema.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { lockAccount, policiesFor } from "../agents/store.ts";
import { plainApprovalText } from "../agents/rulebook-approval-text.ts";
import { nudgeDue, nudgeTitle } from "../agents/approval-nudges.ts";
import { deferTelegram } from "../notifications/telegram.ts";
import { channelEnabled } from "../notifications/prefs.ts";
import { ownedKey } from "../api/agents.ts";
import { TelegramApi } from "../services/telegram.ts";
import { lockLinks, readLink, validPrincipal, type Link } from "./linking.ts";
import { telegramCanApprove } from "./approvers.ts";
import { notificationKey, approvalButtons } from "./delivery.ts";
export const approvalMessageMatches = (notice: { message_id?: number; reminder_message_id?: number } | undefined, id: number) => !!notice && (notice.message_id === id || notice.reminder_message_id === id);
export async function sendApprovalNudge(ctx: Ctx, id: string, saved: Link, fetchImpl?: typeof fetch, now = new Date()) {
  if (!ctx.cfg.approvalNudgesEnabled || !ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken) return false;
  try {
    return await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const link = await readLink(tx, saved.uid);
      if (!link || link.generation !== saved.generation) return false;
      const scoped = { ...ctx, db: tx as unknown as Db };
      const caller = await validPrincipal(scoped, link, true);
      await lockAccount(tx, link.account);
      const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, id)).for("update");
      if (!row || !nudgeDue(row, new Date(Math.max(now.getTime(), Date.now())))) return false;
      await ownedKey(scoped, caller, row.keyHash);
      if (!await telegramCanApprove(scoped, caller, row.keyHash)) return false;
      if (!await channelEnabled(scoped, link.account, "approval_reminders", "telegram")) return false;
      if (await deferTelegram(scoped, link, row.keyHash, "", "approval_reminders", caller, now)) return false;
      const key = notificationKey(id, link), [stored] = await tx.select().from(kv).where(eq(kv.key, key));
      const old = stored?.value as { message_id?: number; reminder_message_id?: number } | undefined;
      if (old?.reminder_message_id) return false;
      const [agent] = await tx.select().from(keys).where(eq(keys.keyHash, row.keyHash));
      const policies = await policiesFor(tx, row.keyHash);
      const text = `${nudgeTitle(row.expiresAt, now)}\n${plainApprovalText(row, policies.map(p => ({ policy: p.spec, inherited: p.keyHash !== row.keyHash })), agent?.name ?? undefined)}`;
      const sent = await new TelegramApi(ctx.cfg.telegram.botToken!, fetchImpl).call<{ message_id: number }>("sendMessage", { chat_id: link.uid, text, reply_markup: { inline_keyboard: approvalButtons(id, link.generation) } }, AbortSignal.timeout(5_000));
      const value = { ...old, uid: link.uid, approval: id, generation: link.generation, expires: row.expiresAt.getTime(), status: "pending", reminder_message_id: sent.message_id, ...(!old?.message_id ? { message_id: sent.message_id } : {}) };
      await tx.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
      return true;
    });
  } catch { return false; } // A failed attempt is not retried: the approval-wide claim already committed.
}
