// H170: estimates from this key's posted charges only; no writes or request-content readers.
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { keys, ledger } from "../db/schema.ts";
import { picoToUsd } from "../lib/money.ts";
import { budgetPeriodStart, nextBudgetReset } from "../services/spend-watch.ts";
import { agentPolicies } from "./schema.ts";
import { autonomyMultiplier, readAutonomy, spendingCapPico } from "./autonomy.ts";

export const RUNWAY_DAY = 86_400_000;
/** Find the first actual instant of today's civil date, including short/long DST days. */
export function agentDayStart(now: Date, timeZone: string): Date {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = format.format(now);
  let low = now.getTime() - 2 * RUNWAY_DAY, high = now.getTime();
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (format.format(new Date(middle)) === today) high = middle; else low = middle;
  }
  return new Date(high);
}

export type RunwayLimit = {
  source: "rulebook" | "key_budget"; period: "request" | "hour" | "day" | "week" | "month" | "total";
  cap: bigint; spent: bigint | null; paceSpend: bigint; paceMs: number; resetsAt?: Date | null;
};
export function capRunway(limit: RunwayLimit, now: Date) {
  const remaining = limit.spent === null ? null : limit.cap > limit.spent ? limit.cap - limit.spent : 0n;
  const duration = remaining === 0n ? 0 : remaining === null || limit.paceSpend <= 0n || limit.paceMs <= 0 ? null
    : Number(remaining) / Number(limit.paceSpend) * limit.paceMs;
  const reaches = duration === null || now.getTime() + duration > 8.64e15 ? null : new Date(now.getTime() + duration);
  return { source: limit.source, period: limit.period, cap_usd: picoToUsd(limit.cap),
    charged_usd: limit.spent === null ? null : picoToUsd(limit.spent), remaining_usd: remaining === null ? null : picoToUsd(remaining),
    pace_per_day_usd: limit.paceMs > 0 ? picoToUsd(limit.paceSpend) * RUNWAY_DAY / limit.paceMs : 0,
    estimated_days_left: duration === null ? null : duration / RUNWAY_DAY,
    estimated_reaches_at: reaches?.toISOString() ?? null, resets_at: limit.resetsAt?.toISOString() ?? null,
    reaches_before_reset: limit.resetsAt && reaches ? reaches < limit.resetsAt : null };
}

export async function readAgentRunway(db: Db | Tx, key: typeof keys.$inferSelect, now = new Date()) {
  const [policy] = await db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, key.keyHash));
  const timeZone = policy?.spec.work_hours?.time_zone ?? "UTC";
  const today = agentDayStart(now, timeZone);
  const period = budgetPeriodStart(key.budgetReset, now.getTime());
  const from = key.budget !== null && period === null ? 0 : Math.min(today.getTime(), now.getTime() - 7 * RUNWAY_DAY, key.budget === null ? now.getTime() : period!);
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const [charges] = await db.select({
    today: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} >= ${today.toISOString()}), 0)::text`,
    hour: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} > ${since(3_600_000)} and ${ledger.kind} in ('usage', 'tool_call')), 0)::text`,
    day: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} > ${since(RUNWAY_DAY)} and ${ledger.kind} in ('usage', 'tool_call')), 0)::text`,
    week: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} > ${since(7 * RUNWAY_DAY)} and ${ledger.kind} in ('usage', 'tool_call')), 0)::text`,
    pace: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} > ${since(7 * RUNWAY_DAY)}), 0)::text`,
    budget: sql<string>`coalesce(sum(-${ledger.amount}) filter (where ${ledger.createdAt} >= ${new Date(period ?? 0).toISOString()}), 0)::text`,
  }).from(ledger).where(and(eq(ledger.accountId, key.accountId), eq(ledger.keyHash, key.keyHash), gte(ledger.createdAt, new Date(from)), lte(ledger.createdAt, now),
    sql`${ledger.amount} < 0 and ${ledger.kind} in ('usage', 'tool_call', 'data_tool')`));
  const elapsed = now.getTime() - today.getTime();
  const limits: RunwayLimit[] = [];
  if (policy) {
    const multiplier = autonomyMultiplier(policy.spec, await readAutonomy(db, policy, now));
    for (const window of ["request", "hour", "day", "week"] as const) {
      const cap = policy.spec.caps[`per_${window}_usd`];
      if (cap === undefined) continue;
      limits.push({ source: "rulebook", period: window, cap: spendingCapPico(cap, multiplier),
        spent: window === "request" ? null : BigInt(charges[window]),
        paceSpend: window === "day" ? BigInt(charges.today) : window === "hour" ? BigInt(charges.hour) : BigInt(charges.week),
        paceMs: window === "request" ? 0 : window === "day" ? elapsed : window === "hour" ? 3_600_000 : 7 * RUNWAY_DAY });
    }
  }
  if (key.budget !== null) limits.push({ source: "key_budget", period: ({ daily: "day", weekly: "week", monthly: "month" } as const)[key.budgetReset as "daily" | "weekly" | "monthly"] ?? "total",
    cap: key.budget, spent: BigInt(charges.budget), paceSpend: key.budgetReset === "daily" ? BigInt(charges.today) : BigInt(charges.pace),
    paceMs: key.budgetReset === "daily" ? elapsed : 7 * RUNWAY_DAY,
    resetsAt: nextBudgetReset(key.budgetReset, now.getTime()) === null ? null : new Date(nextBudgetReset(key.budgetReset, now.getTime())!) });
  return { key_hash: key.keyHash, as_of: now.toISOString(), time_zone: timeZone, today_from: today.toISOString(),
    today_charged_usd: picoToUsd(BigInt(charges.today)), spend_7d_usd: picoToUsd(BigInt(charges.pace)), estimate: true,
    limits: limits.map(limit => capRunway(limit, now)) };
}
