import { telegramLinkCaller } from "../telegram/approvers.ts"; // E153
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { accountLinks, issueCode, removeAccountLink } from "../telegram/linking.ts";

// Which bot to message. The start link opens a private chat; Telegram then sends "/start link-<code>", which links like /link.
const botFields = (ctx: Ctx) => (ctx.cfg.telegram.botUsername ? { bot_username: ctx.cfg.telegram.botUsername } : {});

export function telegramLinkingRoutes(app: Hono, ctx: Ctx) {
  app.use("/api/v1/telegram/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!ctx.cfg.telegram.linkingEnabled) fail(404, "Not found.", "not_found");
    await next();
  });
  app.get("/api/v1/telegram/link", async c => {
    const caller = await telegramLinkCaller(ctx, c);
    const link = (await accountLinks(ctx.db, caller.accountId)).find(l => l.key_hash === caller.keyHash);
    return c.json({ data: { linked: !!link, telegram_user_id: link?.uid ?? null, linked_at: link?.linked_at ?? null, ...botFields(ctx) } });
  });
  app.post("/api/v1/telegram/link", async c => {
    const issued = await issueCode(ctx, await telegramLinkCaller(ctx, c));
    const bot = botFields(ctx);
    return c.json({ data: { ...issued, ...bot, ...(bot.bot_username ? { link_url: `https://t.me/${bot.bot_username}?start=link-${issued.code}` } : {}) } });
  });
  app.delete("/api/v1/telegram/link", async c => {
    await removeAccountLink(ctx, await telegramLinkCaller(ctx, c));
    return c.json({ data: { linked: false } });
  });
}
