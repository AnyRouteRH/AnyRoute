import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
export const LEDGER_PAGE_SIZE = 100;
const instant = z.string().datetime({ offset: true });
const cursorSchema = z.strictObject({ ts: instant, id: z.string().min(1).max(180) });
export function ledgerQuery(query: Record<string, string>) {
  const from = query.from === undefined ? undefined : instant.parse(query.from);
  const to = query.to === undefined ? undefined : instant.parse(query.to);
  if (from && to && Date.parse(from) >= Date.parse(to)) fail(400, "from must be before to.", "invalid_request");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    } catch { fail(400, "Invalid ledger cursor.", "invalid_request"); }
  }
  return { from, to, cursor, format: z.enum(["json", "csv"]).parse(query.format ?? "json") };
}
// Aggregate events and generations separately: a request can evaluate parent and child policies and several models.
// No timestamp matching, and no cross-product can multiply its charge or tokens.
function ledgerRows(key: string): SQL {
  return sql`with ev as (
    select l.request_id, min(e.ts) ts, array_agg(e.id order by e.id) event_ids,
      array_agg(distinct e.policy_sha256 order by e.policy_sha256) policy_sha256s,
      string_agg(distinct e.intent->>'model', ', ' order by e.intent->>'model') model,
      string_agg(distinct e.intent->>'lane', ', ' order by e.intent->>'lane') lane,
      bool_or(e.decision = 'deny') denied, bool_or(e.decision = 'approval_required' or e.kind = 'approval_used') approval,
      max(l.approval_id) approval_id
    from agent_ledger_links l join agent_policy_events e on e.id = l.event_id
    where l.key_hash = ${key} group by l.request_id
  ), gen as (
    select l.request_id, min(g.ts) ts, string_agg(distinct g.model_id, ', ' order by g.model_id) model,
      string_agg(distinct coalesce(g.receipt->>'lane', g.receipt_v2->>'lane'), ', ') lane,
      sum(g.tokens_in)::text tokens_in, sum(g.tokens_out)::text tokens_out, sum(g.cost)::text cost_pico,
      jsonb_agg(jsonb_build_object('id', g.id, 'receipt_id', case when g.receipt_sig is not null or g.receipt_cose is not null then g.receipt_id else null end) order by g.id) receipts
    from agent_ledger_links l join generations g on g.id = l.generation_id and g.key_hash = l.key_hash
    where l.key_hash = ${key} group by l.request_id
  ), rows as (
    select 'request:' || coalesce(ev.request_id, gen.request_id) id, date_trunc('milliseconds', coalesce(ev.ts, gen.ts)) ts,
      case when ev.denied then 'deny' when ev.approval then 'approval' else 'allow' end decision,
      coalesce(gen.model, ev.model) model, coalesce(gen.lane, ev.lane) lane,
      coalesce(gen.tokens_in, '0') tokens_in, coalesce(gen.tokens_out, '0') tokens_out,
      case when ev.denied then '0' else coalesce(gen.cost_pico, '0') end cost_pico,
      coalesce(gen.receipts, '[]'::jsonb) receipts, ev.approval_id,
      coalesce(ev.event_ids, '{}'::bigint[]) event_ids, coalesce(ev.policy_sha256s, '{}'::text[]) policy_sha256s,
      false unlinked
    from ev full join gen using (request_id)
    union all
    select 'event:' || e.id, date_trunc('milliseconds', e.ts), case when e.decision = 'approval_required' then 'approval' else e.decision end,
      e.intent->>'model', e.intent->>'lane', '0', '0', '0', '[]'::jsonb, null, array[e.id], array[e.policy_sha256], true
    from agent_policy_events e where e.key_hash = ${key} and e.kind = 'decision'
      and not exists (select 1 from agent_ledger_links l where l.event_id = e.id)
    union all
    select 'generation:' || g.id, date_trunc('milliseconds', g.ts), 'allow', g.model_id, g.receipt->>'lane', g.tokens_in::text, g.tokens_out::text, g.cost::text,
      jsonb_build_array(jsonb_build_object('id', g.id, 'receipt_id', case when g.receipt_sig is not null or g.receipt_cose is not null then g.receipt_id else null end)), null, '{}'::bigint[], '{}'::text[], true
    from generations g where g.key_hash = ${key}
      and not exists (select 1 from agent_ledger_links l where l.generation_id = g.id)
  )`;
}
type RawRow = { id: string; ts: string | Date; decision: string; model: string | null; lane: string | null; tokens_in: string; tokens_out: string; cost_pico: string; receipts: { id: string; receipt_id: string | null }[]; approval_id: string | null; event_ids: (number | string)[]; policy_sha256s: string[]; unlinked: boolean };
const timestamp = (ts: string | Date) => new Date(ts).toISOString();
export function ledgerRow(row: RawRow) {
  const receipts = row.receipts.map(r => ({ generation_id: r.id, receipt_id: r.receipt_id, verify_url: r.receipt_id ? `/verify/?r=${encodeURIComponent(r.receipt_id)}` : null, receipt_url: r.receipt_id ? `/api/v1/receipts/${encodeURIComponent(r.receipt_id)}` : null }));
  return { id: row.id, time: timestamp(row.ts), decision: row.decision, model: row.model, lane: row.lane,
    tokens_in: Number(row.tokens_in), tokens_out: Number(row.tokens_out), cost_usd: picoToUsd(BigInt(row.cost_pico)), cost_pico: row.cost_pico,
    receipt_id: receipts.length === 1 ? receipts[0]!.receipt_id : null, verify_url: receipts.length === 1 ? receipts[0]!.verify_url : null, receipts,
    approval_id: row.approval_id, policy_sha256: row.policy_sha256s[0] ?? null, policy_sha256s: row.policy_sha256s,
    event_ids: row.event_ids.map(String), unlinked: row.unlinked };
}
function resultRows<T>(result: unknown): T[] { return ((result as { rows?: T[] }).rows ?? result) as T[]; }
export async function readAgentLedger(db: Db, key: string, query: ReturnType<typeof ledgerQuery>) {
  const cte = ledgerRows(key);
  const filter = sql`(${query.from ?? null}::timestamptz is null or ts >= ${query.from ?? null}::timestamptz) and (${query.to ?? null}::timestamptz is null or ts < ${query.to ?? null}::timestamptz)`;
  // One database snapshot for the page and totals. Cursor does not change the daily totals for the selected range.
  return db.transaction(async tx => {
    const rows = resultRows<RawRow>(await tx.execute(sql`${cte} select * from rows where ${filter}
      and (${query.cursor?.ts ?? null}::timestamptz is null or (ts, id) < (${query.cursor?.ts ?? null}::timestamptz, ${query.cursor?.id ?? null}::text))
      order by ts desc, id desc limit ${LEDGER_PAGE_SIZE + 1}`));
    const page = rows.slice(0, LEDGER_PAGE_SIZE), last = page.at(-1);
    const totals = resultRows<{ day: string; requests: string; tokens_in: string; tokens_out: string; cost_pico: string }>(await tx.execute(sql`${cte}
      select to_char(ts at time zone 'UTC', 'YYYY-MM-DD') as "day", count(*)::text requests,
      sum(tokens_in::bigint)::text tokens_in, sum(tokens_out::bigint)::text tokens_out, sum(cost_pico::numeric)::text cost_pico
      from rows where ${filter} group by 1 order by 1 desc`));
    return { data: { rows: page.map(ledgerRow), totals_per_day: totals.map(t => ({ day: t.day, requests: Number(t.requests), tokens_in: Number(t.tokens_in), tokens_out: Number(t.tokens_out), cost_pico: t.cost_pico, cost_usd: picoToUsd(BigInt(t.cost_pico)) })) },
      next_cursor: rows.length > LEDGER_PAGE_SIZE && last ? Buffer.from(JSON.stringify({ ts: timestamp(last.ts), id: last.id })).toString("base64url") : null };
  }, { isolationLevel: "repeatable read" });
}
/** Quote every cell, double quotes, and neutralize spreadsheet formulas in identifier fields. */
export const csvCell = (value: unknown) => '"' + String(value ?? '').replace(/^\s*[=+@-]/, "'$&").replaceAll('"', '""') + '"';
export const CSV_COLUMNS = ["id", "time", "decision", "model", "lane", "tokens_in", "tokens_out", "cost_usd", "cost_pico", "receipt_id", "verify_url", "approval_id", "policy_sha256", "receipts", "policy_sha256s", "event_ids", "unlinked"] as const;
export const ledgerCsvRow = (row: ReturnType<typeof ledgerRow>) => CSV_COLUMNS.map(c => csvCell(typeof row[c] === "object" && row[c] !== null ? JSON.stringify(row[c]) : row[c])).join(",") + "\r\n";
