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
import { callsInforming, decisionsForTag } from "../agents/guard-links.ts";
import { activityAccess } from "../activity/access.ts";
import { generations } from "../db/schema.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function guardRoutes(app: Hono, ctx: Ctx) {
  app.use("/api/v1/guard/*", async (_c, next) => { if (!ctx.cfg.agentGuardEnabled) fail(404, "Not found.", "not_found"); await next(); });
  app.post("/api/v1/guard/decide", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const body = guardDecideInput.parse(await readJson(c));
    const data = await guardDecide(ctx, key, body);
    // Decision tags: the calls in this agent's family whose signed receipt carries the same order digest (guard-links.ts).
    const informed = body.details_sha256 && ctx.cfg.decisionTagsEnabled ? { informed_by: await callsInforming(ctx.db, key, body.details_sha256, new Date(data.signed.payload.ts)) } : {};
    c.header("cache-control", "no-store");
    return c.json({ data: { ...data, ...informed } });
  });
  // The reverse link: which decisions an order digest, or a receipt's decision tag, went into. Reads existing records only.
  app.get("/api/v1/guard/decisions", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const receiptId = c.req.query("receipt"), digest = c.req.query("details_sha256");
    if ((receiptId === undefined) === (digest === undefined)) fail(400, "Give either details_sha256=sha256:<64 hex> or receipt=<receipt id>.", "invalid_request");
    let tag: string | null = null;
    if (digest !== undefined) {
      if (!DIGEST.test(digest)) fail(400, "details_sha256 must be sha256: followed by 64 lowercase hex characters.", "invalid_request");
      tag = digest;
    } else {
      const [g] = await ctx.db.select({ receipt: generations.receipt }).from(generations).where(eq(generations.id, receiptId!)).limit(1);
      if (!g) fail(404, "Receipt not found.", "not_found");
      const t = (g.receipt as { decision_tag?: unknown } | null)?.decision_tag;
      tag = typeof t === "string" && DIGEST.test(t) ? t : null;
    }
    const { whole } = await activityAccess(ctx, key);
    const decisions = tag ? await decisionsForTag(ctx.db, { keyHash: key.keyHash, accountId: key.accountId, whole }, tag, ctx.cfg.decisionTagsEnabled) : [];
    c.header("cache-control", "no-store");
    return c.json({ data: { details_sha256: tag, ...(receiptId === undefined ? {} : { receipt_id: receiptId }), scope: whole ? "account" : "key", decisions } });
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
