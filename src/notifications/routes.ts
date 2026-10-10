import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { principal } from "../api/agents.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { accountLinks, lockLinks, validPrincipal } from "../telegram/linking.ts";
import { preferenceBody, readPreferences, savePreferences } from "./prefs.ts";
export function notificationRoutes(app: Hono, ctx: Ctx) {
  const path = "/api/v1/account/notifications";
  app.use(path, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  const access = async (c: Parameters<typeof principal>[1]) => {
    const key = await principal(ctx, c);
    if (!key.management) fail(403, "Use an account management key to change notifications.", "forbidden");
    return key;
  };
  const result = async (account: string) => ({ ...await readPreferences(ctx.db, account), telegram_linked: ctx.cfg.telegram.linkingEnabled && (await accountLinks(ctx.db, account)).length > 0, quiet_hours_available: ctx.cfg.notificationQuietHoursEnabled });
  app.get(path, async c => c.json({ data: await result((await access(c)).accountId) }));
  app.put(path, async c => {
    const caller = await access(c), value = preferenceBody.parse(await readJson(c));
    await ctx.db.transaction(async tx => {
      await lockLinks(tx);
      await validPrincipal({ ...ctx, db: tx as unknown as Db }, { account: caller.accountId, key_hash: caller.keyHash });
      if (value.channels.weekly_summary.telegram && !(await accountLinks(tx, caller.accountId)).length) fail(409, "Link Telegram before choosing a weekly summary.", "telegram_not_linked");
      await savePreferences(tx, caller.accountId, value);
    });
    return c.json({ data: await result(caller.accountId) });
  });
}
