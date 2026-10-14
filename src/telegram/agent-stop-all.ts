// H172: linked private commands, current authority, existing limiter and link lock.
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import type { TelegramApi, TgUpdate } from "../services/telegram.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { linkLimit, lockLinks, readLink, validPrincipal, type Link } from "./linking.ts";
import { LINK_FIRST } from "./balance-spend.ts";
import { telegramStopUntil } from "./agent-stop.ts";
import { changeAllStops } from "../agents/stop-all.ts";

export const AGENT_STOP_ALL_HELP = [
  "/stopall [1h|tomorrow|resume-only]  stop all your agents; tomorrow means 09:00 UTC",
  "/startall  resume all your stopped agents",
];
export const AGENT_STOP_ALL_COMMANDS = [
  { command: "stopall", description: "Stop all your agents" },
  { command: "startall", description: "Resume all your stopped agents" },
];
export async function handleAgentStopAll(ctx: Ctx, api: TelegramApi, update: TgUpdate): Promise<boolean> {
  if (!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.agentPolicyEnabled) return false;
  const command = /^\/(stopall|startall)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(update.message?.text?.trim() ?? "");
  if (!command) return false;
  const message = update.message!, from = message.from;
  if (!from || from.is_bot || message.chat.type !== "private" || message.chat.id !== from.id) return true;
  const uid = from.id;
  const say = (text: string) => api.call("sendMessage", { chat_id: uid, text, link_preview_options: { is_disabled: true } }, AbortSignal.timeout(5_000));
  const unavailable = "Agent controls are unavailable. Check your account link and permissions from Agents.";
  let confirmation: { link: Link; text: string } | undefined;
  try {
    await linkLimit(ctx, "callback", uid, 20);
    await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const link = await readLink(tx, uid);
      if (!link) { await say(LINK_FIRST); return; }
      const scoped = { ...ctx, db: tx as unknown as Db };
      const caller = await validPrincipal(scoped, link);
      if (caller.scope === "read" || caller.scope === "inference") fail(403, unavailable);
      const stopped = command[1]!.toLowerCase() === "stopall", arg = command[2]?.trim().toLowerCase() ?? "";
      if (!stopped && arg) fail(400, "Send /startall to resume all your stopped agents.");
      const preset = arg || "resume-only";
      const until = stopped ? telegramStopUntil(preset) : null;
      const result = await changeAllStops(ctx, tx, caller, stopped, null, until);
      confirmation = { link, text: `${result.message}${stopped ? preset === "tomorrow" ? " until 09:00 tomorrow UTC" : until ? " for 1 hour" : " until you resume" : ". Their rulebook limits still apply"}.` };
    });
    // Commit first; failed delivery cannot roll back Stop. Recheck link before sending.
    if (confirmation) await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const live = await readLink(tx, uid);
      if (!live || live.generation !== confirmation!.link.generation) return;
      const caller = await validPrincipal({ ...ctx, db: tx as unknown as Db }, live);
      if (caller.scope === "read" || caller.scope === "inference") return;
      await say(confirmation!.text);
    }).catch(() => undefined);
  } catch (error) {
    await say(error instanceof ApiError && error.status !== 403 ? error.message : unavailable).catch(() => undefined);
  }
  return true;
}
