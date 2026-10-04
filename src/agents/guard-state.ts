import { sql, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { agentActionDecisions as actions } from "./guard-schema.ts";
import type { AgentPolicy } from "./policy.ts";
import type { AgentPolicyState } from "./evaluate.ts";
/** Same parent/session scope as model budgets; unreported allows hold their requested amount. */
export async function actionState(db: Db | Tx, scope: SQL, now: Date) {
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const [row] = await db.select({
    day: sql<string>`coalesce(sum(coalesce(${actions.outcomeAmountPico}, ${actions.amountPico})) filter (where ${actions.outcomeStatus} is null or ${actions.outcomeStatus} = 'executed'), 0)`,
    hour: sql<string>`count(*) filter (where ${actions.createdAt} > ${since(3_600_000)})::text`,
  }).from(actions).where(sql`${actions.keyHash} in ${scope} and ${actions.decision} = 'allow' and ${actions.createdAt} > ${since(86_400_000)} and ${actions.createdAt} <= ${now.toISOString()}`);
  return { actions_pico_day: BigInt(row.day), actions_hour: Number(row.hour) };
}
export function actionsRemaining(policy: AgentPolicy, state: AgentPolicyState) {
  const cap = policy.actions?.per_day_usd;
  const day = cap === undefined ? null : usdToPico(cap) - (state.actions_pico_day ?? 0n);
  return { actions_remaining: { per_day_usd: day === null ? null : picoToUsdString(day > 0n ? day : 0n), per_hour: policy.actions?.max_per_hour === undefined ? null : Math.max(0, policy.actions.max_per_hour - (state.actions_hour ?? 0)) } };
}

/** Remaining allowance is the tightest configured bound among own and inherited rulebooks. */
export function combinedActionsRemaining(policies: { actions_remaining?: { per_day_usd: string | null; per_hour: number | null } }[]) {
  const days = policies.flatMap(p => p.actions_remaining?.per_day_usd == null ? [] : [usdToPico(p.actions_remaining.per_day_usd)]);
  const hours = policies.flatMap(p => p.actions_remaining?.per_hour == null ? [] : [p.actions_remaining.per_hour]);
  return { actions_remaining: { per_day_usd: days.length ? picoToUsdString(days.reduce((a, b) => a < b ? a : b)) : null, per_hour: hours.length ? Math.min(...hours) : null } };
}
