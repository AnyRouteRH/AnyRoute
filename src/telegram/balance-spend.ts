// E152: read existing account billing through the current Telegram link authority.
import { and, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import { keys } from "../db/schema.ts";
import { readRunway } from "../account/runway.ts";
import { readAgentSpend } from "../agents/spend-glance.ts";
import type { TelegramApi, TgUpdate } from "../services/telegram.ts";
import { lockLinks, readLink, validPrincipal } from "./linking.ts";

export const BALANCE_SPEND_COMMANDS = [
  { command: "balance", description: "Read your linked account balance and spending pace" },
  { command: "spend", description: "Read today and this week's charged agent spend" },
];
export const BALANCE_SPEND_HELP = [
  "/balance  check your linked account balance and spending pace",
  "/spend  check today's spend, this week and your top agents",
];
export const LINK_FIRST = "Link your account from /agents first.";
const unavailable = "Account spending is unavailable. Check your account link from /agents and try again.";
const money = (amount: number) => `$${amount.toFixed(2)}`;
export const utcWeekDays = (now: Date) => (now.getUTCDay() + 6) % 7 + 1;

export function balanceText(runway: Awaited<ReturnType<typeof readRunway>>) {
  const pace = runway.days_left === null ? "no charged spend in the last 7 days"
    : runway.days_left <= 0 ? "lasts less than a day at your 7-day pace"
    : `lasts about ${runway.days_left} ${runway.days_left === 1 ? "day" : "days"} at your 7-day pace`;
  return `Balance: ${money(runway.balance_usd)} · ${pace}`;
}

export async function readTelegramSpend(ctx: Ctx, caller: KeyRow, now = new Date()) {
  // A week begins Monday at 00:00 UTC; use the existing charged-spend reader for those dates.
  const spend = await readAgentSpend(ctx, caller, now, utcWeekDays(now));
  const hashes = spend.data.map(agent => agent.key_hash);
  const names = hashes.length ? await ctx.db.select({ hash: keys.keyHash, name: keys.name, label: keys.label }).from(keys)
    .where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!), inArray(keys.keyHash, hashes))) : [];
  const labels = new Map(names.map(key => [key.hash, (key.name || key.label || "Unnamed agent").replace(/[\r\n\t]+/g, " ").slice(0, 80)]));
  const ranked = spend.data.filter(agent => agent.total_usd > 0).sort((a, b) => b.total_usd - a.total_usd || a.key_hash.localeCompare(b.key_hash));
  return {
    today: spend.data.reduce((sum, agent) => sum + agent.daily.at(-1)!.charged_usd, 0),
    week: spend.data.reduce((sum, agent) => sum + agent.total_usd, 0),
    top: ranked.slice(0, 3).map(agent => ({ name: labels.get(agent.key_hash) ?? "Unnamed agent", amount: agent.total_usd })),
  };
}
export function spendText(spend: Awaited<ReturnType<typeof readTelegramSpend>>) {
  return `Today ${money(spend.today)} · this week ${money(spend.week)} · top agents: ${spend.top.length
    ? spend.top.map(agent => `${agent.name} ${money(agent.amount)}`).join(", ") : "none yet"}`;
}
function sameScope(a: KeyRow, b: KeyRow) {
  return a.accountId === b.accountId && a.keyHash === b.keyHash && a.teamId === b.teamId && a.management === b.management && a.scope === b.scope;
}

export async function handleBalanceSpend(ctx: Ctx, api: TelegramApi, update: TgUpdate): Promise<boolean> {
  if (!ctx.cfg.telegram.linkingEnabled || !ctx.cfg.agentPolicyEnabled) return false;
  const message = update.message;
  const command = /^\/(balance|spend)(?:@\w+)?\s*$/i.exec(message?.text?.trim() ?? "");
  if (!command) return false;
  // Match the link handler's identity guard; never answer account commands in another chat.
  if (!message?.from || message.from.is_bot || message.chat.type !== "private" || message.chat.id !== message.from.id) return true;
  const uid = message.from.id;
  const say = (text: string) => api.call("sendMessage", { chat_id: uid, text, link_preview_options: { is_disabled: true } }, AbortSignal.timeout(5_000));
  try {
    const link = await readLink(ctx.db, uid);
    if (!link) { await say(LINK_FIRST); return true; }
    const caller = await validPrincipal(ctx, link);
    // The dashboard middleware refuses account reads with inference-only keys.
    if (caller.scope === "inference") { await say(unavailable); return true; }
    const text = command[1]!.toLowerCase() === "balance" ? balanceText(await readRunway(ctx, caller))
      : spendText(await readTelegramSpend(ctx, caller));
    // Read outside this transaction: the spend reader opens its own snapshot. Re-check authority
    // under the existing link lock before sending, so an acknowledged unlink stops later replies.
    await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      const live = await readLink(tx, uid);
      if (!live || live.generation !== link.generation) { await say(LINK_FIRST); return; }
      const current = await validPrincipal({ ...ctx, db: tx as unknown as Db }, live);
      await say(sameScope(caller, current) ? text : unavailable);
    });
  } catch { await say(unavailable).catch(() => undefined); }
  return true;
}
