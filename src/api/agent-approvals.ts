import type { Hono, MiddlewareHandler } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { requireKey } from "./auth.ts";
import { ownedKey, principal } from "./agents.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { approvalJson, approvalRequest, approvalStatus, configureApprovals, decideApproval, expireApprovals } from "../agents/approvals.ts";
export const agentApprovalMiddleware = (ctx: Ctx): MiddlewareHandler => async (c, next) => {
  if (!ctx.cfg.agentPolicyEnabled) return next();
  const id = c.req.header("x-agent-approval");
  return approvalRequest.run(id ?? approvalRequest.getStore(), next);
};
export function agentApprovalsRoutes(app: Hono, ctx: Ctx) {
  configureApprovals(ctx.db, ctx.cfg.agentApprovalTtlS);
  app.use("/api/v1/agents/approvals/*", async (_c, next) => { if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found"); await next(); });
  app.use("/api/v1/agents/approvals", async (_c, next) => { if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found"); await next(); });
  app.get("/api/v1/agents/approvals", async c => {
    const caller = await principal(ctx, c);
    const status = c.req.query("status") ?? "pending";
    if (!["pending", "approved", "denied", "expired", "used"].includes(status)) fail(400, "Unknown approval status.");
    const visible = await ctx.db.select({ hash: keys.keyHash }).from(keys).where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!)));
    if (!visible.length) return c.json({ data: [] });
    for (const key of visible) await expireApprovals(ctx.db, key.hash);
    const data = await ctx.db.select().from(agentApprovals).where(and(inArray(agentApprovals.keyHash, visible.map(k => k.hash)), eq(agentApprovals.status, status as "pending"))).orderBy(desc(agentApprovals.requestedAt)).limit(100);
    c.header("Cache-Control", "no-store");
    return c.json({ data: data.map(approvalJson) });
  });
  app.get("/api/v1/agents/approvals/:id", async c => {
    const caller = await requireKey(ctx, c.req.header("authorization"));
    const [row] = await ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, c.req.param("id")));
    if (!row) fail(404, "Approval not found.", "not_found");
    if (caller.keyHash !== row.keyHash) await ownedKey(ctx, await principal(ctx, c), row.keyHash);
    c.header("Cache-Control", "no-store");
    return c.json({ data: approvalStatus(row) });
  });
  for (const action of ["approve", "deny"] as const) app.post(`/api/v1/agents/approvals/:id/${action}`, async c => {
    const caller = await principal(ctx, c);
    const [row] = await ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, c.req.param("id")));
    if (!row) fail(404, "Approval not found.", "not_found");
    await ownedKey(ctx, caller, row.keyHash);
    const updated = await decideApproval(ctx.db, caller.accountId, row.id, caller.keyHash, action);
    c.header("Cache-Control", "no-store");
    return c.json({ data: approvalJson(updated) });
  });
}
