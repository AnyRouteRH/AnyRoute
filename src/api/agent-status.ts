// J176: same authentication and visibility as GET policy, including refusal of read-only keys.
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { ownedKey, principal } from "./agents.ts";
import { readAgentStatus } from "../agents/status.ts";

export function agentStatusRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/agents/:key_hash/status", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    c.header("cache-control", "no-store");
    const data = await ctx.db.transaction(tx => readAgentStatus(tx, key, { quiet: ctx.cfg.quietAgentAlertsEnabled, guard: ctx.cfg.agentGuardEnabled }), { isolationLevel: "repeatable read", accessMode: "read only" });
    return c.json({ data });
  });
}
