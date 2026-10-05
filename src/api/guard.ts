import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { usdToPico } from "../lib/money.ts";
import { guardDecideInput, guardOutcomeInput } from "../agents/guard-input.ts";
import { agentActionDecisions } from "../agents/guard-schema.ts";
import { guardDecide, recordGuardOutcome } from "../agents/guard-decide.ts";
import { lockAccount } from "../agents/store.ts";

export function guardRoutes(app: Hono, ctx: Ctx) {
  app.use("/api/v1/guard/*", async (_c, next) => { if (!ctx.cfg.agentGuardEnabled) fail(404, "Not found.", "not_found"); await next(); });
  app.post("/api/v1/guard/decide", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const body = guardDecideInput.parse(await readJson(c));
    const data = await guardDecide(ctx, key, body);
    c.header("cache-control", "no-store");
    return c.json({ data });
  });
  app.post("/api/v1/guard/decisions/:id/outcome", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const body = guardOutcomeInput.parse(await readJson(c));
    const amount = body.amount_usd === undefined ? null : usdToPico(body.amount_usd, "ceil");
    const data = await ctx.db.transaction(async tx => {
      await lockAccount(tx, key.accountId);
      const [row] = await tx.select().from(agentActionDecisions).where(and(eq(agentActionDecisions.id, c.req.param("id")), eq(agentActionDecisions.keyHash, key.keyHash))).for("update");
      if (!row) fail(404, "Decision not found.", "not_found");
      if (row.outcomeStatus !== null) fail(409, "Outcome was already reported.", "guard_outcome_exists");
      if (row.decision !== "allow") fail(409, "Only an allowed action can report an outcome.", "guard_not_allowed");
      return recordGuardOutcome(tx, key.keyHash, row, body.status, amount, new Date());
    });
    return c.json({ data });
  });
}
