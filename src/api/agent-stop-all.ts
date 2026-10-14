// H172: additive, opt-in bulk controls, guarded like neighbouring Stop routes.
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { principal } from "./agents.ts";
import { readJson } from "./common.ts";
import { killBody } from "../agents/stop-until.ts";
import { changeAllStops } from "../agents/stop-all.ts";
import { fail } from "../lib/errors.ts";

export function agentStopAllRoutes(app: Hono, ctx: Ctx) {
  for (const action of ["stop-all", "resume-all"] as const) app.post(`/api/v1/agents/${action}`, async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c);
    const body = action === "stop-all" ? killBody.parse(await readJson(c)) : {};
    const data = await ctx.db.transaction(tx => changeAllStops(ctx, tx, caller, action === "stop-all", body.reason ?? null, body.until ? new Date(body.until) : null));
    return c.json({ data });
  });
}
