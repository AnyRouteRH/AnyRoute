// G164: one durable claim before outbound delivery, shared by all worker replicas.
import { and, eq, gt, isNull, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { ApprovalRow } from "./approvals.ts";
import { agentApprovals } from "./approval-schema.ts";
import { keys, kv } from "../db/schema.ts";
import { sendApprovalNudge } from "../telegram/approval-nudges.ts";
import { accountLinks } from "../telegram/linking.ts";

export const nudgeKey = (id: string) => `approval-nudged:${id}`;
export const nudgeWindow = (lifetime: number) => Math.max(120_000, Math.min(600_000, lifetime * 0.2));
export function nudgeDue(row: Pick<ApprovalRow, "status" | "decidedAt" | "requestedAt" | "expiresAt">, now = new Date()) {
  const remaining = row.expiresAt.getTime() - now.getTime();
  return row.status === "pending" && !row.decidedAt && remaining > 0 && remaining <= nudgeWindow(row.expiresAt.getTime() - row.requestedAt.getTime());
}
export const nudgeTitle = (expires: Date, now = new Date()) => `Expires in ${Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 60_000))} minute${expires.getTime() - now.getTime() > 60_000 ? "s" : ""}`;
export function registerApprovalNudges(ctx: Ctx) {
  if (ctx.cfg.approvalNudgesEnabled && ctx.cfg.agentPolicyEnabled && ctx.cfg.runtimeRole !== "api") ctx.jobs.register("approval-nudges", 60_000, () => runApprovalNudges(ctx));
}
export async function runApprovalNudges(ctx: Ctx, fetchImpl?: typeof fetch, now = new Date()) {
  if (!ctx.cfg.approvalNudgesEnabled || !ctx.cfg.agentPolicyEnabled || ctx.cfg.runtimeRole === "api") return { nudged: 0, sent: 0, skipped: "disabled" };
  await ctx.db.delete(kv).where(and(like(kv.key, "approval-nudged:%"), sql`(${kv.value}->>'expires')::timestamptz <= ${now.toISOString()}`));
  const candidates = await ctx.db.select({ row: agentApprovals, account: keys.accountId }).from(agentApprovals).innerJoin(keys, eq(keys.keyHash, agentApprovals.keyHash)).leftJoin(kv, sql`${kv.key} = 'approval-nudged:' || ${agentApprovals.id}`).where(and(eq(agentApprovals.status, "pending"), isNull(agentApprovals.decidedAt), gt(agentApprovals.expiresAt, now), isNull(kv.key), sql`${agentApprovals.expiresAt} <= ${now.toISOString()}::timestamptz + greatest(interval '2 minutes', least(interval '10 minutes', (${agentApprovals.expiresAt} - ${agentApprovals.requestedAt}) * 0.2))`)).orderBy(agentApprovals.expiresAt).limit(100);
  let nudged = 0, sent = 0;
  for (const candidate of candidates) {
    const claimed = await ctx.db.transaction(async tx => {
      const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, candidate.row.id)).for("update");
      if (!row || !nudgeDue(row, now)) return false;
      return (await tx.insert(kv).values({ key: nudgeKey(row.id), value: { at: now.toISOString(), expires: row.expiresAt.toISOString() }, updatedAt: now }).onConflictDoNothing().returning({ key: kv.key })).length > 0;
    });
    if (!claimed) continue;
    nudged++;
    for (const link of await accountLinks(ctx.db, candidate.account)) if (await sendApprovalNudge(ctx, candidate.row.id, link, fetchImpl, now)) sent++;
  }
  return { nudged, sent };
}
