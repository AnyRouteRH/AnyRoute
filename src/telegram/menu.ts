// J179: one menu delegates to the existing command and approval handlers.
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import type { TelegramApi, TgUpdate } from "../services/telegram.ts";
import { handleBalanceSpend } from "./balance-spend.ts";
import { handleAgentStop } from "./agent-stop.ts";
import { handleAgentStopAll } from "./agent-stop-all.ts";
import { deliverTelegramApprovals, linkHowTo } from "./delivery.ts";
import { linkLimit, lockLinks, readLink, validPrincipal } from "./linking.ts";
import { bindMenuCommand, STALE_MENU } from "./menu-command.ts";

const actions = ["balance", "spend", "agents", "stopall", "approvals"] as const;
export const menuCallback = (action: typeof actions[number], generation: string) => `tgm:${action}:${generation}`;
export function menuButtons(siteUrl: string, generation: string) {
  const button = (text: string, action: typeof actions[number]) => ({ text, callback_data: menuCallback(action, generation) });
  return [
    [button("Balance", "balance"), button("Spend", "spend")],
    [button("Agents", "agents"), button("Stop all", "stopall")],
    [button("Waiting approvals", "approvals")],
    [{ text: "Inbox", url: `${siteUrl}/dashboard/#inbox` }, { text: "Settings", url: `${siteUrl}/dashboard/#notifications` }],
  ];
}
export async function handleTelegramMenu(ctx: Ctx, api: TelegramApi, update: TgUpdate): Promise<boolean> {
  if (!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.agentPolicyEnabled) return false;
  const callback = update.callback_query;
  if (callback ? !callback.data?.startsWith("tgm:") : !/^\/menu(?:@\w+)?\s*$/i.test(update.message?.text?.trim() ?? "")) return false;
  const message = callback?.message ?? update.message, from = callback?.from ?? message?.from;
  if (!message || !from || from.is_bot || message.chat.type !== "private" || message.chat.id !== from.id) return true;
  const uid = from.id;
  const say = (text: string, keyboard?: ReturnType<typeof menuButtons>) => api.call("sendMessage", {
    chat_id: uid, text, link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }, AbortSignal.timeout(5_000));
  let outcome = "Menu opened.";
  try {
    if (!callback) {
      await linkLimit(ctx, "callback", uid, 20);
      await ctx.db.transaction(async tx => {
        await lockLinks(tx);
        const link = await readLink(tx, uid);
        if (!link) { await say(linkHowTo(ctx)); return; }
        // Delegated approvers can open the menu, but each command retains its own stricter authority.
        await validPrincipal({ ...ctx, db: tx as unknown as Db }, link, true);
        await say("Choose what to do. Stop all stops your agents until you resume them.", menuButtons(ctx.cfg.siteUrl, link.generation));
      });
    } else {
      const match = /^tgm:(balance|spend|agents|stopall|approvals):([A-Za-z0-9_-]{12})$/.exec(callback.data ?? "");
      if (!match) outcome = STALE_MENU;
      else if (match[1] === "approvals") {
        const sent = await deliverTelegramApprovals(ctx, api, { uid, generation: match[2]! });
        outcome = sent ? "Waiting approvals shown." : "No waiting approvals were sent. Check your permissions and approval notifications in Settings.";
      } else {
        // No outer transaction: spend opens its own snapshot. Each handler checks this generation
        // at its authoritative link read and rechecks before replying or committing a change.
        const command = bindMenuCommand({ update_id: update.update_id, message: { ...message, from, text: `/${match[1]}` } }, match[2]!);
        if (match[1] === "balance" || match[1] === "spend") {
          await linkLimit(ctx, "callback", uid, 20);
          await handleBalanceSpend(ctx, api, command);
        }
        else if (match[1] === "agents") await handleAgentStop(ctx, api, command);
        else await handleAgentStopAll(ctx, api, command);
        outcome = "Request handled.";
      }
    }
  } catch (error) {
    outcome = error instanceof Error && error.message === STALE_MENU ? STALE_MENU : "Menu unavailable. Check your account link and permissions from Agents.";
    if (!callback) await say(outcome).catch(() => undefined);
  }
  if (callback) await api.call("answerCallbackQuery", { callback_query_id: callback.id, text: outcome }, AbortSignal.timeout(5_000)).catch(() => undefined);
  return true;
}
