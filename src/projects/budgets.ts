import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { projectBudgets, projectBudgetNotices, projectReservations } from "../db/project-budgets.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";
export function projectMonth(at = new Date()) {
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  return { from, to: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)), month: from.toISOString().slice(0, 7) };
}
// Old calls contribute their charged cost. New calls use settlement accounting so the gap between
// charging and writing a generation cannot let concurrent requests through. Refunds do not reset a cap.
export async function projectSpend(db: Db | Tx, accountId: string, name: string, at = new Date()) {
  const { from, to } = projectMonth(at);
  const result = await db.execute(sql`select
    coalesce((select sum(cost) from generations g where g.account_id = ${accountId} and g.project = ${name}
      and g.ts >= ${from.toISOString()}::timestamptz and g.ts < ${to.toISOString()}::timestamptz and not exists (select 1 from project_reservations p where p.id = g.id)), 0)
    + coalesce((select sum(charged_pico) from project_reservations where account_id = ${accountId} and name = ${name}
      and charged_at >= ${from.toISOString()}::timestamptz and charged_at < ${to.toISOString()}::timestamptz), 0) as spent,
    coalesce((select sum(h.amount) from project_reservations p join holds h on h.id = p.id
      where p.account_id = ${accountId} and p.name = ${name} and h.status = 'held'), 0) as held`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as { spent: string; held: string }[];
  return { spent: BigInt(rows[0].spent), held: BigInt(rows[0].held) };
}
export async function assertProjectBudget(tx: Tx, r: { accountId: string; project?: string; amount: bigint }, at = new Date()) {
  if (!r.project) return;
  // The ledger caller already holds the account row lock, also used by budget edits.
  const [budget] = await tx.select().from(projectBudgets).where(and(eq(projectBudgets.accountId, r.accountId), eq(projectBudgets.name, r.project)));
  if (!budget) return;
  const { spent, held } = await projectSpend(tx, r.accountId, r.project, at);
  if (spent + held + r.amount > budget.budget) fail(402,
    `Project '${r.project}' has used $${picoToUsdString(spent)} of its $${picoToUsdString(budget.budget)} budget this month`,
    "project_budget_exceeded", { project: r.project, budget_usd: picoToUsdString(budget.budget), spent_usd: picoToUsdString(spent), held_usd: picoToUsdString(held), month: projectMonth(at).month });
}
export async function recordProjectReservation(tx: Tx, r: { id: string; accountId: string; project?: string }) {
  if (r.project) await tx.insert(projectReservations).values({ id: r.id, accountId: r.accountId, name: r.project });
}
export async function settleProjectReservation(tx: Tx, id: string, charged: bigint, at = new Date()) {
  const [row] = await tx.update(projectReservations).set({ charged, chargedAt: at }).where(eq(projectReservations.id, id)).returning();
  if (!row || charged === 0n) return;
  await recordProjectNotice(tx, row.accountId, row.name, at);
}
export async function recordProjectNotice(tx: Tx, accountId: string, name: string, at = new Date()) {
  const [budget] = await tx.select().from(projectBudgets).where(and(eq(projectBudgets.accountId, accountId), eq(projectBudgets.name, name)));
  if (!budget || budget.budget === 0n) return;
  const { spent } = await projectSpend(tx, accountId, name, at);
  if (spent * 5n >= budget.budget * 4n) await tx.insert(projectBudgetNotices).values({ accountId, name, month: projectMonth(at).month, spent, budget: budget.budget, at }).onConflictDoNothing();
}
