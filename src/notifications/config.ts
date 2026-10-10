import { z } from "zod";
// E146: only delayed outbound delivery needs an autonomous worker switch.
export const notificationsEnv = { NOTIFICATION_QUIET_HOURS_ENABLED: z.union([z.boolean(), z.enum(["true", "false"])]).default(false).transform(v => v === true || v === "true") };
import type { Ctx } from "../context.ts";
import type { NoticeType } from "./prefs.ts";
// Reuse every source sender's service guard when a queued notice leaves the router.
export function noticeFeatureEnabled(ctx: Ctx, type: NoticeType) {
  switch (type) {
    case "approvals": case "agent_alerts": return ctx.cfg.agentPolicyEnabled;
    case "deposits": return ctx.cfg.depositPingsEnabled;
    case "low_balance": return ctx.cfg.lowBalanceAlertsEnabled;
    case "weekly_summary": return ctx.cfg.weeklySummaryEnabled;
    case "security_alerts": return ctx.cfg.securityAlertsEnabled;
    case "quiet_agents": return ctx.cfg.quietAgentAlertsEnabled && ctx.cfg.agentPolicyEnabled;
    case "price_notices": return ctx.cfg.priceNoticesEnabled;
    case "project_budgets": return ctx.cfg.projectBudgetTelegramEnabled;
    case "scheduled_results": return ctx.cfg.scheduledPromptsEnabled;
  }
}
