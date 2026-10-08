// D141: same management/owner/team guards as neighbouring agent settings.
import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { ownedKey, principal } from "./agents.ts";
import { readJson } from "./common.ts";
import { QUIET_HOURS, readQuietSetting, saveQuietSetting } from "../agents/quiet-alerts.ts";

const body = z.strictObject({ hours: z.union(QUIET_HOURS.map(hours => z.literal(hours))).nullable() });
export function quietAgentAlertRoutes(app: Hono, ctx: Ctx) {
  for (const method of ["get", "put"] as const) app[method]("/api/v1/agents/:key_hash/quiet-alert", async c => {
    if (!ctx.cfg.quietAgentAlertsEnabled || !ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c);
    if (caller.scope === "inference") fail(403, "Inference keys cannot manage alerts.", "forbidden");
    const key = await ownedKey(ctx, caller, c.req.param("key_hash"));
    c.header("cache-control", "no-store");
    if (method === "put") return c.json({ data: await saveQuietSetting(ctx, key, body.parse(await readJson(c)).hours) });
    return c.json({ data: { key_hash: key.keyHash, hours: (await readQuietSetting(ctx.db, key.keyHash))?.hours ?? null } });
  });
}
