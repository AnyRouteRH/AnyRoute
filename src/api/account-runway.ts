import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { accounts } from "../db/schema.ts";
import { requireKey, roleOf } from "./auth.ts";
import { readJson } from "./common.ts";
import { activityAccess } from "../activity/access.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { readRunway } from "../account/runway.ts";
const setting = z.object({ low_balance_usd: z.number().finite().min(0).max(1_000_000).nullable() }).strict();
export function accountRunwayRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/account/runway", async c => {
    c.header("cache-control", "no-store");
    return c.json(await readRunway(ctx, await requireKey(ctx, c.req.header("authorization"))));
  });
  const owner = async (authorization: string | undefined) => {
    const key = await requireKey(ctx, authorization);
    if ((await activityAccess(ctx, key)).session || await roleOf(ctx, key) !== "owner") fail(403, "Only an owner key can change balance alerts.", "forbidden");
    return key;
  };
  app.get("/api/v1/account/low-balance", async c => {
    c.header("cache-control", "no-store");
    const key = await owner(c.req.header("authorization"));
    const [account] = await ctx.db.select().from(accounts).where(eq(accounts.id, key.accountId));
    return c.json({ low_balance_usd: account.lowBalancePico === null ? null : picoToUsd(account.lowBalancePico), enabled: ctx.cfg.lowBalanceAlertsEnabled });
  });
  app.patch("/api/v1/account/low-balance", async c => {
    c.header("cache-control", "no-store");
    const key = await owner(c.req.header("authorization"));
    if (!ctx.cfg.lowBalanceAlertsEnabled) fail(403, "Balance alerts are not switched on yet.", "feature_disabled");
    const body = setting.parse(await readJson(c));
    const threshold = body.low_balance_usd === null ? null : usdToPico(body.low_balance_usd);
    await ctx.db.transaction(async tx => {
      const [current] = await tx.select().from(accounts).where(eq(accounts.id, key.accountId)).for("update");
      // Saving an unchanged setting does not resend. A new threshold starts a new crossing check.
      await tx.update(accounts).set({ lowBalancePico: threshold, lowBalanceAlerted: current.lowBalancePico === threshold ? current.lowBalanceAlerted : false }).where(eq(accounts.id, key.accountId));
    });
    return c.json({ low_balance_usd: body.low_balance_usd, enabled: true });
  });
}
