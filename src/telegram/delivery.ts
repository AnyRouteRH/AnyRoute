import type { KeyRow } from "../api/auth.ts"; // D136
import { plainApprovalText } from "../agents/rulebook-approval-text.ts"; // B124
import { handleGuardResume } from "./guard-resume.ts"; // V98
import { guardApprovalText } from "./guard-text.ts";
import { picoToUsdString } from "../lib/money.ts";
import { policiesFor } from "../agents/store.ts";
import { and, eq, gt, isNull, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { keys, kv } from "../db/schema.ts";
import { ownedKey } from "../api/agents.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { approvalStatus, decideApproval, type ApprovalRow } from "../agents/approvals.ts";
import { ApiError } from "../lib/errors.ts";
import { TelegramApi, type TgUpdate } from "../services/telegram.ts";
import { linkLimit, lockLinks, readLink, validPrincipal, consumeCode, removeLink, pruneLinks, type Link } from "./linking.ts";

export const notificationKey = (id: string, link: Link) => `telegram-approval:${id}:${link.uid}:${link.generation}`;
type Notice = { uid: number; approval: string; generation: string; expires: number; message_id?: number; status: string };
const callbackData = (action: "approve" | "deny", id: string, generation: string) => `tg:${action === "approve" ? "a" : "d"}:${id}:${generation}`;
// These are the approval's existing metadata, never the inference messages or tool arguments.
export function approvalText(row: ApprovalRow, name?: string, policySha256?: string, guardEnabled = false) {
  if (!guardEnabled) return `AnyRoute approval ${row.id}\nIntent: ${JSON.stringify(row.intent).slice(0, 2600)}\nMaximum cost: ${row.maxCostPico} pico-USD\nExpires: ${row.expiresAt.toISOString()}\nStatus: ${approvalStatus(row).status}`; // Preserve existing delivery bytes while off.
  const action = guardApprovalText(row, name, policySha256);
  if (action) return action;
  return `AnyRoute approval ${row.id}\nIntent: ${JSON.stringify(row.intent).slice(0, 2600)}\nMaximum cost: $${picoToUsdString(row.maxCostPico)}\nExpires: ${row.expiresAt.toISOString()}\nStatus: ${approvalStatus(row).status}`;
}
async function noticeText(ctx: Ctx, row: ApprovalRow) {
  const [key] = await ctx.db.select({ name: keys.name }).from(keys).where(eq(keys.keyHash, row.keyHash));
  const policies = await policiesFor(ctx.db, row.keyHash);
  if (ctx.cfg.agentRulebookWordsEnabled) return plainApprovalText(row, policies.map(p => ({ policy: p.spec, inherited: p.keyHash !== row.keyHash })), key?.name ?? undefined); // B124
  return approvalText(row, key?.name ?? undefined, policies[0]?.sha256, ctx.cfg.agentGuardEnabled);
}
async function updateNotice(ctx: Ctx, api: TelegramApi, key: string, notice: Notice, row: ApprovalRow) {
  const status = approvalStatus(row).status;
  if (status === notice.status || !notice.message_id) return;
  await api.call("editMessageText", { chat_id: notice.uid, message_id: notice.message_id, text: await noticeText(ctx, row), reply_markup: { inline_keyboard: [] } }, AbortSignal.timeout(5_000));
  await ctx.db.update(kv).set({ value: { ...notice, status }, updatedAt: new Date() }).where(eq(kv.key, key));
}
/** Delivery holds the link lock until the send ends: an acknowledged unlink stops later sends. */
export async function sendLinkedAlert(ctx: Ctx, link: Link, text: string, keyHash: string, fetchImpl?: typeof fetch, authorize?: (ctx: Ctx, key: KeyRow) => Promise<unknown>) {
  if (!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken) return false;
  return ctx.db.transaction(async tx => {
    await lockLinks(tx);
    const live = await readLink(tx, link.uid);
    if (!live || live.generation !== link.generation) return false;
    try {
      const scoped = { ...ctx, db: tx as unknown as Db };
      if (authorize) await authorize(scoped, await validPrincipal(scoped, live)); // D136: optional audience guard inside the send lock
      await ownedKey(scoped, await validPrincipal(scoped, live), keyHash);
      await new TelegramApi(ctx.cfg.telegram.botToken!, fetchImpl).call("sendMessage", { chat_id: live.uid, text, link_preview_options: { is_disabled: true } }, AbortSignal.timeout(5_000));
      return true;
    } catch { return false; }
  });
}
export async function linkedAlertTargets(ctx: Ctx, account: string, keyHash: string, text: string, fetchImpl?: typeof fetch, authorize?: (ctx: Ctx, key: KeyRow) => Promise<unknown>) {
  if (!ctx.cfg.telegram.linkingEnabled) return [];
  const rows = await ctx.db.select().from(kv).where(and(like(kv.key, "telegram-link:%"), sql`${kv.value}->>'account' = ${account}`)).limit(20);
  const targets = [];
  for (const row of rows) {
    const link = row.value as Link;
    try {
      await ownedKey(ctx, await validPrincipal(ctx, link), keyHash);
      targets.push({ id: `telegram:${link.uid}`, send: () => sendLinkedAlert(ctx, link, text, keyHash, fetchImpl, authorize) });
    } catch { /* Role and team scope match the dashboard. */ }
  }
  return targets;
}
/** Called by the existing Telegram polling job. Claim before sending avoids duplicate buttons across workers. */
export async function deliverTelegramApprovals(ctx: Ctx, api: TelegramApi) {
  if (!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.agentPolicyEnabled) return;
  const links = await ctx.db.select().from(kv).where(like(kv.key, "telegram-link:%"));
  for (const saved of links) await ctx.db.transaction(async tx => {
    await lockLinks(tx);
    const link = await readLink(tx, (saved.value as Link).uid);
    if (!link) return;
    const scoped = { ...ctx, db: tx as unknown as Db };
    let caller;
    try { caller = await validPrincipal(scoped, link); } catch { return; }
    const notices = await tx.select().from(kv).where(and(like(kv.key, "telegram-approval:%"), sql`${kv.value}->>'uid' = ${String(link.uid)}`, sql`${kv.value}->>'generation' = ${link.generation}`, sql`${kv.value}->>'status' = 'pending'`)).limit(100);
    for (const stored of notices) {
      const notice = stored.value as Notice;
      const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, notice.approval));
      if (row) await updateNotice(scoped, api, stored.key, notice, row).catch(() => undefined);
    }
    const pending = await tx.select({ row: agentApprovals }).from(agentApprovals).innerJoin(keys, eq(keys.keyHash, agentApprovals.keyHash)).leftJoin(kv, sql`${kv.key} = 'telegram-approval:' || ${agentApprovals.id} || ':' || ${String(link.uid)} || ':' || ${link.generation}`).where(and(eq(keys.accountId, link.account), caller.management ? undefined : eq(keys.teamId, caller.teamId!), eq(agentApprovals.status, "pending"), gt(agentApprovals.expiresAt, new Date()), isNull(kv.key))).orderBy(agentApprovals.requestedAt).limit(10);
    for (const { row } of pending) {
      const key = notificationKey(row.id, link);
      const notice: Notice = { uid: link.uid, approval: row.id, generation: link.generation, expires: row.expiresAt.getTime(), status: "pending" };
      await tx.insert(kv).values({ key, value: notice });
      try {
        const sent = await api.call<{ message_id: number }>("sendMessage", { chat_id: link.uid, text: await noticeText(scoped, row), reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: callbackData("approve", row.id, link.generation) }, { text: "Deny", callback_data: callbackData("deny", row.id, link.generation) }]] } }, AbortSignal.timeout(5_000));
        await tx.update(kv).set({ value: { ...notice, message_id: sent.message_id } }).where(eq(kv.key, key));
      } catch { await tx.delete(kv).where(eq(kv.key, key)); }
    }
  });
  await pruneLinks(ctx.db);
}
export async function handleLinkedUpdate(ctx: Ctx, api: TelegramApi, update: TgUpdate): Promise<boolean> {
  if (!ctx.cfg.telegram.linkingEnabled) return false;
  if (await handleGuardResume(ctx, api, update)) return true; // V98
  const callback = update.callback_query;
  if (callback) {
    let outcome = "Approval unavailable.";
    try {
      const match = /^tg:([ad]):([A-Za-z0-9_-]{24}):([A-Za-z0-9_-]{12})$/.exec(callback.data ?? "");
      if (!match || callback.from.is_bot || callback.message?.chat.type !== "private" || callback.message.chat.id !== callback.from.id) throw new Error("invalid");
      await linkLimit(ctx, "callback", callback.from.id, 20);
      await ctx.db.transaction(async tx => {
        await lockLinks(tx);
        const link = await readLink(tx, callback.from.id);
        if (!link || link.generation !== match[3]) throw new Error("unlinked");
        const scoped = { ...ctx, db: tx as unknown as Db };
        const caller = await validPrincipal(scoped, link);
        const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, match[2]));
        if (!row) throw new Error("unavailable");
        await ownedKey(scoped, caller, row.keyHash);
        const key = notificationKey(row.id, link);
        const [saved] = await tx.select().from(kv).where(eq(kv.key, key));
        const notice = saved?.value as Notice | undefined;
        if (!notice || notice.message_id !== callback.message!.message_id) throw new Error("invalid");
        // Exact same atomic decision and event recording as the dashboard. Intent consumption is unchanged.
        const decided = await decideApproval(ctx.db, caller.accountId, row.id, caller.keyHash, match[1] === "a" ? "approve" : "deny", tx);
        outcome = `Approval ${decided.status}.`;
        await updateNotice(scoped, api, key, notice, decided).catch(() => undefined);
      });
    } catch (error) { if (error instanceof ApiError && error.status === 409) outcome = "Approval is no longer pending."; }
    await api.call("answerCallbackQuery", { callback_query_id: callback.id, text: outcome }).catch(() => undefined);
    return true;
  }
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type !== "private" || message.chat.id !== message.from.id) return false;
  const command = /^\/(link|unlink)(?:@\w+)?(?:\s+(.*))?$/i.exec(message.text?.trim() ?? "");
  if (!command) return false;
  let text: string;
  try {
    if (command[1].toLowerCase() === "unlink") {
      await removeLink(ctx, message.from.id);
      text = "Telegram account link removed. Agent approvals and alerts through this link have stopped. Your chat key, if connected, is separate; /forget removes it.";
    } else {
      await api.call("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }).catch(() => undefined);
      await consumeCode(ctx, message.from.id, command[2] ?? "");
      text = "Telegram linked for agent approvals and alerts. No API key was sent to Telegram. Use /unlink to remove the link. Chatting still needs a separate chat key.";
    }
  } catch (error) { text = error instanceof ApiError ? error.message : "Telegram linking is unavailable. Try again shortly."; }
  await api.call("sendMessage", { chat_id: message.chat.id, text }).catch(() => undefined);
  return true;
}
