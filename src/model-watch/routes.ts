import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { accounts } from "../db/schema.ts";
import { principal } from "../api/agents.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { validPrincipal } from "../telegram/linking.ts";
import { modelWatches } from "./schema.ts";
import { initialState, PAIR_MS } from "./state.ts";
const fields = z.strictObject({ model: z.string().min(1).max(256) });
export function modelWatchRoutes(app: Hono, ctx: Ctx) {
  const path = "/api/v1/account/model-watch";
  const access = async (c: Parameters<typeof principal>[1]) => {
    c.header("cache-control", "no-store");
    const key = await principal(ctx, c);
    if (!key.management) fail(403, "Use an account management key to watch models.", "forbidden");
    if (!ctx.cfg.modelWatchEnabled) fail(404, "Model watch is not switched on yet.", "feature_disabled");
    return key;
  };
  const result = async (account: string) => ({ data: (await ctx.db.select().from(modelWatches).where(and(eq(modelWatches.accountId, account), eq(modelWatches.watching, true)))).map(row => ({ model: row.modelId, name: ctx.catalog.models.get(row.modelId)?.name ?? row.modelId, watched_at: row.createdAt.toISOString() })), limit: 20 });
  app.get(path, async c => c.json(await result((await access(c)).accountId)));
  for (const method of ["put", "delete"] as const) app[method](path, async c => {
    const key = await access(c), value = fields.parse(await readJson(c));
    if (method === "put") { await ctx.catalog.ensureFresh(); if (!ctx.catalog.models.has(value.model) || ctx.catalog.models.get(value.model)!.hidden) fail(404, "Model not found.", "not_found"); }
    await ctx.db.transaction(async tx => {
      await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, key.accountId)).for("update");
      const live = await validPrincipal({ ...ctx, db: tx as unknown as Db }, { account: key.accountId, key_hash: key.keyHash });
      if (!live.management) fail(403, "Use an account management key to watch models.", "forbidden");
      const match = and(eq(modelWatches.accountId, key.accountId), eq(modelWatches.modelId, value.model));
      const rows = await tx.select().from(modelWatches).where(eq(modelWatches.accountId, key.accountId));
      const previous = rows.find(row => row.modelId === value.model), now = Date.now();
      if (method === "delete") {
        // Retain only an unexpired cooldown, so unwatch/rewatch cannot bypass the rolling hour.
        if (previous?.state.lastDown != null && now - previous.state.lastDown < PAIR_MS) {
          await tx.update(modelWatches).set({ watching: false, state: { ...initialState(now), lastDown: previous.state.lastDown } }).where(match);
        } else await tx.delete(modelWatches).where(match);
      } else if (!previous?.watching) {
        if (rows.filter(row => row.watching).length >= 20) fail(409, "You can watch up to 20 models. Unwatch one first.", "watch_limit");
        const state = { ...initialState(now), lastDown: previous?.state.lastDown ?? null };
        await tx.insert(modelWatches).values({ accountId: key.accountId, modelId: value.model, state }).onConflictDoUpdate({ target: [modelWatches.accountId, modelWatches.modelId], set: { watching: true, state, createdAt: new Date(now) } });
      }
    });
    return c.json(await result(key.accountId));
  });
}
