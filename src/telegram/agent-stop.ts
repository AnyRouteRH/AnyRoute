// G163: linked commands reuse the web Stop state, event chain and security context.
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { ownedKey } from "../api/agents.ts";
import { keys } from "../db/schema.ts";
import { agentPolicies } from "../agents/schema.ts";
import { changeKill, lockAccount, policiesFor } from "../agents/store.ts";
import { visibleStop } from "../agents/stop-until.ts";
import { securityContext } from "../security-alerts/records.ts";
import type { TelegramApi, TgUpdate } from "../services/telegram.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { linkLimit, lockLinks, readLink, validPrincipal, type Link } from "./linking.ts";
import { BALANCE_SPEND_COMMANDS, LINK_FIRST } from "./balance-spend.ts";

export const AGENT_STOP_HELP = [
  "/agents  list your agents with Stop and Resume buttons",
  "/stop <agent> [1h|tomorrow|resume-only]  stop an agent; tomorrow means 09:00 UTC",
  "/start <agent>  resume an agent",
];
type Action = "h" | "t" | "s" | "r";
const nameOf = (key: { name: string | null; label: string }) => (key.name || key.label || "Unnamed agent").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 60) || "Unnamed agent";
const unavailable = "Agent controls are unavailable. Check your account link and permissions from Agents.";
export function telegramStopUntil(preset: string, now = new Date()): Date | null {
  if (preset === "resume-only") return null;
  if (preset === "1h") return new Date(now.getTime() + 3_600_000);
  if (preset === "tomorrow") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9));
  fail(400, "Choose 1h, tomorrow or resume-only.");
}
// A full key digest encoded as base64url fits Telegram's 64-byte callback limit with the link generation.
export const agentStopCallback = (action: Action, hash: string, generation: string) => `tgs:${action}:${Buffer.from(hash, "hex").toString("base64url")}:${generation}`;
function buttons(key: { keyHash: string }, link: Link) {
  return [
    { text: "Stop 1 hour", callback_data: agentStopCallback("h", key.keyHash, link.generation) },
    { text: "Stop until tomorrow", callback_data: agentStopCallback("t", key.keyHash, link.generation) },
    { text: "Stop until resumed", callback_data: agentStopCallback("s", key.keyHash, link.generation) },
    { text: "Resume", callback_data: agentStopCallback("r", key.keyHash, link.generation) },
  ];
}
export async function registerAgentStopCommands(api: TelegramApi, base: { command: string; description: string }[]) {
  await api.call("setMyCommands", { commands: [
    ...base.map(command => command.command === "start" ? { ...command, description: "Connect, or resume with /start followed by an agent name" } : command),
    ...BALANCE_SPEND_COMMANDS,
    { command: "link", description: "Link agent approvals and alerts" },
    { command: "unlink", description: "Remove the account link" },
    { command: "agents", description: "List your agents with Stop and Resume buttons" },
    { command: "stop", description: "Stop an agent for an hour, until tomorrow or until resumed" },
  ] }).catch(() => undefined);
}
/** No new background work or saved button state. Resolve current account/team authority on every update. */
export async function handleAgentStop(ctx: Ctx, api: TelegramApi, update: TgUpdate): Promise<boolean> {
  if (!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.agentPolicyEnabled) return false;
  const callback = update.callback_query;
  const callbackMatch = /^tgs:([htrs]):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{12})$/.exec(callback?.data ?? "");
  const command = /^\/(agents|stop|start)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(update.message?.text?.trim() ?? "");
  if (callback ? !callback.data?.startsWith("tgs:") : !command || (command[1]!.toLowerCase() === "start" && !command[2]?.trim())) return false;
  const message = callback?.message ?? update.message;
  const from = callback?.from ?? message?.from;
  if (!message || !from || from.is_bot || message.chat.type !== "private" || message.chat.id !== from.id) return true;
  const uid = from.id;
  const say = (text: string, keyboard?: { text: string; callback_data: string }[][]) => api.call("sendMessage", {
    chat_id: uid, text, link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }, AbortSignal.timeout(5_000));
  let outcome = "Choose an agent from /agents again.";
  let confirmation: { link: Link; keyHash: string } | undefined;
  try {
    await linkLimit(ctx, "callback", uid, 20);
    await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const link = await readLink(tx, uid);
      if (!link) { outcome = LINK_FIRST; if (!callback) await say(outcome); return; }
      if (callback && (!callbackMatch || link.generation !== callbackMatch[3])) fail(403, "Choose an agent from /agents again.");
      const scoped = { ...ctx, db: tx as unknown as Db };
      const caller = await validPrincipal(scoped, link);
      if (caller.scope === "read" || caller.scope === "inference") fail(403, unavailable);
      await lockAccount(tx, caller.accountId);
      const visible = await tx.select().from(keys).where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!))).orderBy(keys.keyHash);
      const now = new Date();
      if (!callback && command![1]!.toLowerCase() === "agents") {
        if (command![2]?.trim()) { await say("Send /agents to list your agents."); return; }
        if (!visible.length) { await say("No agents are visible to this linked key."); return; }
        // One reply per agent keeps text and keyboard within Telegram's size limits, even with many keys.
        for (const [index, key] of visible.entries()) {
          const policies = (await policiesFor(tx, key.keyHash)).map(row => visibleStop(row, now));
          const stopped = policies.filter(row => row.killed);
          const status = stopped.length ? stopped.some(row => !row.killUntil) ? "Stopped until resumed"
            : `Stopped until ${new Date(Math.max(...stopped.map(row => row.killUntil!.getTime()))).toISOString().slice(0, 16).replace("T", " ")} UTC`
            : "Running";
          await say(`${index + 1}. ${nameOf(key)} · ${status}${policies.some(row => row.keyHash === key.keyHash) ? "" : " · Set a rulebook in Agents to use Stop"}`, [buttons(key, link).slice(0, 2), buttons(key, link).slice(2)]);
        }
        return;
      }
      let action: Action, matches: typeof visible;
      if (callback) {
        action = callbackMatch![1] as Action;
        const hash = Buffer.from(callbackMatch![2]!, "base64url").toString("hex");
        matches = visible.filter(key => key.keyHash === hash);
      } else {
        const arg = command![2]?.trim() ?? "";
        if (!arg) { await say("Send /stop followed by an agent name and 1h, tomorrow or resume-only. Send /agents to see names."); return; }
        const isStart = command![1]!.toLowerCase() === "start";
        const preset = !isStart ? /\s+(1h|tomorrow|resume-only)$/i.exec(arg) : null;
        const query = (preset ? arg.slice(0, preset.index) : arg).trim().toLowerCase();
        action = isStart ? "r" : preset?.[1]!.toLowerCase() === "1h" ? "h" : preset?.[1]!.toLowerCase() === "tomorrow" ? "t" : "s";
        const exact = visible.filter(key => nameOf(key).toLowerCase() === query || key.keyHash === query);
        matches = exact.length ? exact : visible.filter(key => nameOf(key).toLowerCase().includes(query));
      }
      if (!matches.length) fail(404, "No matching agent is visible. Send /agents to see your agents.");
      if (matches.length > 1) {
        // Never select a first match silently; the action and exact digest travel with each choice.
        for (let offset = 0; offset < matches.length; offset += 10) await say("More than one agent matches. Choose an agent:", matches.slice(offset, offset + 10).map(key => [{
          text: `${visible.findIndex(row => row.keyHash === key.keyHash) + 1}. ${nameOf(key)}`, callback_data: agentStopCallback(action, key.keyHash, link.generation),
        }]));
        return;
      }
      const key = await ownedKey(scoped, caller, matches[0]!.keyHash);
      const [policy] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, key.keyHash));
      if (!policy) fail(404, "Set a rulebook for this agent in Agents before using Stop or Resume.");
      const until = telegramStopUntil(action === "h" ? "1h" : action === "t" ? "tomorrow" : "resume-only", now);
      await securityContext.run(scoped, () => changeKill(tx, policy, action !== "r", null, caller.keyHash, until));
      outcome = action === "r" ? `Resumed ${nameOf(key)}. Its rulebook limits still apply.`
        : `Stopped ${nameOf(key)} ${action === "t" ? "until 09:00 tomorrow UTC" : until ? `for 1 hour, until ${until.toISOString().slice(11, 16)} UTC` : "until you resume"}.`;
      if (!callback) confirmation = { link, keyHash: key.keyHash };
    });
    // Commit Stop before replying. A failed Telegram send must not undo the owner's action.
    if (confirmation) await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const live = await readLink(tx, uid);
      if (!live || live.generation !== confirmation!.link.generation) return;
      const scoped = { ...ctx, db: tx as unknown as Db };
      const caller = await validPrincipal(scoped, live);
      if (caller.scope === "read" || caller.scope === "inference") return;
      await ownedKey(scoped, caller, confirmation!.keyHash);
      await say(outcome);
    }).catch(() => undefined);
  } catch (error) {
    outcome = error instanceof ApiError && error.status !== 403 ? error.message : unavailable;
    if (!callback) await say(outcome).catch(() => undefined);
  }
  if (callback) await api.call("answerCallbackQuery", { callback_query_id: callback.id, text: outcome }, AbortSignal.timeout(5_000)).catch(() => undefined);
  return true;
}
