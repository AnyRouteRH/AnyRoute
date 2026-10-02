import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { readStatement } from "../statements/read.ts";
import { fail } from "../lib/errors.ts";
export function statementRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.statementsEnabled) return;
  app.get("/api/v1/statements/:month", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    if (c.req.query("format") && c.req.query("format") !== "json") fail(400, "Use format=json. Print the account statement page for PDF.", "invalid_request");
    return c.json({ data: await readStatement(ctx, key, c.req.param("month")) });
  });
}
