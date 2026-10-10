// E153: add delegated pending requests without widening any other inbox source.
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { keys } from "../db/schema.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { approvableKeys, canApprove } from "../agents/approvers.ts";
import { inboxIntent } from "./read.ts";
import { picoToUsdString } from "../lib/money.ts";
export async function delegatedInbox(ctx: Ctx, caller: KeyRow, asOf: string) {
  if (!ctx.cfg.agentTeamApproversEnabled || !ctx.cfg.agentPolicyEnabled) return [];
  let visible: KeyRow[];
  try { visible = await approvableKeys(ctx, caller); } catch { return []; }
  if (!visible.length) return [];
  const rows = await ctx.db.select({ row: agentApprovals, name: keys.name }).from(agentApprovals).innerJoin(keys, eq(keys.keyHash, agentApprovals.keyHash)).where(and(inArray(agentApprovals.keyHash, visible.map(k => k.keyHash)), eq(agentApprovals.status, "pending"), gt(agentApprovals.expiresAt, new Date(asOf)))).orderBy(desc(agentApprovals.requestedAt), desc(agentApprovals.id)).limit(101);
  return rows.map(({ row, name }) => ({ id: `approval:${row.id}`, at: row.requestedAt.toISOString(), kind: "approval", title: "Approve an agent request", status: "pending", href: "/agents/", key_label: name, intent: inboxIntent(row.intent), approval_id: row.id, approval_limit: picoToUsdString(row.maxCostPico), expires_at: row.expiresAt.toISOString(), can_decide: true, unread: true }));
}
export async function refreshInboxAuthority(ctx: Ctx, caller: KeyRow, items: { kind: string; approval_id?: string; can_decide?: boolean }[]) {
  if (!ctx.cfg.agentTeamApproversEnabled) return;
  for (const item of items) if (item.kind === "approval" && item.approval_id) {
    const [target] = await ctx.db.select({ key: keys }).from(keys).innerJoin(agentApprovals, eq(agentApprovals.keyHash, keys.keyHash)).where(eq(agentApprovals.id, item.approval_id));
    item.can_decide = !!target && await canApprove(ctx.db, caller, target.key);
  }
}
