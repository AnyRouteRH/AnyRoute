// G164: highlight the existing pending row, after delegated authority is refreshed.
import { inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { kv } from "../db/schema.ts";
import { channelEnabled } from "../notifications/prefs.ts";
import { nudgeKey, nudgeTitle } from "../agents/approval-nudges.ts";
type Item = { kind: string; approval_id?: string; can_decide?: boolean; expires_at?: string; title: string };
export async function highlightApprovalNudges(ctx: Ctx, caller: KeyRow, items: Item[], now = new Date()) {
  if (!ctx.cfg.approvalNudgesEnabled || !ctx.cfg.agentPolicyEnabled || caller.scope === "read" || !await channelEnabled(ctx, caller.accountId, "approval_reminders", "inbox")) return;
  const approvals = items.filter(item => item.kind === "approval" && item.can_decide && item.approval_id && item.expires_at && Date.parse(item.expires_at) > now.getTime());
  if (!approvals.length) return;
  const markers = new Set((await ctx.db.select({ key: kv.key }).from(kv).where(inArray(kv.key, approvals.map(item => nudgeKey(item.approval_id!))))).map(row => row.key));
  for (const item of approvals) if (markers.has(nudgeKey(item.approval_id!))) item.title = nudgeTitle(new Date(item.expires_at!), now);
}
