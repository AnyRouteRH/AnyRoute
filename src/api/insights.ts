import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { insightsQuery } from "../insights/query.ts";
import { readInsights } from "../insights/read.ts";
import { insightSuggestions } from "../insights/suggest.ts";
export function insightsRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.spendInsightsEnabled) return;
  app.get('/api/v1/insights', async c => {
    c.header('cache-control','no-store');
    const key = await requireKey(ctx,c.req.header('authorization'));
    const report = await readInsights(ctx,key,insightsQuery(c.req.query()));
    return c.json({ ...report, suggestions: await insightSuggestions(ctx,report) });
  });
}
