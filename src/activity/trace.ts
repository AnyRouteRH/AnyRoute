// J182: optional drill-down filters; omitted options leave the existing feed unchanged.
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { fail } from "../lib/errors.ts";
import type { ActivityQuery } from "./query.ts";
import type { KeyRow } from "../api/auth.ts";

// An account stamp preserves an owner's existing historical visibility after a key is removed.
export const stampedCallScope = (visibleKeys: SQL, key: KeyRow, whole: boolean, q: ActivityQuery) => sql`${visibleKeys} or (${whole} and g.account_id = ${key.accountId} and (${q.key ?? null}::text is null or g.key_hash = ${q.key ?? null}))`;

export function traceQuery(q: Record<string, string>) {
  const result = {
    ...(q.charge_kind === undefined ? {} : { charge_kind: z.enum(["usage", "rulebook"]).parse(q.charge_kind) }),
    ...(q.basis === undefined ? {} : { basis: z.literal("charges").parse(q.basis) }),
    ...(q.paid === undefined ? {} : { paid: z.literal("true").parse(q.paid) }),
    ...(q.missing_project === undefined ? {} : { missing_project: z.literal("true").parse(q.missing_project) }),
    ...(q.missing_model === undefined ? {} : { missing_model: z.literal("true").parse(q.missing_model) }),
    ...(q.lane === undefined ? {} : { lane: z.string().min(1).max(64).parse(q.lane) }),
  };
  if ((q.project && result.missing_project) || (q.model && result.missing_model)) fail(400, "Choose a recorded value or missing value, not both.", "invalid_request");
  return result;
}
export const traceFilter = (q: ActivityQuery) => sql`
  (${!q.missing_model} or model is null) and (${!q.missing_project} or kind = 'call' and (select g.project from generations g where g.id = reference) is null)
  and (${!q.paid} or amount_pico::numeric < 0)
  and (${q.lane ?? null}::text is null or coalesce(lane,'unknown') = ${q.lane ?? null})`;

/** Posted charges use settlement time, as the agent glance/runway do, rather than generation time. */
export function chargeSource(key: KeyRow, whole: boolean, q: ActivityQuery) {
  return sql`select 'charge:' || l.id id, l.created_at at, 'call' kind,
    case l.kind when 'usage' then 'AI call charge' else 'Tool charge' end title, l.amount::text amount_pico,
    g.model_id model, coalesce(g.receipt->>'lane',g.receipt_v2->>'lane') lane, g.provider_id "where", coalesce(nullif(k.name,''),k.label) key_label,
    case when g.receipt_sig is not null or g.receipt_cose is not null then g.receipt_id end receipt_id,
    'posted' status, g.id reference, null::text limit_pico
    from ledger l left join keys k on k.key_hash = l.key_hash and k.account_id = l.account_id
    left join generations g on g.id = l.generation_id and g.key_hash = l.key_hash and (g.account_id = l.account_id or g.account_id is null)
    where l.account_id = ${key.accountId} and (${whole} or l.key_hash = ${key.keyHash})
    and (${q.key ?? null}::text is null or l.key_hash = ${q.key ?? null})
    and (${q.charge_kind !== 'usage'} or l.kind = 'usage') and (${q.charge_kind !== 'rulebook'} or l.kind in ('usage','tool_call'))
    and l.amount < 0 and l.kind in ('usage','tool_call','data_tool')`;
}
