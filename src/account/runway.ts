import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { agentSessions, keys, ledger } from "../db/schema.ts";
import { balanceOf } from "../ledger/ledger.ts";
import { picoToUsd } from "../lib/money.ts";

/** Divide only after computing days: tiny charged spends must not round to zero. */
export function runwayMath(balance: bigint, spend: bigint) {
  const numerator = balance * 7n;
  const days = spend === 0n ? null : numerator / spend - (numerator < 0n && numerator % spend !== 0n ? 1n : 0n);
  return { balance_usd: picoToUsd(balance), spend_7d_usd: picoToUsd(spend), per_day_usd: picoToUsd(spend) / 7,
    days_left: days === null ? null : Number(days) };
}
/** Matches GET /credits: active account keys see account balance; sessions see their own remaining budget. */
export async function readRunway(ctx: Ctx, presented: KeyRow, now = new Date()) {
  const [key] = await ctx.db.select().from(keys).where(eq(keys.keyHash, presented.keyHash));
  const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1);
  const balance = session ? (key.budget ?? 0n) - key.spentTotal : (await balanceOf(ctx.db, key.accountId)).balance;
  // Actual posted debits, rather than estimates or uncovered provider costs. Refunds do not erase charged spend.
  const [row] = await ctx.db.select({ spend: sql<string>`coalesce(sum(-${ledger.amount}), 0)::text` }).from(ledger).where(and(
    eq(ledger.accountId, key.accountId), session ? eq(ledger.keyHash, key.keyHash) : undefined,
    gte(ledger.createdAt, new Date(now.getTime() - 7 * 86_400_000)), lte(ledger.createdAt, now),
    sql`${ledger.amount} < 0 and ${ledger.kind} in ('usage', 'tool_call', 'data_tool')`,
  ));
  return runwayMath(balance, BigInt(row?.spend ?? "0"));
}
