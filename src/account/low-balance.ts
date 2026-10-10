import { and, desc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { accounts } from "../db/schema.ts";
import { lowBalanceAlerts } from "../db/low-balance.ts";
import { picoToUsdString } from "../lib/money.ts";
import { uid } from "../lib/util.ts";
import { accountLinks } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";

export const lowBalanceText = (balance: bigint, threshold: bigint, site: string) =>
  `Your Anyroute balance is $${(Number(picoToUsdString(balance))).toFixed(2)}, below your $${picoToUsdString(threshold)} alert. Add funds: ${site}/dashboard/#payments`;
export function crossing(balance: bigint, threshold: bigint | null, alerted: boolean) {
  if (threshold === null) return "disabled";
  if (balance > threshold) return "rearm";
  return balance < threshold && !alerted ? "alert" : "unchanged";
}
export function registerLowBalanceJob(ctx: Ctx) {
  if (ctx.cfg.lowBalanceAlertsEnabled) ctx.jobs.register("low-balance-alerts", 300_000, () => runLowBalanceAlerts(ctx));
}
export async function runLowBalanceAlerts(ctx: Ctx, fetchImpl?: typeof fetch) {
  if (!ctx.cfg.lowBalanceAlertsEnabled) return { skipped: true };
  const candidates = await ctx.db.select({ id: accounts.id }).from(accounts).where(and(isNotNull(accounts.lowBalancePico), sql`(${accounts.balance} < ${accounts.lowBalancePico} and not ${accounts.lowBalanceAlerted}) or (${accounts.balance} > ${accounts.lowBalancePico} and ${accounts.lowBalanceAlerted})`));
  let alerted = 0, rearmed = 0;
  for (const candidate of candidates) {
    // Balance updates and setting edits use this same account row lock. Concurrent workers cannot claim a crossing twice.
    const notice = await ctx.db.transaction(async tx => {
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, candidate.id)).for("update");
      const state = crossing(account.balance, account.lowBalancePico, account.lowBalanceAlerted);
      if (state === "rearm") { await tx.update(accounts).set({ lowBalanceAlerted: false }).where(eq(accounts.id, account.id)); rearmed++; }
      if (state !== "alert") return null;
      const [item] = await tx.insert(lowBalanceAlerts).values({ id: uid("lb_"), accountId: account.id, balance: account.balance, threshold: account.lowBalancePico! }).returning();
      await tx.update(accounts).set({ lowBalanceAlerted: true }).where(eq(accounts.id, account.id));
      return item;
    });
    if (!notice) continue;
    alerted++;
    // Inbox and claim are durable before the outbound attempt. No retries: a timeout may already have delivered the message.
    for (const link of await accountLinks(ctx.db, notice.accountId)) await sendLinkedAlert(ctx, link, lowBalanceText(notice.balance, notice.threshold, ctx.cfg.siteUrl), link.key_hash, fetchImpl, undefined, "low_balance"); // E146
  }
  return { alerted, rearmed };
}
export async function lowBalanceInbox(ctx: Ctx, accountId: string, since: string | undefined, asOf: string) {
  if (!ctx.cfg.lowBalanceAlertsEnabled) return [];
  const rows = await ctx.db.select().from(lowBalanceAlerts).where(and(eq(lowBalanceAlerts.accountId, accountId), since ? gt(lowBalanceAlerts.createdAt, new Date(since)) : undefined, lte(lowBalanceAlerts.createdAt, new Date(asOf)))).orderBy(desc(lowBalanceAlerts.createdAt), desc(lowBalanceAlerts.id)).limit(101);
  return rows.map(row => ({ id: `low-balance:${row.id}`, at: row.createdAt.toISOString(), kind: "low_balance", title: `Balance below your $${picoToUsdString(row.threshold)} alert`, amount: picoToUsdString(row.balance), status: null, href: "/dashboard/#payments", unread: true }));
}
