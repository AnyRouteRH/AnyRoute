import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { readPreferences, type NoticeType } from "./prefs.ts";
import { previousIsoWeek, weeklySummaryText } from "../telegram/weekly-summary-text.ts";
import { readWeeklySummary } from "../telegram/weekly-summary-read.ts";
const kinds: Record<string, NoticeType> = { approval: "approvals", alert: "agent_alerts", deposit: "deposits", low_balance: "low_balance", weekly_summary: "weekly_summary", security: "security_alerts", "quiet-agent": "quiet_agents", price_notice: "price_notices", project_budget: "project_budgets", schedule: "scheduled_results" };
export async function filterNotificationInbox<T extends { kind: string }>(ctx: Ctx, account: string, items: T[]) {
  const prefs = await readPreferences(ctx.db, account);
  for (let i = items.length - 1; i >= 0; i--) if (kinds[items[i]!.kind] && !prefs.channels[kinds[items[i]!.kind]!].inbox) items.splice(i, 1);
}
export async function weeklyInbox(ctx: Ctx, key: KeyRow, whole: boolean, since?: string) {
  if (!whole || !key.management || !ctx.cfg.weeklySummaryEnabled || !(await readPreferences(ctx.db, key.accountId)).channels.weekly_summary.inbox) return [];
  const week = previousIsoWeek(new Date()), at = week.end.toISOString();
  if (since && at <= since) return [];
  const summary = await readWeeklySummary(ctx.db, key, week);
  if (!summary.activity) return [];
  if (summary.topModel) summary.topModel = ctx.catalog.models.get(summary.topModel)?.name ?? summary.topModel;
  return [{ id: `weekly-summary:${week.id}`, kind: "weekly_summary", at, title: weeklySummaryText(week, summary, ctx.cfg.siteUrl), href: "/dashboard/#activity", status: null, unread: true }];
}
