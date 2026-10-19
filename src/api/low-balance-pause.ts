// K195: account management authority, as on Notifications; no read-key allow-list change.
import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { principal } from "./agents.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { pauseAvailable, pauseOwner, pauseResponse, readPause, savePause } from "../account/low-balance-pause.ts";
const setting = z.strictObject({ low_balance_usd: z.number().finite().min(0).max(1_000_000).nullable() });
export function lowBalancePauseRoutes(app: Hono, ctx: Ctx) {
  const path = "/api/v1/account/low-balance-pause";
  app.get(path, async c => {
    c.header("cache-control", "no-store");
    const key = await principal(ctx, c);
    await pauseOwner(ctx, key.accountId, key.keyHash);
    return c.json(pauseResponse(ctx, await readPause(ctx.db, key.accountId)));
  });
  app.patch(path, async c => {
    c.header("cache-control", "no-store");
    const key = await principal(ctx, c);
    await pauseOwner(ctx, key.accountId, key.keyHash);
    if (!pauseAvailable(ctx)) fail(403, "Balance pauses are not switched on yet.", "feature_disabled");
    const body = setting.parse(await readJson(c));
    return c.json(await savePause(ctx, key.accountId, key.keyHash, body.low_balance_usd));
  });
}
