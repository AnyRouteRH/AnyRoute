import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { keys } from "../db/schema.ts";
import { projectBudgetNotices } from "../db/project-budgets.ts";
import { picoToUsdString } from "../lib/money.ts";
import { accountLinks, validPrincipal } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";
export const projectBudgetTitle = (row: { name: string; spent: bigint; budget: bigint }) =>
  `Project '${row.name}' has used $${picoToUsdString(row.spent)} of its $${picoToUsdString(row.budget)} monthly budget (80% reached).`;
export async function projectBudgetInbox(ctx: Ctx, accountId: string, asOf: string, since?: string) {
  const rows = await ctx.db.select().from(projectBudgetNotices).where(and(eq(projectBudgetNotices.accountId, accountId), lte(projectBudgetNotices.at, new Date(asOf)), since ? gt(projectBudgetNotices.at, new Date(since)) : undefined)).orderBy(desc(projectBudgetNotices.at)).limit(101);
  return rows.map(row => ({ id: `project-budget:${row.name}:${row.month}`, at: row.at.toISOString(), kind: "project_budget", title: projectBudgetTitle(row), status: null, href: "/dashboard/#insights", unread: true }));
}
export function registerProjectBudgetTelegramJob(ctx: Ctx) {
  if (ctx.cfg.projectBudgetTelegramEnabled && ctx.cfg.runtimeRole !== "api") ctx.jobs.register("project-budget-telegram", 60_000, () => deliverProjectBudgetTelegram(ctx));
}
export async function deliverProjectBudgetTelegram(ctx: Ctx, telegramFetch?: typeof fetch) {
  if (!ctx.cfg.projectBudgetTelegramEnabled || !ctx.cfg.telegram.linkingEnabled || !ctx.cfg.telegram.botToken || ctx.cfg.runtimeRole === "api") return { claimed: 0, skipped: true };
  // At most one outbound attempt per notice. Claim commits first; crashes/failures are not retried.
  const rows = await ctx.db.transaction(async tx => {
    const pending = await tx.select().from(projectBudgetNotices).where(eq(projectBudgetNotices.telegramClaimed, false)).orderBy(asc(projectBudgetNotices.at)).limit(100).for("update", { skipLocked: true });
    for (const row of pending) await tx.update(projectBudgetNotices).set({ telegramClaimed: true }).where(and(eq(projectBudgetNotices.accountId, row.accountId), eq(projectBudgetNotices.name, row.name), eq(projectBudgetNotices.month, row.month)));
    return pending;
  });
  for (const row of rows) for (const link of await accountLinks(ctx.db, row.accountId)) {
    try {
      await ctx.db.transaction(async tx => {
        await tx.select({ hash: keys.keyHash }).from(keys).where(eq(keys.keyHash, link.key_hash)).for("share");
        const scoped = { ...ctx, db: tx as unknown as Db };
        if (!(await validPrincipal(scoped, link)).management) return;
        await sendLinkedAlert(scoped, link, projectBudgetTitle(row) + "\nhttps://anyroute.tech/dashboard/#insights", link.key_hash, telegramFetch, undefined, "project_budgets"); // E146
      });
    } catch { /* Revoked links and failed sends receive no retry. */ }
  }
  return { claimed: rows.length, skipped: false };
}
