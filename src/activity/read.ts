import { sql, type SQL } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { activityAccess } from "./access.ts"; // V88: shared spend visibility.
import { fail } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";
import { csvCell } from "../agents/ledger.ts";
import { agreementScope } from "../agreements/state.ts";
import { activityFingerprint, type ActivityQuery } from "./query.ts";
type Raw = { id: string; at: string; kind: string; title: string; amount_pico: string; model: string | null; lane: string | null; where: string | null; key_label: string | null; receipt_id: string | null; status: string; reference: string | null; limit_pico: string | null };
export function activityRow(r: Raw) {
  return { id: r.id, at: r.at, kind: r.kind, title: r.title, amount: picoToUsdString(BigInt(r.amount_pico)), currency: "USDG",
    model: r.model, lane: r.lane, where: r.where, key_label: r.key_label, receipt_id: r.receipt_id,
    receipt_url: r.receipt_id ? `/api/v1/receipts/${encodeURIComponent(r.receipt_id)}` : null,
    verify_url: r.receipt_id ? `/verify/?r=${encodeURIComponent(r.receipt_id)}` : null,
    status: r.status, reference: r.reference, approval_limit: r.limit_pico === null ? null : picoToUsdString(BigInt(r.limit_pico)) };
}
const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? r) as T[];
export async function readActivity(ctx: Ctx, key: KeyRow, q: ActivityQuery, eligible?: SQL) {
  const { session, whole } = await activityAccess(ctx, key);
  const scope = { account: key.accountId, key: whole ? null : key.keyHash, team: key.management ? null : key.teamId };
  const fingerprint = activityFingerprint(q, scope);
  if (q.cursor && q.cursor.filter !== fingerprint) fail(400, "Cursor does not match these filters or this key's access.", "invalid_request");
  const keys = sql`k.account_id = ${key.accountId} and (${whole} or k.key_hash = ${key.keyHash}) and (${q.key ?? null}::text is null or k.key_hash = ${q.key ?? null})`;
  // Agent administration keeps its existing team boundary for non-management administrators.
  const agents = sql`${keys} and (${!whole || key.management} or k.team_id = ${key.teamId})`;
  const label = sql`coalesce(nullif(k.name, ''), k.label)`;
  const sources: SQL[] = [];
  if (!q.kind || q.kind === "call") sources.push(sql`select 'call:' || g.id id, g.ts at, 'call' kind, 'AI call' title, (-g.cost)::text amount_pico,
    g.model_id model, coalesce(g.receipt->>'lane',g.receipt_v2->>'lane') lane, g.provider_id "where", ${label} key_label,
    case when g.receipt_sig is not null or g.receipt_cose is not null then g.receipt_id end receipt_id,
    case when g.cancelled then 'cancelled' else 'completed' end status, g.id reference, null::text limit_pico
    from generations g left join keys k on k.key_hash = g.key_hash where (${keys} or (${whole} and ${q.key ?? null}::text is null and g.account_id = ${key.accountId})) and (g.account_id is null or g.account_id = ${key.accountId})`);
  if (ctx.cfg.agentPolicyEnabled) {
    if (!q.kind || q.kind === "approval") sources.push(sql`select 'approval:' || a.id, coalesce(a.used_at,a.decided_at,a.requested_at), 'approval', 'Payment approval', '0', a.intent->>'model', a.intent->>'lane', null, ${label}, null,
      case when a.status in ('pending','approved') and a.expires_at <= now() then 'expired' else a.status end, a.id, a.max_cost_pico::text
      from agent_approvals a join keys k on k.key_hash = a.key_hash where ${agents}`);
    if (!q.kind || q.kind === "policy") sources.push(sql`select 'policy:' || e.id, e.ts, 'policy',
      case e.kind when 'killed' then 'Agent stopped' when 'resumed' then 'Agent resumed' when 'policy_set' then 'Agent rules changed' when 'decision' then 'Request blocked by rules' else 'Agent rule event' end,
      '0', e.intent->>'model', e.intent->>'lane', null, ${label}, null, coalesce(e.decision,e.kind), e.id::text, null
      from agent_policy_events e join keys k on k.key_hash = e.key_hash where ${agents} and e.kind not like 'approval_%' and (e.kind <> 'decision' or e.decision = 'deny')`);
    if (!q.kind || q.kind === "alert") sources.push(sql`select 'alert:' || (a->>'id'), (a->>'at')::timestamptz, 'alert',
      case a->>'kind' when 'cap' then 'Spending limit alert' when 'denials' then 'Blocked requests alert' when 'killed' then 'Agent stopped alert' else 'Approval alert' end,
      '0', null, null, null, ${label}, null, a->>'delivery', a->>'id', null
      from kv v cross join lateral jsonb_array_elements(v.value->'feed') a join keys k on k.key_hash = a->>'key_hash'
      where v.key = ${`agent-alerts:${key.accountId}`} and ${agents} and (a->>'at')::timestamptz > now() - interval '90 days'`);
  }
  if (!q.kind || ["deposit", "balance"].includes(q.kind)) sources.push(sql`select 'balance:' || l.id, l.created_at,
    case when l.kind = 'deposit' then 'deposit' else 'balance' end,
    case when l.ref like 'makegood:%' then 'Make-good refund' when l.kind = 'refund_onchain' then 'Refund sent on-chain' else
    case l.kind when 'deposit' then 'Funds added' when 'refund' then 'Funds refunded' when 'credit' then 'Credit added' else 'Balance changed' end end,
    l.amount::text, case when l.ref like 'makegood%' then (select g.model_id from generations g where g.id = l.generation_id) end, null, null, ${label},
    case when l.ref like 'makegood%' then (select m.id from makegood_refunds m where m.source_id = regexp_replace(l.ref, '^makegood(-onchain)?:', '') and m.receipt_sig is not null) end,
    'posted', l.kind, null
    from ledger l left join keys k on k.key_hash = l.key_hash where l.account_id = ${key.accountId}
    and (${whole} or l.key_hash = ${key.keyHash}) and (${q.key ?? null}::text is null or l.key_hash = ${q.key ?? null})
    and l.kind <> 'usage'`);
  // Auto top-ups of a key's limit, and top-ups skipped with the reason (src/ledger/topup.ts). No money moves, so the amount is 0.
  const usd = (pico: SQL) => sql`regexp_replace(to_char(${pico}::numeric / 1000000000000, 'FM999999999990.00'), '\\.00$', '')`;
  const topupBy = sql`${label} || ' by $' || ${usd(sql`t.amount_pico`)}`;
  if (!q.kind || q.kind === "topup") sources.push(sql`select 'topup:' || t.id, t.created_at, 'topup',
    case t.outcome when 'added' then 'Topped up ' || ${topupBy} || '; $' || ${usd(sql`greatest(t.max_per_week_pico - t.week_total_pico, 0)`)} || ' left this week'
    when 'skipped_balance' then 'Could not top up ' || ${topupBy} || ': your account has $' || ${usd(sql`greatest(t.available_pico, 0)`)} || ' available'
    when 'skipped_weekly' then 'Could not top up ' || ${topupBy} || ': its $' || ${usd(sql`t.max_per_week_pico`)} || ' weekly top-up limit is reached'
    else 'Could not top up ' || ${topupBy} || ': the team budget is fully allocated' end,
    '0', null, null, null, ${label}, null, case when t.outcome = 'added' then 'added' else 'skipped' end, t.id, null
    from key_topups t join keys k on k.key_hash = t.key_hash where ${agents}`);
  if (!q.kind || q.kind === "alert") sources.push(sql`select 'spend-alert:' || s.id || ':' || (f->>'id'), (f->>'at')::timestamptz, 'alert', 'Spending alert', '0', null, null, null,
    coalesce(f->>'key_label',${label}), null, f->'delivery'->>'status', s.id, null
    from spend_alerts s cross join lateral jsonb_array_elements(s.state->'history') f left join keys k on k.key_hash = s.key_hash
    where s.account_id = ${key.accountId} and (${key.management && !session} or s.key_hash = ${key.keyHash})
    and (${q.key ?? null}::text is null or s.key_hash = ${q.key ?? null})`);
  // Pending/reversed transfers do not represent an additional credit. Credited transfers already appear in ledger.
  if (whole && !q.key && key.accountId.startsWith("w_") && (!q.kind || q.kind === "deposit")) sources.push(sql`select 'deposit:' || d.id, coalesce(d.reversed_at,d.created_at), 'deposit', 'Escrow deposit status', '0', null, null, null, null, null, d.status, d.id, null
    from escrow_deposits d where d.from_address = ${`0x${key.accountId.slice(2)}`} and d.status <> 'credited'`);
  if (whole && !q.key && ctx.cfg.agreements.enabled && (!q.kind || q.kind === "agreement")) sources.push(sql`select 'agreement:' || e.tx_hash || ':' || e.log_index,
    to_timestamp((e.args->>'indexedAt')::double precision), 'agreement',
    case e.event when 'MilestoneFunded' then 'Agreement funds locked' when 'Settled' then 'Agreement funds settled' when 'DeliverySubmitted' then 'Agreement work submitted' when 'DisputeOpened' then 'Agreement disputed' when 'RulingPosted' then 'Agreement ruling recorded' else 'Agreement changed' end,
    (case when e.event = 'MilestoneFunded' and exists (select 1 from agreement_projection p where p.scope = e.scope and p.kind = 'agreement' and p.data->>'agreementId' = e.args->>'id' and p.data->>'payer' = lower(a.wallet)) then -(e.args->>'amount')::numeric * 1000000
      when e.event = 'Settled' then (case when exists (select 1 from agreement_projection p where p.scope = e.scope and p.kind = 'agreement' and p.data->>'agreementId' = e.args->>'id' and p.data->>'payer' = lower(a.wallet)) then (e.args->>'payerAmount')::numeric else (e.args->>'payeeAmount')::numeric end) * 1000000 else 0 end)::text,
    null, null, null, null, null, e.event, e.args->>'id', null
    from agreement_events e join accounts a on a.id = ${key.accountId} where e.scope = ${agreementScope(ctx.cfg)} and e.args ? 'indexedAt' and exists (
      select 1 from agreement_projection p
      where p.scope = e.scope and p.kind = 'agreement' and (p.data->>'payer' = lower(a.wallet) or p.data->>'payee' = lower(a.wallet))
      and (p.data->>'agreementId' = e.args->>'id' and (not (e.args ? 'milestone') or p.data->>'milestone' = e.args->>'milestone')
        or exists (select 1 from agreement_events r where r.scope = e.scope and r.event = 'RulingPosted' and r.args->>'key' = e.args->>'key'
          and r.args->>'id' = p.data->>'agreementId' and r.args->>'milestone' = p.data->>'milestone')))`);
  if (!sources.length) return { data: [], next_cursor: null, scope: whole ? "account" : "key" };
  const bounded = sources.map(s => sql`(select * from (${s}) source(id,at,kind,title,amount_pico,model,lane,"where",key_label,receipt_id,status,reference,limit_pico) where
    (${eligible ?? sql`true`}) and (${q.kind ?? null}::text is null or kind = ${q.kind ?? null}) and (${q.model ?? null}::text is null or model = ${q.model ?? null})
    and (${q.from ?? null}::timestamptz is null or at >= ${q.from ?? null}::timestamptz)
    and (${q.to ?? null}::timestamptz is null or at < ${q.to ?? null}::timestamptz)
    and (${q.cursor?.at ?? null}::timestamptz is null or (at,id collate "C") < (${q.cursor?.at ?? null}::timestamptz,${q.cursor?.id ?? null}::text collate "C"))
    order by at desc,id collate "C" desc limit ${q.limit})`);
  const raw = rowsOf<Raw>(await ctx.db.execute(sql`select id,to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,kind,title,amount_pico,model,lane,"where",key_label,receipt_id,status,reference,limit_pico
    from (${sql.join(bounded,sql` union all `)}) merged order by merged.at desc,id collate "C" desc limit ${q.limit}`));
  const last = raw.at(-1);
  return { data: raw.map(activityRow), scope: whole ? "account" : "key",
    next_cursor: raw.length === q.limit && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id, filter: fingerprint })).toString("base64url") : null };
}
export const ACTIVITY_CSV_COLUMNS = ["id", "at", "kind", "title", "amount", "currency", "model", "lane", "where", "key_label", "receipt_id", "receipt_url", "verify_url", "status", "reference", "approval_limit"] as const;
export const activityCsv = (rows: ReturnType<typeof activityRow>[]) => ACTIVITY_CSV_COLUMNS.join(",") + "\r\n" + rows.map(row => ACTIVITY_CSV_COLUMNS.map(col => csvCell(row[col])).join(",") + "\r\n").join("");
