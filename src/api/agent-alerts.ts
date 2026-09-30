import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { ownedKey, principal } from "./agents.ts";
import { ALERT_RETENTION_MS, readAlertState } from "../agents/alerts.ts";
export function agentAlertsRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/agents/:key_hash/alerts", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    c.header("cache-control", "no-store");
    const state = await readAlertState(ctx.db, key.accountId);
    return c.json({ data: state.feed.filter(a => a.key_hash === key.keyHash && Date.parse(a.at) > Date.now() - ALERT_RETENTION_MS).map(({ next_attempt: _lease, delivered_targets: _targets, channels: _channels, ...alert }) => alert) });
  });
}
