// B118: owner/management approval auth, with a read-only exact-change preview.
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { readJson } from "./common.ts";
import { ownedKey, principal } from "./agents.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { approvalJson } from "../agents/approvals.ts";
import { approveAndAllow, previewAllow } from "../agents/approve-and-allow.ts";
const confirmBody = z.strictObject({ policy_sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export function agentApproveAndAllowRoutes(app: Hono, ctx: Ctx) {
  for (const method of ["get", "post"] as const) app[method]("/api/v1/agents/approvals/:id/approve-and-allow", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c);
    const [row] = await ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, c.req.param("id")));
    if (!row) fail(404, "Approval not found.", "not_found");
    await ownedKey(ctx, caller, row.keyHash);
    if ((row.intent as { kind?: string })?.kind === "action" && !ctx.cfg.agentGuardEnabled) fail(404, "Not found.", "not_found");
    c.header("Cache-Control", "no-store");
    if (method === "get") return c.json({ data: (await previewAllow(ctx.db, row)).data });
    const body = confirmBody.parse(await readJson(c));
    const result = await approveAndAllow(ctx.db, caller.accountId, row, caller.keyHash, body.policy_sha256);
    return c.json({ data: { approval: approvalJson(result.approved), change: result.change, ...result.policy } });
  });
}
