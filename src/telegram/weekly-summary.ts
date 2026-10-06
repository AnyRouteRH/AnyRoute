import { and, asc, eq, like } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { accounts, kv } from "../db/schema.ts";
import { sendLinkedAlert } from "./delivery.ts";
import { linkLimit, lockLinks, readLink, validPrincipal, type Link } from "./linking.ts";
import { RATE_PER_MINUTE } from "../services/telegram.ts";
import { readWeeklySummary } from "./weekly-summary-read.ts";
import { previousIsoWeek, summaryDue, weeklySummaryText } from "./weekly-summary-text.ts";

export function registerWeeklySummaryJob(ctx: Ctx) {
  if (ctx.cfg.weeklySummaryEnabled && ctx.cfg.telegram.linkingEnabled && ctx.cfg.telegram.botToken)
    ctx.jobs.register("weekly-summary", 3_600_000, () => runWeeklySummaries(ctx));
}
export async function runWeeklySummaries(ctx: Ctx, opts: { now?: Date; telegramFetch?: typeof fetch } = {}) {
  if (!ctx.cfg.weeklySummaryEnabled || !ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken) return { sent: 0, skipped: "disabled" };
  const now = opts.now ?? new Date();
  if (!summaryDue(now)) return { sent: 0, skipped: "outside_window" };
  const week = previousIsoWeek(now);
  const candidates = await ctx.db.select().from(kv).where(and(like(kv.key, "telegram-link:%"), eq(kv.weeklySummaryOptedIn, true))).orderBy(asc(kv.key));
  const visited = new Set<string>();
  let sent = 0;
  for (const candidate of candidates) {
    const saved = candidate.value as Link;
    if (visited.has(saved.account)) continue;
    const outcome = await ctx.db.transaction(async tx => {
      // Same lock as unlink, preference writes, approvals and the shared delivery helper.
      await lockLinks(tx);
      const live = await readLink(tx, saved.uid);
      const [preference] = await tx.select().from(kv).where(eq(kv.key, candidate.key));
      if (!live || live.generation !== saved.generation || !preference?.weeklySummaryOptedIn) return "ineligible";
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, live.account));
      if (!account || account.lastSentWeek === week.id) return "done";
      const scoped = { ...ctx, db: tx as unknown as Db };
      let caller;
      try { caller = await validPrincipal(scoped, live); } catch { return "ineligible"; }
      const summary = await readWeeklySummary(scoped.db, caller, week);
      if (!summary.activity) return "empty";
      if (summary.topModel) summary.topModel = ctx.catalog.models.get(summary.topModel)?.name ?? summary.topModel;
      // Reuse the Telegram link limiter and its counter family. No message or key name enters Redis.
      try { await linkLimit(ctx, "summary", live.uid, RATE_PER_MINUTE); } catch { return "limited"; }
      if (!await sendLinkedAlert(scoped, live, weeklySummaryText(week, summary, ctx.cfg.siteUrl), live.key_hash, opts.telegramFetch)) return "failed";
      await tx.update(accounts).set({ lastSentWeek: week.id }).where(eq(accounts.id, live.account));
      return "sent";
    });
    if (outcome === "sent") sent++;
    if (outcome !== "ineligible" && outcome !== "empty") visited.add(saved.account);
  }
  return { sent };
}
