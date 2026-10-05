import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { fail } from "../lib/errors.ts";
import { LANE_REPORT_LIMITS, laneReportQuery, readLaneReport } from "../lane-report/read.ts";

// Lane report: read-only over existing call records, so like the proof pack it follows STATEMENTS_ENABLED and the
// statement and Activity key rules: management and owner/admin keys read the account, other keys only themselves.
export function laneReportRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.statementsEnabled) return;
  app.get("/api/v1/lane-report", async (c) => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const query = laneReportQuery(c.req.query());
    const rate = await ctx.limiter.take(`lane-report:${key.keyHash}`, 1, LANE_REPORT_LIMITS.perMinute, 60_000);
    if (!rate.ok) fail(429, "Too many lane reports from this key. Try again within a minute.", "rate_limited", undefined, { "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))) });
    return c.json({ data: await readLaneReport(ctx, key, query) });
  });
}
