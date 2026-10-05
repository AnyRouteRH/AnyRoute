import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";

// Decision tags meet Agent Guard. A model call may carry X-Anyroute-Decision-Tag (src/receipts/decision-tag.ts), signed
// into its receipt; a Guard decision may carry details_sha256. Both are the same canonical-JSON hash of the order when the
// agent uses the helpers, so a decision is linked to the calls that informed it by reading existing records only: the
// stored receipt's decision_tag and agent_action_decisions.details_sha256. Nothing new is stored.

/** How far back a decision looks for the calls that informed it, and how many it names. */
export const LINK_WINDOW_MS = 86_400_000;
export const LINK_LIMIT = 5;

export type InformedBy = { generation_id: string; receipt_id: string; model: string; provider: string; at: string; receipt_url: string; verify_url: string };

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? r) as T[];

/**
 * The keys whose calls count as the same agent as `keyHash`: the key itself, the key it is an agent session of, and its
 * own agent sessions. Sibling sessions and other keys in the account are not linked.
 */
const family = (keyHash: string, accountId: string) => sql`(
  select ${keyHash}::text
  union select parent_key_hash from agent_sessions where key_hash = ${keyHash} and account_id = ${accountId}
  union select key_hash from agent_sessions where parent_key_hash = ${keyHash} and account_id = ${accountId})`;

/**
 * Calls in the deciding key's family whose signed receipt carries `tag` as decision_tag, made in the 24 hours up to `at`,
 * newest first. Each names its generation and receipt (the same id) and where to read and check the receipt.
 */
export async function callsInforming(db: Db | Tx, decider: { keyHash: string; accountId: string }, tag: string, at: Date): Promise<InformedBy[]> {
  const rows = rowsOf<{ id: string; receipt_id: string | null; model_id: string; provider_id: string; at: string }>(await db.execute(sql`
    select g.id, g.receipt_id, g.model_id, g.provider_id, to_char(g.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at
    from generations g
    where g.key_hash in ${family(decider.keyHash, decider.accountId)}
      and (g.account_id is null or g.account_id = ${decider.accountId})
      and g.ts > ${new Date(at.getTime() - LINK_WINDOW_MS).toISOString()}::timestamptz and g.ts <= ${at.toISOString()}::timestamptz
      and g.receipt->>'decision_tag' = ${tag}
    order by g.ts desc, g.id limit ${LINK_LIMIT}`));
  return rows.map((r) => {
    const receipt = r.receipt_id ?? r.id;
    return { generation_id: r.id, receipt_id: receipt, model: r.model_id, provider: r.provider_id, at: r.at, receipt_url: `/api/v1/receipts/${encodeURIComponent(receipt)}`, verify_url: `/verify/?r=${encodeURIComponent(receipt)}` };
  });
}

export const GUARD_LOOKUP_LIMIT = 20;
type DecisionRow = { id: string; key_hash: string; account_id: string; action: string; target: string | null; amount_pico: string; details_sha256: string; decision: string; created_at: string; outcome_status: string | null; outcome_amount_pico: string | null; outcome_at: string | null };

/**
 * The reverse link: Guard decisions with this order digest that the caller may read (the whole account for management,
 * owner and admin keys; otherwise the caller's own key and its agent sessions), newest first, each with the calls that
 * informed it at the time it was decided.
 */
export async function decisionsForTag(db: Db, reader: { keyHash: string; accountId: string; whole: boolean }, tag: string, linkCalls: boolean) {
  const scope = reader.whole
    ? sql`(select key_hash from keys where account_id = ${reader.accountId})`
    : sql`(select ${reader.keyHash}::text union select key_hash from agent_sessions where parent_key_hash = ${reader.keyHash} and account_id = ${reader.accountId})`;
  const rows = rowsOf<DecisionRow>(await db.execute(sql`
    select d.id, d.key_hash, k.account_id, d.action, d.target, d.amount_pico::text amount_pico, d.details_sha256, d.decision,
      to_char(d.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') created_at, d.outcome_status, d.outcome_amount_pico::text outcome_amount_pico,
      to_char(d.outcome_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') outcome_at
    from agent_action_decisions d join keys k on k.key_hash = d.key_hash
    where d.details_sha256 = ${tag} and k.account_id = ${reader.accountId} and d.key_hash in ${scope}
    order by d.created_at desc, d.id limit ${GUARD_LOOKUP_LIMIT}`));
  const out = [];
  for (const r of rows) {
    out.push({
      decision_id: r.id, key_hash: r.key_hash, action: r.action, target: r.target, amount_pico: r.amount_pico, details_sha256: r.details_sha256, decision: r.decision, decided_at: r.created_at,
      outcome: r.outcome_status ? { status: r.outcome_status, amount_pico: r.outcome_amount_pico, at: r.outcome_at } : null,
      ...(linkCalls ? { informed_by: await callsInforming(db, { keyHash: r.key_hash, accountId: r.account_id }, tag, new Date(r.created_at)) } : {}),
    });
  }
  return out;
}
