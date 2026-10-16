// J184: compose existing readers; no new tracking or durable state.
import { and, eq, gte, lt, isNull, inArray, asc, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { keys } from "../db/schema.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { readAgentRunway } from "../agents/runway.ts";
import { readReliability } from "../reliability/read.ts";
import { readSavings } from "../savings/read.ts";
import { modelWatchInbox } from "../model-watch/worker.ts";
import type { previousIsoWeek } from "./weekly-summary-text.ts";

export type SummarySection = { text: string; href: string };
const short = (value: string) => Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")).slice(0, 60).join("");
const names = (values: string[]) => values.slice(0, 2).map(short).join(" · ") + (values.length > 2 ? ` · +${values.length - 2} more` : "");
export function capConcern(limits: Awaited<ReturnType<typeof readAgentRunway>>["limits"]) {
  return limits.some(limit => limit.charged_usd !== null && limit.charged_usd > 0
    && (limit.charged_usd >= limit.cap_usd * 0.8 || limit.remaining_usd === 0));
}
export async function readSummarySections(ctx: Ctx, caller: KeyRow, week: ReturnType<typeof previousIsoWeek>, catalogReady = false): Promise<SummarySection[]> {
  const sections: SummarySection[] = [];
  const q = { days: 7, from: week.start.toISOString(), to: week.end.toISOString() };
  const report = await readReliability(ctx, caller, q, !caller.management);
  if (report.totals.success_rate !== null) sections.push({ text: `${report.totals.success_rate}% of your calls succeeded`, href: "/dashboard/#insights" });
  const savings = await readSavings(ctx, caller, q, { teamOnly: !caller.management, catalogReady });
  const tip = savings.models[0];
  if (tip) sections.push({ text: `Savings estimate: try ${short(tip.alternative.name)} for ${short(tip.name)}; same tokens, current rates, quality may differ`, href: "/dashboard/#insights" });
  // Account model watches have the same management-only visibility as their own inbox reader.
  if (caller.management) {
    const watches = (await modelWatchInbox(ctx, caller.accountId, q.to, new Date(week.start.getTime() - 1).toISOString())).filter(item => item.at >= q.from && item.at < q.to);
    if (watches.length) sections.push({ text: `Models you watch: ${names(watches.map(item => item.title))}`, href: "/models/" });
  }
  const agents = await ctx.db.select({ key: keys }).from(keys)
    .where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!))).orderBy(asc(keys.keyHash));
  const near: string[] = [];
  for (const { key } of agents) {
    const runway = await readAgentRunway(ctx.db, key, new Date(week.end.getTime() - 1));
    if (capConcern(runway.limits)) near.push(key.name || key.label || "Unnamed agent");
  }
  // Retained deny events also catch a cap reached earlier in the week, before a rolling window reset.
  const hits = await ctx.db.selectDistinct({ name: keys.name, label: keys.label, hash: keys.keyHash }).from(keys)
    .where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!), sql`exists (
      select 1 from agent_policy_events e where e.key_hash = ${keys.keyHash} and e.ts >= ${q.from}::timestamptz and e.ts < ${q.to}::timestamptz
      and e.kind = 'decision' and e.decision = 'deny' and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(e.reasons) = 'array' then e.reasons else '[]'::jsonb end) r
        where r->>'code' in ('over_per_request','over_per_hour','over_per_day','over_per_week','breaker:max_spend_usd_per_minute')))`)).orderBy(asc(keys.keyHash));
  for (const key of hits) { const name = key.name || key.label || "Unnamed agent"; if (!near.includes(name)) near.push(name); }
  if (near.length) sections.push({ text: `Agent caps: ${names(near)} reached a cap last week or were at least 80% used at week end`, href: "/agents/" });
  const expired = await ctx.db.select({ id: agentApprovals.id }).from(agentApprovals).innerJoin(keys, eq(keys.keyHash, agentApprovals.keyHash))
    .where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!),
      inArray(agentApprovals.status, ["pending", "expired"]), isNull(agentApprovals.decidedAt),
      gte(agentApprovals.expiresAt, week.start), lt(agentApprovals.expiresAt, week.end)));
  if (expired.length) sections.push({ text: `${expired.length} ${expired.length === 1 ? "approval expired" : "approvals expired"} without a decision`, href: "/agents/" });
  // J177's Account checkup reader is absent in this worktree; omit it rather than invent an endpoint or status.
  return sections;
}
