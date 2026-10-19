// K186: reply handling runs before chat so decision text never reaches a model.
import { and, eq, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { kv } from "../db/schema.ts";
import { ownedKey } from "../api/agents.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import type { ApprovalRow } from "../agents/approvals.ts";
import { attachDecisionNote } from "../agents/decision-notes.ts";
import { ApiError } from "../lib/errors.ts";
import { channelEnabled } from "../notifications/prefs.ts";
import { deferTelegram } from "../notifications/telegram.ts";
import type { TelegramApi, TgUpdate } from "../services/telegram.ts";
import { linkLimit, lockLinks, readLink, validPrincipal } from "./linking.ts";

export const NOTE_PROMPT = "Add a reason? Reply with it, or /skip";
type NoteMarker = { uid: number; generation: string; approval: string; status: string; expires: number; note_prompt_id?: number; note_until?: number; note_done?: boolean };
type Reply = { reply_to_message?: { message_id: number; text?: string } };

/** Called only after the existing atomic callback decision, on that transaction's connection. */
export async function askDecisionNote(ctx: Ctx, api: TelegramApi, key: string, row: ApprovalRow) {
  if (!ctx.cfg.telegramApprovalNotesEnabled) return;
  const [saved] = await ctx.db.select().from(kv).where(eq(kv.key, key));
  const marker = saved?.value as NoteMarker | undefined;
  if (!marker || marker.expires <= Date.now()) return;
  const link = await readLink(ctx.db, marker.uid);
  if (!link || link.generation !== marker.generation || link.key_hash !== row.decidedBy || !await channelEnabled(ctx, link.account, "approvals", "telegram")) return;
  const caller = await validPrincipal(ctx, link, true);
  if (await deferTelegram(ctx, link, row.keyHash, "", "approvals", caller)) return;
  const sent = await api.call<{ message_id: number }>("sendMessage", { chat_id: link.uid, text: NOTE_PROMPT, reply_markup: { force_reply: true, input_field_placeholder: "Optional reason, up to 280 characters" } }, AbortSignal.timeout(5_000));
  await ctx.db.update(kv).set({ value: { ...marker, status: row.status, note_prompt_id: sent.message_id, note_until: Math.min(marker.expires, Date.now() + 300_000), note_done: false }, updatedAt: new Date() }).where(eq(kv.key, key));
}

export async function handleApprovalNoteUpdate(ctx: Ctx, api: TelegramApi, update: TgUpdate): Promise<boolean> {
  const message = update.message as (NonNullable<TgUpdate["message"]> & Reply) | undefined;
  if (!message?.from || message.from.is_bot || message.chat.type !== "private" || message.chat.id !== message.from.id) return false;
  const reply = message.reply_to_message;
  const recognizable = reply?.text === NOTE_PROMPT;
  const skip = /^\/skip(?:@\w+)?$/i.test(message.text?.trim() ?? "");
  if ((!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegramApprovalNotesEnabled) && !recognizable) return false;
  // Do not read ordinary chat unless a live, decision-bound reply is waiting.
  const markers = await ctx.db.select().from(kv).where(and(like(kv.key, "telegram-approval:%"), sql`${kv.value}->>'uid' = ${String(message.from.id)}`, sql`${kv.value} ? 'note_prompt_id'`)).orderBy(kv.updatedAt).limit(100);
  const saved = reply ? markers.find(row => (row.value as NoteMarker).note_prompt_id === reply.message_id)
    : markers.filter(row => !(row.value as NoteMarker).note_done && ((row.value as NoteMarker).note_until ?? 0) > Date.now()).at(-1);
  if (!saved && !recognizable) return false;
  if (!reply && !skip && message.text?.trim().startsWith("/")) return false;
  let text = "This note request has ended. Decide another request to add a reason.";
  try {
    await linkLimit(ctx, "callback", message.from.id, 20);
    if (!saved || !ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegramApprovalNotesEnabled) throw new Error("ended");
    await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const [live] = await tx.select().from(kv).where(eq(kv.key, saved.key));
      const marker = live?.value as NoteMarker | undefined;
      const link = await readLink(tx, message.from!.id);
      if (!marker || marker.note_done || (marker.note_until ?? 0) <= Date.now() || !link || link.generation !== marker.generation) throw new Error("ended");
      const scoped = { ...ctx, db: tx as unknown as Db };
      const caller = await validPrincipal(scoped, link, true);
      const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, marker.approval));
      if (!row || row.decidedBy !== caller.keyHash) throw new Error("ended");
      await ownedKey(scoped, caller, row.keyHash);
      if (!skip) await attachDecisionNote(ctx.db, tx, link.account, row.id, caller.keyHash, message.text ?? "");
      await tx.update(kv).set({ value: { ...marker, note_done: true }, updatedAt: new Date() }).where(eq(kv.key, saved.key));
      text = skip ? "Decision saved without a reason." : "Reason saved. Your agent can read it with this decision.";
    });
  } catch (error) { if (error instanceof ApiError && error.status === 400) text = error.message + " Reply again, or send /skip."; }
  // Replies are interactive approval messages and use the same preferences as the original decision.
  await ctx.db.transaction(async tx => {
    await lockLinks(tx);
    const link = await readLink(tx, message.from!.id);
    if (!link) return;
    const scoped = { ...ctx, db: tx as unknown as Db };
    try {
      const caller = await validPrincipal(scoped, link, true);
      if (!await channelEnabled(scoped, link.account, "approvals", "telegram") || await deferTelegram(scoped, link, link.key_hash, "", "approvals", caller)) return;
      await api.call("sendMessage", { chat_id: link.uid, text }, AbortSignal.timeout(5_000));
    } catch { /* Invalid or muted links receive no follow-up. */ }
  });
  return true;
}
