import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { activityQuery } from "../activity/query.ts";
import { activityCsv, readActivity } from "../activity/read.ts";
export function activityRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/activity", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const query = activityQuery(c.req.query());
    const page = await readActivity(ctx, key, query);
    if (query.format === "json") return c.json(page);
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="activity.csv"');
    if (page.next_cursor) c.header("x-next-cursor", page.next_cursor);
    c.header("access-control-expose-headers", "x-next-cursor");
    return c.body(activityCsv(page.data));
  });
}
