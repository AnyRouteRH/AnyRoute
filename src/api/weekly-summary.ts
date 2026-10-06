import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { accounts, kv } from "../db/schema.ts";
import { principal } from "./agents.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { accountLinks, linkKey, lockLinks, validPrincipal } from "../telegram/linking.ts";

const preferenceBody = z.strictObject({ opted_in: z.boolean() });
export function weeklySummaryRoutes(app: Hono, ctx: Ctx) {
  app.use("/api/v1/telegram/weekly-summary", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!ctx.cfg.weeklySummaryEnabled || !ctx.cfg.telegram.linkingEnabled) fail(404, "Not found.", "not_found");
    await next();
  });
  const preference = async (caller: Awaited<ReturnType<typeof principal>>, optedIn?: boolean) => ctx.db.transaction(async tx => {
    await lockLinks(tx);
    await validPrincipal({ ...ctx, db: tx as unknown as Db }, { account: caller.accountId, key_hash: caller.keyHash });
    const link = (await accountLinks(tx, caller.accountId)).find(l => l.key_hash === caller.keyHash);
    if (!link) fail(409, "Link Telegram before choosing a weekly summary.", "telegram_not_linked");
    if (optedIn !== undefined) await tx.update(kv).set({ weeklySummaryOptedIn: optedIn }).where(eq(kv.key, linkKey(link.uid)));
    const [row] = await tx.select({ optedIn: kv.weeklySummaryOptedIn }).from(kv).where(eq(kv.key, linkKey(link.uid)));
    const [account] = await tx.select({ lastSentWeek: accounts.lastSentWeek }).from(accounts).where(eq(accounts.id, caller.accountId));
    return { opted_in: row?.optedIn === true, last_sent_week: account?.lastSentWeek ?? null };
  });
  app.get("/api/v1/telegram/weekly-summary", async c => c.json({ data: await preference(await principal(ctx, c)) }));
  app.put("/api/v1/telegram/weekly-summary", async c => {
    const caller = await principal(ctx, c);
    const { opted_in } = preferenceBody.parse(await readJson(c));
    return c.json({ data: await preference(caller, opted_in) });
  });
}
