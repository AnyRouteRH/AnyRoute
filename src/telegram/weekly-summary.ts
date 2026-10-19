import { summaryPeriod, summaryClaimed, claimSummary } from "./summary-schedule.ts"; // K188
import { dailySummaryText } from "./daily-summary-text.ts"; // K188
import { readPreferences } from "../notifications/prefs.ts"; // K188
import { readSummarySections } from "./weekly-summary-sections.ts"; // J184
import { and, asc, eq, like } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { accounts, kv } from "../db/schema.ts";
import { sendLinkedAlert } from "./delivery.ts";
import { linkLimit, lockLinks, readLink, validPrincipal, type Link } from "./linking.ts";
import { RATE_PER_MINUTE } from "../services/telegram.ts";
import { readWeeklySummary } from "./weekly-summary-read.ts";
import { weeklySummaryText } from "./weekly-summary-text.ts";

export function registerWeeklySummaryJob(ctx: Ctx) {
  if (ctx.cfg.weeklySummaryEnabled && ctx.cfg.telegram.linkingEnabled && ctx.cfg.telegram.botToken)
    ctx.jobs.register("weekly-summary", 3_600_000, () => runWeeklySummaries(ctx));
}
export async function runWeeklySummaries(ctx: Ctx, opts: { now?: Date; telegramFetch?: typeof fetch } = {}) {
  if (!ctx.cfg.weeklySummaryEnabled || !ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken) return { sent: 0, skipped: "disabled" };
  const now = opts.now ?? new Date();
  const candidates = await ctx.db.select().from(kv).where(and(like(kv.key, "telegram-link:%"), eq(kv.weeklySummaryOptedIn, true))).orderBy(asc(kv.key));
  if (candidates.length) await ctx.catalog.ensureFresh(); // J184: outside the single-connection transaction.
  const visited = new Set<string>();
  let sent = 0, due = false; // K188
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
      const week = summaryPeriod(now, (await readPreferences(tx, live.account)).summary_schedule); // K188
      if (!week) return "outside_window";
      due = true;
      if (!account || summaryClaimed(account.lastSentWeek, week)) return "done";
      const scoped = { ...ctx, db: tx as unknown as Db };
      let caller;
      try { caller = await validPrincipal(scoped, live); } catch { return "ineligible"; }
      const summary = await readWeeklySummary(scoped.db, caller, week);
      if (!summary.activity && week.cadence !== "daily") return "empty";
      summary.sections = await readSummarySections(scoped, caller, week, true, week.cadence === "daily"); // K188
      if (!summary.activity && !summary.sections.length) return "empty"; // K188
      if (summary.topModel) summary.topModel = ctx.catalog.models.get(summary.topModel)?.name ?? summary.topModel;
      // Reuse the Telegram link limiter and its counter family. No message or key name enters Redis.
      try { await linkLimit(ctx, "summary", live.uid, RATE_PER_MINUTE); } catch { return "limited"; }
      if (!await sendLinkedAlert(scoped, live, (week.cadence === "daily" ? dailySummaryText : weeklySummaryText)(week, summary, ctx.cfg.siteUrl), live.key_hash, opts.telegramFetch, undefined, "weekly_summary")) return "failed"; // E146
      await tx.update(accounts).set({ lastSentWeek: claimSummary(account.lastSentWeek, week) }).where(eq(accounts.id, live.account));
      return "sent";
    });
    if (outcome === "sent") sent++;
    if (outcome !== "ineligible" && outcome !== "empty") visited.add(saved.account);
  }
  return due ? { sent } : { sent, skipped: "outside_window" }; // K188
}
