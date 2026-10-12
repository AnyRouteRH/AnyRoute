// G158
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { requireKey, requireRole } from "../api/auth.ts";
import { keyJson } from "../api/keys.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { readRotation, rotateKey } from "./store.ts";
const rotationBody = z.strictObject({ grace: z.enum(["1h", "24h", "7d"]) });
export function keyRotationRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/keys/:hash/rotate", async c => {
    const caller = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, caller, ["owner", "admin"]);
    const body = rotationBody.parse(await readJson(c));
    const result = await rotateKey(ctx, caller, c.req.param("hash"), body.grace);
    c.header("cache-control", "no-store");
    return c.json({ data: keyJson(result.row), key: result.secret, rotation: result.rotation }, 201);
  });
  app.get("/api/v1/keys/:hash/rotation", async c => {
    const caller = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, caller, ["owner", "admin", "viewer"]);
    const [key] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, c.req.param("hash")), eq(keys.accountId, caller.accountId)));
    if (!key) fail(404, "Key not found.", "not_found");
    if (!caller.management && key.teamId !== caller.teamId) fail(403, "This key cannot read that key.", "forbidden");
    c.header("cache-control", "no-store");
    return c.json({ data: await readRotation(ctx.db, key.keyHash) });
  });
}
