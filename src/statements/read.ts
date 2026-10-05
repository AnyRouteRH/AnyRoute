import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { roleOf, type KeyRow } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";

export function statementMonth(month: string, now = new Date()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < "0001-01") fail(400, "Use a month in YYYY-MM format.", "invalid_request");
  const from = new Date(`${month}-01T00:00:00.000Z`);
  const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
  if (from > now) fail(404, "This month has not started.", "not_found");
  return { from, to: to > now ? now : to, soFar: to > now };
}
export type Totals = { opening: string; closing: string; deposits: string; refunds: string; usage: string; fees: string; other: string };
/** Signed movements: opening + deposits + refunds - usage - fees + other = closing. */
export function reconcile(t: Totals) {
  const difference = BigInt(t.closing) - (BigInt(t.opening) + BigInt(t.deposits) + BigInt(t.refunds) - BigInt(t.usage) - BigInt(t.fees) + BigInt(t.other));
  if (difference !== 0n) throw new Error("Statement ledger reconciliation failed.");
  return { reconciled: true, difference: picoToUsdString(difference), equation: "opening + deposits + refunds - usage - fees + other = closing" };
}
type Group = { id: string | null; label?: string | null; amount: string };
type Raw = Totals & { created: string; calls: string; models: Group[]; keys: Group[]; lanes: Group[]; movements: Group[] };
export async function readStatement(ctx: Ctx, key: KeyRow, month: string, now = new Date()) {
  const { from, to, soFar } = statementMonth(month, now);
  const role = await roleOf(ctx, key);
  const session = await ctx.db.execute(sql`select id from agent_sessions where key_hash = ${key.keyHash} limit 1`);
  const rows = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? r) as T[];
  const whole = !rows(session).length && (key.management || role === "owner" || role === "admin");
  // One SQL snapshot: opening, closing, all movements and usage groupings reconcile even while calls settle.
  const result = await ctx.db.execute(sql`
    with visible as (
      select l.*, g.model_id, coalesce(g.receipt->>'lane', g.receipt_v2->>'lane') lane,
        coalesce(nullif(k.name,''),k.label) key_label
      from ledger l left join keys k on k.key_hash=l.key_hash and k.account_id=l.account_id
      left join generations g on g.id=l.generation_id and (g.account_id=l.account_id or (g.account_id is null and g.key_hash=l.key_hash))
      where l.account_id=${key.accountId} and (${whole} or l.key_hash=${key.keyHash}) and l.created_at < ${to.toISOString()}::timestamptz
    ), monthly as (
      select *, case when kind in ('provisional','deposit','stock_deposit','anyr_deposit','usdg_deposit') then 'deposits'
        when kind='refund' then 'refunds' when kind='usage' then 'usage'
        when kind='fee' or right(kind,4)='_fee' then 'fees' else 'other' end category
      from visible where created_at >= ${from.toISOString()}::timestamptz
    )
    select a.created_at::text created,
      coalesce((select sum(amount) from visible where created_at < ${from.toISOString()}::timestamptz),0)::text opening,
      coalesce((select sum(amount) from visible),0)::text closing,
      coalesce((select sum(amount) from monthly where category='deposits'),0)::text deposits,
      coalesce((select sum(amount) from monthly where category='refunds'),0)::text refunds,
      coalesce((select -sum(amount) from monthly where category='usage'),0)::text usage,
      coalesce((select -sum(amount) from monthly where category='fees'),0)::text fees,
      coalesce((select sum(amount) from monthly where category='other'),0)::text other,
      (select count(*)::text from generations g left join keys k on k.key_hash=g.key_hash
        where (g.account_id=${key.accountId} or (g.account_id is null and k.account_id=${key.accountId}))
        and (${whole} or g.key_hash=${key.keyHash}) and g.ts >= ${from.toISOString()}::timestamptz and g.ts < ${to.toISOString()}::timestamptz) calls,
      coalesce((select jsonb_agg(x order by id nulls first) from (select model_id id, (-sum(amount))::text amount from monthly where category='usage' group by model_id) x),'[]') models,
      coalesce((select jsonb_agg(x order by id nulls first) from (select key_hash id,max(key_label) label,(-sum(amount))::text amount from monthly where category='usage' group by key_hash) x),'[]') keys,
      coalesce((select jsonb_agg(x order by id nulls first) from (select lane id,(-sum(amount))::text amount from monthly where category='usage' group by lane) x),'[]') lanes,
      coalesce((select jsonb_agg(x order by id) from (select kind id,sum(amount)::text amount from monthly group by kind) x),'[]') movements
    from accounts a where a.id=${key.accountId}`);
  const row = rows<Raw>(result)[0];
  const nextMonth = new Date(from); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  if (!row || new Date(row.created) >= nextMonth) fail(404, "No account existed in this month.", "not_found");
  const reconciliation = reconcile(row);
  for (const groups of [row.models, row.keys, row.lanes]) if (groups.reduce((s,g) => s + BigInt(g.amount),0n) !== BigInt(row.usage)) throw new Error("Statement usage grouping failed.");
  const money = (v: string) => picoToUsdString(BigInt(v));
  const groups = (g: Group[]) => g.map(r => ({ ...r, amount: money(r.amount) }));
  const payload = {
    type: "anyroute.statement.v1", month, currency: "USDG", time_zone: "UTC", generated_at: now.toISOString(),
    from: from.toISOString(), to_exclusive: to.toISOString(), so_far: soFar,
    account_created_at: new Date(row.created).toISOString(), scope: whole ? "account" : "key", key_hash: whole ? null : key.keyHash,
    opening_balance: money(row.opening), deposits: money(row.deposits), refunds: money(row.refunds), usage: money(row.usage), fees: money(row.fees),
    other_changes: money(row.other), closing_balance: money(row.closing), calls: row.calls,
    usage_by_model: groups(row.models), usage_by_key_agent: groups(row.keys), usage_by_lane: groups(row.lanes), movements_by_kind: groups(row.movements), reconciliation,
    limits: ["Balances are settled ledger totals, excluding open holds. Key-only totals are attributed movements, not the shared account balance.",
      "Usage is charged ledger usage, grouped by settlement time. Calls are counted by generation time, including zero-cost calls. Missing model, key or lane is null.",
      "Fees are separate fee ledger entries only; fees included in usage are not charged again. External wallet escrow and per-call payments are not router balance movements.",
      "This signature establishes the router's statement, not independent proof of the ledger. Earlier statements can change if ledger entries are added later."]
  };
  const signed = ctx.signer.sign(payload);
  return { payload, alg: "Ed25519", key_id: signed.keyId, sig: signed.sig };
}
