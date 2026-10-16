// J185: read existing metadata on the supplied connection, including inside delivery transactions.
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { keys, ledger } from "../db/schema.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { utcWeekStart } from "../services/spend-watch.ts";
import { readRotation } from "../key-rotation/store.ts";
import { agentApprovals } from "./approval-schema.ts";
import { agentPolicyEvents } from "./schema.ts";
import type { ApprovalRow } from "./approvals.ts";
import { readAgentRunway } from "./runway.ts";
import { policiesFor } from "./store.ts";
import { workHoursCheck } from "./work-hours.ts";

export type ApprovalContext = {
  today?: bigint; dailyCaps?: { cap: bigint; rolling: boolean }[];
  insideWorkHours?: boolean; weekly?: { requested: number; approved: number };
  duplicated?: boolean; rotatedFrom?: boolean; rotatedTo?: boolean;
};
/** Two plain lines at most. No intent, prompt, source name or tool arguments enter this builder. */
export function approvalContextLines(maxCost: bigint, context: ApprovalContext): string[] {
  const money: string[] = [], facts: string[] = [];
  if (context.today !== undefined) {
    money.push(`Spend today: $${picoToUsdString(context.today)}`);
    for (const limit of context.dailyCaps ?? []) money.push(`daily cap: $${picoToUsdString(limit.cap)} (${limit.rolling ? "rolling 24 hours" : "UTC day"})`);
    money.push(`up to $${picoToUsdString(context.today + maxCost)} today with this request (estimate, if used)`);
  }
  if (context.insideWorkHours !== undefined) facts.push(context.insideWorkHours ? "Inside work hours now" : "Outside work hours now");
  if (context.weekly) facts.push(`Approvals this week (UTC): ${context.weekly.requested} requested, ${context.weekly.approved} approved`);
  if (context.duplicated) facts.push("Duplicate agent");
  if (context.rotatedFrom) facts.push("Replacement key after rotation");
  if (context.rotatedTo) facts.push("Rotated key; replacement exists");
  return [money.join("; "), facts.join(" · ")].filter(Boolean);
}
export async function readApprovalContext(db: Db | Tx, row: ApprovalRow, now = new Date()): Promise<string[]> {
  const [key] = await db.select().from(keys).where(eq(keys.keyHash, row.keyHash));
  if (!key) return [];
  const runway = await readAgentRunway(db, key, now);
  // Preserve integer pico amounts for the projection; runway's public amounts are JSON numbers.
  const [charges] = await db.select({ today: sql<string>`coalesce(sum(-${ledger.amount}), 0)::text` }).from(ledger).where(and(
    eq(ledger.accountId, key.accountId), eq(ledger.keyHash, row.keyHash), gte(ledger.createdAt, new Date(runway.today_from)), lte(ledger.createdAt, now),
    sql`${ledger.amount} < 0 and ${ledger.kind} in ('usage', 'tool_call', 'data_tool')`,
  ));
  const policies = await policiesFor(db, row.keyHash);
  const hours = policies.flatMap(policy => policy.spec.work_hours ? [policy.spec.work_hours] : []);
  const [weekly] = await db.select({ requested: sql<number>`count(*)::int`,
    approved: sql<number>`count(*) filter (where ${agentApprovals.decidedAt} is not null and ${agentApprovals.status} in ('approved', 'used', 'expired'))::int`,
  }).from(agentApprovals).where(and(eq(agentApprovals.keyHash, row.keyHash), gte(agentApprovals.requestedAt, new Date(utcWeekStart(now.getTime()))), lte(agentApprovals.requestedAt, now)));
  const [copy] = await db.select({ id: agentPolicyEvents.id }).from(agentPolicyEvents).where(and(eq(agentPolicyEvents.keyHash, row.keyHash), eq(agentPolicyEvents.kind, "duplicated"))).limit(1);
  const rotation = await readRotation(db, row.keyHash);
  return approvalContextLines(row.maxCostPico, {
    today: BigInt(charges.today),
    dailyCaps: runway.limits.filter(limit => limit.period === "day").map(limit => ({ cap: usdToPico(limit.cap_usd), rolling: limit.source === "rulebook" })),
    ...(hours.length ? { insideWorkHours: hours.every(value => workHoursCheck(value, now).inside) } : {}),
    weekly, duplicated: !!copy, rotatedFrom: !!rotation?.from, rotatedTo: !!rotation?.to,
  });
}
