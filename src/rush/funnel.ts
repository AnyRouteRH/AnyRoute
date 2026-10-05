import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

export type FunnelDay = { day: string; wallet_sign_ins: number; first_deposits: number; first_calls: number };
/** First-ever milestones within at most 90 UTC calendar days, not counts of repeat actions. */
export async function readFunnel(db: Db, days = 30, now = new Date()): Promise<FunnelDay[]> {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Days must be between 1 and 90.");
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const start = new Date(Date.parse(end) - days * 86_400_000).toISOString();
  const result = await db.execute(sql`
    WITH milestones AS (
      SELECT date_trunc('day', a.created_at AT TIME ZONE 'UTC')::date AS day, 'wallet' AS kind
      FROM accounts a WHERE a.kind = 'wallet' AND a.created_at >= ${start} AND a.created_at < ${end}
        AND EXISTS (SELECT 1 FROM keys k WHERE k.account_id = a.id AND k.management AND k.created_at = a.created_at)
      UNION ALL
      SELECT date_trunc('day', l.created_at AT TIME ZONE 'UTC')::date, 'deposit'
      FROM ledger l WHERE l.kind IN ('deposit', 'stock_deposit', 'anyr_deposit', 'usdg_deposit') AND l.amount > 0
        AND l.created_at >= ${start} AND l.created_at < ${end}
        AND NOT EXISTS (SELECT 1 FROM ledger old WHERE old.account_id = l.account_id
          AND old.kind IN ('deposit', 'stock_deposit', 'anyr_deposit', 'usdg_deposit') AND old.amount > 0
          AND (old.created_at, old.id) < (l.created_at, l.id))
      UNION ALL
      SELECT date_trunc('day', g.ts AT TIME ZONE 'UTC')::date, 'call'
      FROM generations g WHERE g.account_id IS NOT NULL AND NOT g.cancelled
        AND g.finish_reason IS DISTINCT FROM 'error' AND g.receipt_sig IS NOT NULL
        AND g.ts >= ${start} AND g.ts < ${end}
        AND NOT EXISTS (SELECT 1 FROM generations old WHERE old.account_id = g.account_id
          AND NOT old.cancelled AND old.finish_reason IS DISTINCT FROM 'error' AND old.receipt_sig IS NOT NULL
          AND (old.ts, old.id) < (g.ts, g.id))
    )
    SELECT to_char(day, 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE kind = 'wallet') AS wallet_sign_ins,
      count(*) FILTER (WHERE kind = 'deposit') AS first_deposits,
      count(*) FILTER (WHERE kind = 'call') AS first_calls
    FROM milestones GROUP BY day ORDER BY day`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<Record<string, string | number>>;
  const byDay = new Map(rows.map(r => [String(r.day), { day: String(r.day), wallet_sign_ins: Number(r.wallet_sign_ins), first_deposits: Number(r.first_deposits), first_calls: Number(r.first_calls) }]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, wallet_sign_ins: 0, first_deposits: 0, first_calls: 0 };
  });
}
