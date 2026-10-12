import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { savingsQuery } from "../savings/query.ts";
import { readSavings } from "../savings/read.ts";
export function accountSavingsRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/account/savings", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    return c.json(await readSavings(ctx, key, savingsQuery(c.req.query())));
  });
}
