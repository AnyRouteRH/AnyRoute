// K187
import type { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { requireKey } from "../api/auth.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { kv } from "../db/schema.ts";
import { inboxScope, readInbox } from "./read.ts";
import { lockSnoozes, saveSnooze, snoozeKey, type Snooze } from "./snooze.ts";
const body = z.strictObject({ until: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()) });
export function inboxSnoozeRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/inbox/:id/snooze", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const value = body.parse(await readJson(c));
    const page = await readInbox(ctx, key, undefined, { ignoreSnooze: true });
    const item = page.data.find(item => item.id === c.req.param("id"));
    if (!item) fail(404, "Notice not found.", "not_found");
    return c.json(await saveSnooze(ctx, key, page.seen_scope, item, value.until));
  });
  app.delete("/api/v1/inbox/:id/snooze", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization")), scope = await inboxScope(ctx, key);
    // Exact visibility digest: no cross-account, team, ordinary-key or session edits.
    await ctx.db.transaction(async tx => { await lockSnoozes(tx, key.accountId); const name = snoozeKey(key.accountId, scope.seenScope, c.req.param("id")), [row] = await tx.select().from(kv).where(eq(kv.key, name)); if (row) await tx.update(kv).set({ value: { ...row.value as Snooze, until: new Date(Math.min(Date.now(), Date.parse((row.value as Snooze).until))).toISOString(), claimed: true }, updatedAt: new Date() }).where(eq(kv.key, name)); });
    return c.json({ id: c.req.param("id"), snoozed: false });
  });
}
