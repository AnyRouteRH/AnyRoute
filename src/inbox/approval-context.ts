// J185: enrich only already-visible approvals whose caller may decide them.
import { inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { readApprovalContext } from "../agents/approval-context.ts";
export async function enrichApprovalContext(ctx: Ctx, items: { kind: string; approval_id?: string; can_decide?: boolean; approval_context?: string[] }[], now: Date) {
  if (!ctx.cfg.agentApprovalContextEnabled) return;
  const visible = items.filter(item => item.kind === "approval" && item.can_decide && item.approval_id);
  if (!visible.length) return;
  const rows = await ctx.db.select().from(agentApprovals).where(inArray(agentApprovals.id, visible.map(item => item.approval_id!)));
  for (const row of rows) {
    const lines = await readApprovalContext(ctx.db, row, now);
    for (const item of visible) if (item.approval_id === row.id) item.approval_context = lines;
  }
}
