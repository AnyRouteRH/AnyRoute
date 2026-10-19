import { filterInboxPage, inboxKinds } from "../inbox/filters.ts"; // H173
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { z } from "zod";
import { requireKey } from "./auth.ts";
import { fail } from "../lib/errors.ts";
import { inboxScope, readInbox } from "../inbox/read.ts";
const instant = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
export function inboxRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/inbox", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const since = c.req.query("since") === undefined ? undefined : instant.parse(c.req.query("since"));
    if (since && Date.parse(since) > Date.now()) fail(400, "Seen time must not be in the future.", "invalid_request");
    if (c.req.query("snoozed") !== undefined) { const sleeping = z.enum(["true", "false"]).parse(c.req.query("snoozed")) === "true", page = await readInbox(ctx, key, since, { snoozed: sleeping }); return c.json(c.req.query("kinds") === undefined ? page : filterInboxPage(page, inboxKinds(c.req.query("kinds")!))); } // K187
    if (c.req.query("kinds") !== undefined) { const kinds = inboxKinds(c.req.query("kinds")!); return c.json(filterInboxPage(await readInbox(ctx, key, since), kinds)); } // H173
    return c.json(await readInbox(ctx, key, since));
  });
  // The browser persists only the returned timestamp. Mark the displayed snapshot, never later arrivals.
  app.post("/api/v1/inbox/seen", async c => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const through = instant.parse(c.req.query("through"));
    if (Date.parse(through) > Date.now()) fail(400, "Seen time must not be in the future.", "invalid_request");
    return c.json({ seen_at: through, seen_scope: (await inboxScope(ctx, key)).seenScope });
  });
}
