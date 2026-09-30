import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { hostPolicies } from "./schema.ts";
import { publicPolicy } from "./publication.ts";

export function networkPolicyRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.networkPolicyEnabled) return;
  app.get("/api/v1/network/policy", async (c) => {
    const [row] = await ctx.db.select().from(hostPolicies).orderBy(desc(hostPolicies.version)).limit(1);
    if (!row) fail(404, "No network host policy has been published.", "not_found");
    c.header("Cache-Control", "no-store");
    return c.json({ data: publicPolicy(row) });
  });
  app.get("/api/v1/network/policy/:version", async (c) => {
    const v = c.req.param("version");
    if (!/^[1-9][0-9]*$/.test(v) || Number(v) > 2147483647) fail(400, "Policy version must be a positive integer.", "invalid_request");
    const [row] = await ctx.db.select().from(hostPolicies).where(eq(hostPolicies.version, Number(v)));
    if (!row) fail(404, "Unknown network host policy version.", "not_found");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.json({ data: publicPolicy(row) });
  });
}
