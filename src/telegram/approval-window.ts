// K194: use the delivery transaction's connection and existing audience guards.
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import type { ApprovalRow } from "../agents/approvals.ts";
import { assertWindowManager, previewApprovalWindow } from "../agents/approval-window.ts";
export async function canOfferApprovalHour(ctx: Ctx, caller: KeyRow, row: ApprovalRow) {
  try {
    if ((row.intent as { kind?: string }).kind === "action" && !ctx.cfg.agentGuardEnabled) return false;
    await assertWindowManager(ctx, ctx.db, caller.keyHash, row.keyHash);
    await previewApprovalWindow(ctx.db, row);
    return true;
  } catch { return false; }
}
