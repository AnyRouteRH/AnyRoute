import { telegramLinkCaller } from "../telegram/approvers.ts"; // E153
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { accountLinks, issueCode, removeAccountLink } from "../telegram/linking.ts";

export function telegramLinkingRoutes(app: Hono, ctx: Ctx) {
  app.use("/api/v1/telegram/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!ctx.cfg.telegram.linkingEnabled) fail(404, "Not found.", "not_found");
    await next();
  });
  app.get("/api/v1/telegram/link", async c => {
    const caller = await telegramLinkCaller(ctx, c);
    const link = (await accountLinks(ctx.db, caller.accountId)).find(l => l.key_hash === caller.keyHash);
    return c.json({ data: { linked: !!link, telegram_user_id: link?.uid ?? null, linked_at: link?.linked_at ?? null } });
  });
  app.post("/api/v1/telegram/link", async c => c.json({ data: await issueCode(ctx, await telegramLinkCaller(ctx, c)) }));
  app.delete("/api/v1/telegram/link", async c => {
    await removeAccountLink(ctx, await telegramLinkCaller(ctx, c));
    return c.json({ data: { linked: false } });
  });
}
