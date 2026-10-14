// H170: same principal and key visibility as GET agent policy; existing read-key allow-list stays unchanged.
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { readAgentRunway } from "../agents/runway.ts";
import { fail } from "../lib/errors.ts";
import { ownedKey, principal } from "./agents.ts";

export function agentRunwayRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/agents/:key_hash/runway", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    c.header("cache-control", "no-store");
    return c.json({ data: await ctx.db.transaction(tx => readAgentRunway(tx, key), { isolationLevel: "repeatable read", accessMode: "read only" }) });
  });
}
