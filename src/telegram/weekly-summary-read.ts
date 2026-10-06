import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import type { previousIsoWeek, WeekSummary } from "./weekly-summary-text.ts";

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? r) as T[];
/** One snapshot; no joins between fact tables that could multiply charges or approvals. */
export async function readWeeklySummary(db: Db, caller: KeyRow, week: ReturnType<typeof previousIsoWeek>): Promise<WeekSummary> {
  const [row] = rowsOf<{
    activity: number; spent: string; agents: number; top_keys: { name: string; spent: string }[];
    approvals: number; approved: number; denied: number; stops: number; top_model: string | null;
  }>(await db.execute(sql`with eligible as (
    select k.key_hash, coalesce(nullif(k.name, ''), k.label, 'Unnamed agent') name from keys k
    where k.account_id = ${caller.accountId} and (${caller.management} or k.team_id = ${caller.teamId})
      and (exists (select 1 from agent_policies p where p.key_hash = k.key_hash)
        or exists (select 1 from agent_ledger_links l where l.key_hash = k.key_hash)
        or exists (select 1 from agent_policy_events e where e.key_hash = k.key_hash)
        or exists (select 1 from agent_approvals a where a.key_hash = k.key_hash))
  ), calls as (
    select g.key_hash, g.model_id, g.cost from generations g join eligible k on k.key_hash = g.key_hash
    where g.ts >= ${week.start.toISOString()}::timestamptz and g.ts < ${week.end.toISOString()}::timestamptz
      and (g.account_id is null or g.account_id = ${caller.accountId})
  ), approvals as (
    select a.key_hash, a.status from agent_approvals a join eligible k on k.key_hash = a.key_hash
    where a.requested_at >= ${week.start.toISOString()}::timestamptz and a.requested_at < ${week.end.toISOString()}::timestamptz
  ), events as (
    select e.key_hash, e.kind from agent_policy_events e join eligible k on k.key_hash = e.key_hash
    where e.ts >= ${week.start.toISOString()}::timestamptz and e.ts < ${week.end.toISOString()}::timestamptz
  ), spending as (
    select c.key_hash, k.name, sum(c.cost) spent from calls c join eligible k on k.key_hash = c.key_hash group by c.key_hash, k.name
  ) select
    ((select count(*) from calls) + (select count(*) from approvals) + (select count(*) from events))::int activity,
    coalesce((select sum(cost) from calls), 0)::text spent,
    (select count(*) from (select key_hash from calls union select key_hash from approvals union select key_hash from events) active)::int agents,
    coalesce((select jsonb_agg(jsonb_build_object('name', name, 'spent', spent::text) order by spent desc, key_hash)
      from (select * from spending where spent > 0 order by spent desc, key_hash limit 5) ranked), '[]'::jsonb) top_keys,
    (select count(*) from approvals)::int approvals,
    (select count(*) from approvals where status in ('approved', 'used'))::int approved,
    (select count(*) from approvals where status = 'denied')::int denied,
    (select count(*) from events where kind = 'killed')::int stops,
    (select model_id from calls group by model_id order by count(*) desc, model_id limit 1) top_model`));
  return {
    activity: row!.activity, spent: BigInt(row!.spent), agents: row!.agents,
    topKeys: row!.top_keys.map(k => ({ name: k.name, spent: BigInt(k.spent) })),
    approvals: row!.approvals, approved: row!.approved, denied: row!.denied, stops: row!.stops, topModel: row!.top_model,
  };
}
