import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { agentSessions } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { accountDeposits, watchDeposit } from "../pay/deposit-progress.ts";
import { requireKey, requireRole } from "./auth.ts";
import { readJson } from "./common.ts";

const watchBody = z.strictObject({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), lane: z.enum(["escrow", "usdg"]) });
export function depositRoutes(app: Hono, ctx: Ctx) {
  const account = async (authorization: string | undefined) => {
    const key = await requireKey(ctx, authorization);
    if ((await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length) fail(403, "Session keys cannot read account deposits.", "forbidden");
    await requireRole(ctx, key, ["owner", "admin", "member", "viewer"]);
    return key.accountId;
  };
  app.get("/api/v1/credits/deposits", async c => {
    const id = await account(c.req.header("authorization"));
    c.header("Cache-Control", "no-store");
    return c.json({ data: await accountDeposits(ctx, id) });
  });
  app.post("/api/v1/credits/deposits", async c => {
    const id = await account(c.req.header("authorization"));
    const body = watchBody.parse(await readJson(c));
    if (!await watchDeposit(ctx, id, body.tx_hash, body.lane)) fail(429, "Already watching 20 submitted transactions. Check those before sending again.", "rate_limit");
    return c.json({ data: { tx_hash: body.tx_hash.toLowerCase(), stage: "submitted" } }, 202);
  });
}
