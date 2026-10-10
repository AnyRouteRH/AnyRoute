import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { reliabilityQuery } from "../reliability/query.ts";
import { readReliability } from "../reliability/read.ts";
export function accountReliabilityRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/account/reliability", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    return c.json(await readReliability(ctx, key, reliabilityQuery(c.req.query())));
  });
}
