import { bearer } from "../api/auth.ts";
import { sha256 } from "../lib/util.ts";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { principal } from "../api/agents.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { preferenceKey, securityContext } from "./records.ts";
const preferenceBody = z.strictObject({ enabled: z.boolean() });
export function securityAlertsMiddleware(app: Hono, ctx: Ctx) {
  app.use("*", (c, next) => {
    if (!ctx.cfg.securityAlertsEnabled) return next();
    const secret = bearer(c.req.header("authorization"));
    return securityContext.run({ ...ctx, securityActorHash: secret ? sha256(secret) : undefined }, next);
  });
}
export function securityAlertsRoutes(app: Hono, ctx: Ctx) {
  const path = "/api/v1/account/security-alerts";
  app.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!ctx.cfg.securityAlertsEnabled) fail(404, "Not found.", "not_found");
    await next();
  });
  app.get(path, async c => {
    const caller = await principal(ctx, c);
    if (!caller.management) fail(403, "Only a management key can change account settings.", "forbidden");
    const [row] = await ctx.db.select().from(kv).where(eq(kv.key, preferenceKey(caller.accountId)));
    return c.json({ data: { enabled: (row?.value as { enabled?: boolean } | undefined)?.enabled !== false } });
  });
  app.patch(path, async c => {
    const caller = await principal(ctx, c);
    if (!caller.management) fail(403, "Only a management key can change account settings.", "forbidden");
    const value = preferenceBody.parse(await readJson(c));
    await ctx.db.insert(kv).values({ key: preferenceKey(caller.accountId), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    return c.json({ data: value });
  });
}
