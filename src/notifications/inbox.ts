import { summaryPeriod } from "../telegram/summary-schedule.ts"; // K188
import { dailySummaryText } from "../telegram/daily-summary-text.ts"; // K188
import { readSummarySections } from "../telegram/weekly-summary-sections.ts"; // J184
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { readPreferences, type NoticeType } from "./prefs.ts";
import { previousIsoWeek, weeklySummaryText } from "../telegram/weekly-summary-text.ts";
import { readWeeklySummary } from "../telegram/weekly-summary-read.ts";
const kinds: Record<string, NoticeType> = { approval_reminder: "approval_reminders", approval: "approvals", alert: "agent_alerts", deposit: "deposits", low_balance: "low_balance", weekly_summary: "weekly_summary", security: "security_alerts", "quiet-agent": "quiet_agents", price_notice: "price_notices", project_budget: "project_budgets", schedule: "scheduled_results" };
kinds.model_watch = "model_watch"; // G159
kinds.status_incidents = "status_incidents"; // H169
export async function filterNotificationInbox<T extends { kind: string }>(ctx: Ctx, account: string, items: T[]) {
  const prefs = await readPreferences(ctx.db, account);
  for (let i = items.length - 1; i >= 0; i--) if (kinds[items[i]!.kind] && !prefs.channels[kinds[items[i]!.kind]!].inbox) items.splice(i, 1);
}
export async function weeklyInbox(ctx: Ctx, key: KeyRow, whole: boolean, since?: string) {
  if (!whole || !key.management || !ctx.cfg.weeklySummaryEnabled || !(await readPreferences(ctx.db, key.accountId)).channels.weekly_summary.inbox) return [];
  const schedule = (await readPreferences(ctx.db, key.accountId)).summary_schedule; // K188
  const week = schedule ? summaryPeriod(new Date(), schedule, true)! : previousIsoWeek(new Date()), at = week.end.toISOString();
  if (since && at <= since) return [];
  const summary = await readWeeklySummary(ctx.db, key, week);
  if (!summary.activity && schedule?.cadence !== "daily") return [];
  const sections = await readSummarySections(ctx, key, week, false, schedule?.cadence === "daily"); // K188
  if (!summary.activity && !sections.length) return []; // K188
  if (summary.topModel) summary.topModel = ctx.catalog.models.get(summary.topModel)?.name ?? summary.topModel;
  return [{ id: `weekly-summary:${week.id}`, kind: "weekly_summary", at, title: (schedule?.cadence === "daily" ? dailySummaryText : weeklySummaryText)(week, summary, ctx.cfg.siteUrl), href: "/dashboard/#activity", status: null, unread: true, ...(sections.length ? { sections } : {}) }];
}
