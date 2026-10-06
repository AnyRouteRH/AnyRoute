// B123: escrow ledger kinds are distinct from ordinary deposits. Read the worker's one-per-deposit notice.
import { and, desc, gt, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import type { DepositPing } from "../pay/deposit-pings.ts";
export async function depositPingItems(ctx: Ctx, accountId: string, asOf: string, since?: string) {
  if (!ctx.cfg.depositPingsEnabled) return [];
  const after = Math.max(Date.now() - 90 * 86_400_000, since ? Date.parse(since) : 0);
  const rows = await ctx.db.select({ value: kv.value, at: sql<string>`to_char(${kv.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(kv).where(and(like(kv.key, `deposit-ping:${ctx.cfg.chain.id}:%`), sql`${kv.value}->>'accountId' = ${accountId}`, gt(kv.updatedAt, new Date(after)), sql`${kv.updatedAt} < ${asOf}::timestamptz`)).orderBy(desc(kv.updatedAt), desc(kv.key)).limit(101);
  return rows.map(row => {
    const ping = row.value as DepositPing;
    return { id: `deposit-credit:${ping.depositId}`, at: row.at, kind: "deposit", title: "Deposit credited", status: "posted", amount: ping.amount, href: "/dashboard/#payments", unread: true };
  });
}
