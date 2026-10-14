import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { businessDetailsBody, canEditBusinessDetails, readBusinessDetails, saveBusinessDetails } from "../statements/business-details.ts";

export function businessDetailsRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.statementsEnabled) return;
  app.get("/api/v1/account/business-details", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    return c.json({ data: await readBusinessDetails(ctx, key.accountId), editable: await canEditBusinessDetails(ctx, key) });
  });
  app.put("/api/v1/account/business-details", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    if (!await canEditBusinessDetails(ctx, key)) fail(403, "Only an account management key can change business details.", "forbidden");
    const value = businessDetailsBody.parse(await readJson(c));
    return c.json({ data: await saveBusinessDetails(ctx, key.accountId, value), editable: true });
  });
}
