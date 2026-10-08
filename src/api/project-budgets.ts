import type { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { accounts } from "../db/schema.ts";
import { projectBudgets } from "../db/project-budgets.ts";
import { activityAccess } from "../activity/access.ts";
import { requireKey, roleOf } from "./auth.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { projectInput } from "../projects/tags.ts";
import { projectMonth, projectSpend, recordProjectNotice } from "../projects/budgets.ts";
const setting = z.object({ budget_usd: z.number().finite().min(0).max(1_000_000) }).strict();
export function projectBudgetRoutes(app: Hono, ctx: Ctx) {
  const owner = async (authorization?: string) => {
    const key = await requireKey(ctx, authorization);
    // Caps aggregate the entire billing account. Team-scoped owners cannot read other teams.
    if (!key.management || (await activityAccess(ctx, key)).session || await roleOf(ctx, key) !== "owner") fail(403, "Use an account management key to manage project budgets.", "forbidden");
    return key;
  };
  const read = async (accountId: string, name: string, at = new Date()) => {
    const [budget] = await ctx.db.select().from(projectBudgets).where(and(eq(projectBudgets.accountId, accountId), eq(projectBudgets.name, name)));
    const spend = await projectSpend(ctx.db, accountId, name, at);
    return { name, month: projectMonth(at).month, spent_usd: picoToUsdString(spend.spent), held_usd: picoToUsdString(spend.held), budget_usd: budget ? picoToUsdString(budget.budget) : null };
  };
  app.get("/api/v1/projects", async c => {
    c.header("cache-control", "no-store"); const key = await owner(c.req.header("authorization"));
    const result = await ctx.db.execute(sql`select name from project_budgets where account_id = ${key.accountId}
      union select project from generations where account_id = ${key.accountId} and project is not null
      union select name from project_reservations where account_id = ${key.accountId}
      union select project from keys where account_id = ${key.accountId} and project is not null order by name`);
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as { name: string }[];
    const at = new Date(); return c.json({ data: await Promise.all(rows.map(row => read(key.accountId, row.name, at))) });
  });
  app.get("/api/v1/projects/:name/budget", async c => {
    c.header("cache-control", "no-store"); const key = await owner(c.req.header("authorization"));
    return c.json({ data: await read(key.accountId, projectInput.parse(c.req.param("name"))) });
  });
  app.put("/api/v1/projects/:name/budget", async c => {
    c.header("cache-control", "no-store"); const key = await owner(c.req.header("authorization"));
    const name = projectInput.parse(c.req.param("name")), body = setting.parse(await readJson(c));
    await ctx.db.transaction(async tx => {
      await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, key.accountId)).for("update");
      const budget = usdToPico(body.budget_usd);
      await tx.insert(projectBudgets).values({ accountId: key.accountId, name, budget }).onConflictDoUpdate({ target: [projectBudgets.accountId, projectBudgets.name], set: { budget } });
      await recordProjectNotice(tx, key.accountId, name);
    });
    return c.json({ data: await read(key.accountId, name) });
  });
  app.delete("/api/v1/projects/:name/budget", async c => {
    c.header("cache-control", "no-store"); const key = await owner(c.req.header("authorization")); const name = projectInput.parse(c.req.param("name"));
    await ctx.db.transaction(async tx => {
      await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, key.accountId)).for("update");
      await tx.delete(projectBudgets).where(and(eq(projectBudgets.accountId, key.accountId), eq(projectBudgets.name, name)));
    });
    return c.json({ data: await read(key.accountId, name) });
  });
}
