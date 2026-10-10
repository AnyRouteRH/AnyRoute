// E153: use existing decision attribution and security records.
import { and, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { keys } from "../db/schema.ts";
import { agentApprovals } from "./approval-schema.ts";
import type { ApprovalRow } from "./approvals.ts";
import { teamApproversEnabled, teamApproversContext } from "./approvers.ts";
import { keyActor, recordSecurity, securityContext } from "../security-alerts/records.ts";
export async function recordApprovalDecision(db: Db, tx: Tx, row: ApprovalRow) {
  const ctx = securityContext.getStore() ?? teamApproversContext(db);
  if (!teamApproversEnabled(db) || !ctx) return;
  const [target] = await tx.select().from(keys).where(eq(keys.keyHash, row.keyHash));
  if (!target) return;
  const [actor] = await tx.select().from(keys).where(and(eq(keys.keyHash, row.decidedBy!), eq(keys.accountId, target.accountId)));
  await recordSecurity(ctx, tx, target.accountId, target.teamId, `Request ${row.status === "approved" ? "approved" : "denied"} for key ${keyActor(target.name).slice(7)} ${keyActor(actor?.name)}`, `approval:${row.id}`);
}
export async function nameApprovalDecisions(ctx: Ctx, rows: { id: string; title: string }[]) {
  if (!ctx.cfg.agentTeamApproversEnabled) return;
  const ids = rows.filter(r => r.id.startsWith("approval:")).map(r => r.id.slice(9));
  if (!ids.length) return;
  const decisions = await ctx.db.select({ id: agentApprovals.id, status: agentApprovals.status, actor: keys.name }).from(agentApprovals).leftJoin(keys, eq(keys.keyHash, agentApprovals.decidedBy)).where(inArray(agentApprovals.id, ids));
  for (const row of rows) {
    const d = decisions.find(d => `approval:${d.id}` === row.id);
    if (d?.actor !== undefined && d?.actor !== null) row.title = `Request ${d.status === "denied" ? "denied" : "approved"} ${keyActor(d.actor)}`;
  }
}
