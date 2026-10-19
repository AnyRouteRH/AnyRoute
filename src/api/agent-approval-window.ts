// K194: management/owner/admin routes; read-only keys retain their explicit allow-list.
import type { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { approvalJson } from "../agents/approvals.ts";
import { approvalWindowView, approveForHour, assertWindowManager, endApprovalWindow, previewApprovalWindow } from "../agents/approval-window.ts";
import { ownedKey, principal } from "./agents.ts";
import { readJson } from "./common.ts";
const bodySchema = z.strictObject({ confirmation: z.string().regex(/^[a-f0-9]{64}$/) });
export function agentApprovalWindowRoutes(app: Hono, ctx: Ctx) {
  for (const method of ["get", "post"] as const) app[method]("/api/v1/agents/approvals/:id/approve-hour", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c);
    const [row] = await ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, c.req.param("id")));
    if (!row) fail(404, "Approval not found.", "not_found");
    await ownedKey(ctx, caller, row.keyHash);
    await assertWindowManager(ctx, ctx.db, caller.keyHash, row.keyHash);
    if ((row.intent as { kind?: string }).kind === "action" && !ctx.cfg.agentGuardEnabled) fail(404, "Not found.", "not_found");
    c.header("Cache-Control", "no-store");
    if (method === "get") return c.json({ data: { confirmation: (await previewApprovalWindow(ctx.db, row)).confirmation } });
    const body = bodySchema.parse(await readJson(c));
    const result = await approveForHour(ctx, caller.accountId, row.id, caller.keyHash, body.confirmation);
    return c.json({ data: { approval: approvalJson(result.approval), window: result.window } });
  });
  app.get("/api/v1/agents/:key_hash/approval-windows", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c), key = await ownedKey(ctx, caller, c.req.param("key_hash"));
    c.header("Cache-Control", "no-store");
    const windows = await approvalWindowView(ctx.db, key.keyHash);
    const originals = windows.length ? await ctx.db.select().from(agentApprovals).where(inArray(agentApprovals.id, windows.map(w => w.id))) : [];
    return c.json({ data: windows.map(w => ({ ...w, intent: originals.find(row => row.id === w.id)?.intent })) });
  });
  app.delete("/api/v1/agents/:key_hash/approval-windows/:id", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c), key = await ownedKey(ctx, caller, c.req.param("key_hash"));
    c.header("Cache-Control", "no-store");
    return c.json({ data: await endApprovalWindow(ctx, caller.accountId, key.keyHash, c.req.param("id"), caller.keyHash) });
  });
}
