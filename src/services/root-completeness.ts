import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { chainEvents, kv, spentRoots } from "../db/schema.ts";
import { SpentTree } from "../receipts/merkle.ts";

// Credits.sol enforces that no root can block an exit: spent trees are sorted by key hash, and a key
// with no leaf proves it sits between two adjacent leaves and withdraws as if it spent nothing. Two
// settlement duties remain for the independent approver: every spent root must carry a leaf for every
// key hash with a deposit (an omitted key exits with its usage unpaid, at the operator's cost and, if
// that usage was already swept, out of other customers' deposits until the operator covers it), and no
// key's cumulative spend may exceed its deposits minus its withdrawals (a leaf above a key's net funding
// lets settlement sweep other customers' deposits). This reconciles the latest root (a candidate under
// review or a posted one) against the indexed Credits events and the ledger.

/** A root is computed from the events indexed before its row was written; allow for clock skew. */
const INDEX_SKEW_MS = 5 * 60_000;
const LIST_LIMIT = 100;

export type RootReconciliation = {
  ok: boolean;
  failures: string[];
  /** merkle_matches: the stored leaves rebuild the stored root; sorted: they are strictly ascending by key hash. */
  root: { epoch: number; status: string; created_at: string; as_of: string; total_spent_usdg: string; leaves: number; sorted: boolean; merkle_matches: boolean | null } | null;
  funded_keys: number;
  covered_keys: number;
  /** Funded before the root was computed, yet absent from it. */
  missing_keys: string[];
  /** Funded after the root was computed, still inside the grace period (the next root must cover them). */
  pending_keys: string[];
  /** Funded after the root was computed, and still uncovered after the grace period. */
  overdue_keys: string[];
  /** Leaves above the key's deposits minus withdrawals (USDG base units). */
  overspent_keys: { key_hash: string; spent_usdg: string; net_funded_usdg: string }[];
  /** Leaves for key hashes with no indexed deposit. */
  unknown_leaves: string[];
  totals: {
    leaves_sum_usdg: string;
    previous_total_usdg: string;
    total_spent_usdg: string;
    total_matches: boolean;
    settled_usdg: string | null;
    settled_within_total: boolean;
    funded_usdg: string;
    withdrawn_usdg: string;
    /** Indexed Credits funding events and the ledger credits they produced agree one-to-one. */
    processed_without_credit: number;
    credit_amount_mismatches: number;
    credits_without_event: number;
    /** Withdrawals finalized with an absence proof (Credits.AbsenceProven): usage a root left out is the operator's loss. */
    absence_exits: number;
  };
};

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? (result as T[]));
const cap = <T>(list: T[]) => list.slice(0, LIST_LIMIT);

export async function reconcileSpentRoots(db: Db, opts: { graceMs: number; now?: Date; verifyMerkle?: boolean }): Promise<RootReconciliation> {
  const now = (opts.now ?? new Date()).getTime();
  const keyHash = sql<string>`lower(${chainEvents.args}->>'keyHash')`;
  const amount = sql<string>`coalesce(sum((${chainEvents.args}->>'amount')::numeric), 0)::text`;
  const [funded, withdrawnRows, [latest], [ledgerCheck], [orphanCredits], [absenceExits]] = await Promise.all([
    db
      .select({ keyHash, amount, firstSeenMs: sql<string>`(extract(epoch from min(${chainEvents.createdAt})) * 1000)::text` })
      .from(chainEvents)
      .where(and(eq(chainEvents.contract, "credits"), inArray(chainEvents.event, ["Deposited", "Credited"])))
      .groupBy(keyHash),
    db
      .select({ keyHash, amount })
      .from(chainEvents)
      .where(and(eq(chainEvents.contract, "credits"), eq(chainEvents.event, "Withdrawn")))
      .groupBy(keyHash),
    db.select().from(spentRoots).orderBy(desc(spentRoots.epoch)).limit(1),
    // The indexer writes ledger ref dep:/cred:<tx>:<logIndex> for each funding event it applies.
    db.execute(sql`
      SELECT
        count(*) FILTER (WHERE e.processed AND l.id IS NULL)::int AS processed_without_credit,
        count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount::numeric <> (e.args->>'amount')::numeric * 1000000)::int AS amount_mismatches
      FROM chain_events e
      LEFT JOIN ledger l ON l.ref = (CASE WHEN e.event = 'Deposited' THEN 'dep:' ELSE 'cred:' END) || e.tx_hash || ':' || e.log_index
      WHERE e.contract = 'credits' AND e.event IN ('Deposited', 'Credited')`).then((r) => rowsOf<{ processed_without_credit: number; amount_mismatches: number }>(r)),
    db.execute(sql`
      SELECT count(*)::int AS n FROM ledger l
      WHERE (l.ref LIKE 'dep:%' OR l.ref LIKE 'cred:%') AND NOT EXISTS (
        SELECT 1 FROM chain_events e WHERE e.contract = 'credits'
          AND l.ref = (CASE WHEN e.event = 'Deposited' THEN 'dep:' ELSE 'cred:' END) || e.tx_hash || ':' || e.log_index)`).then((r) => rowsOf<{ n: number }>(r)),
    db.select({ n: sql<number>`count(*)::int` }).from(chainEvents).where(and(eq(chainEvents.contract, "credits"), eq(chainEvents.event, "AbsenceProven"))),
  ]);

  const deposited = new Map(funded.map((f) => [f.keyHash, BigInt(f.amount)]));
  const withdrawn = new Map(withdrawnRows.map((w) => [w.keyHash, BigInt(w.amount)]));
  const failures: string[] = [];
  const leaves = ((latest?.leaves ?? []) as [string, string][]).map(([h, s]) => [String(h).toLowerCase(), BigInt(s)] as const);
  const leafMap = new Map(leaves);
  // In an unsorted or duplicated tree a key may prove several spends and its holder picks the lowest,
  // so that is settlement's loss; it is still a malformed root the approver must reject.
  const sorted = leaves.every(([h], i) => /^0x[0-9a-f]{64}$/.test(h) && (i === 0 || BigInt(leaves[i - 1][0]) < BigInt(h)));
  if (latest && !sorted) failures.push("stored leaves are not strictly sorted by key hash");
  const rootCreated = latest ? latest.createdAt.getTime() : null;

  const missing: string[] = [], pending: string[] = [], overdue: string[] = [];
  for (const f of funded) {
    if (leafMap.has(f.keyHash)) continue;
    const firstSeen = Number(f.firstSeenMs);
    if (rootCreated !== null && firstSeen <= rootCreated - INDEX_SKEW_MS) missing.push(f.keyHash);
    else if (now - firstSeen > opts.graceMs) overdue.push(f.keyHash);
    else pending.push(f.keyHash);
  }
  if (missing.length) failures.push(`latest root omits ${missing.length} funded key(s)`);
  if (overdue.length) failures.push(`${overdue.length} funded key(s) have no root after the grace period`);

  const overspent: RootReconciliation["overspent_keys"] = [];
  const unknown: string[] = [];
  for (const [h, spent] of leaves) {
    if (!deposited.has(h)) {
      if (spent > 0n) unknown.push(h);
      continue;
    }
    const net = deposited.get(h)! - (withdrawn.get(h) ?? 0n);
    if (spent > net) overspent.push({ key_hash: h, spent_usdg: spent.toString(), net_funded_usdg: net.toString() });
  }
  if (overspent.length) failures.push(`${overspent.length} leaf/leaves exceed the key's deposits minus withdrawals`);
  if (unknown.length) failures.push(`${unknown.length} leaf/leaves spend for key hashes with no indexed deposit`);

  const leavesSum = leaves.reduce((a, [, s]) => a + s, 0n);
  let previousTotal = 0n;
  let settled: bigint | null = null;
  let merkleMatches: boolean | null = null;
  if (latest) {
    const [[previous], [settledRow]] = await Promise.all([
      latest.epoch > 1 ? db.select({ total: spentRoots.totalSpentUsdg }).from(spentRoots).where(eq(spentRoots.epoch, latest.epoch - 1)) : Promise.resolve([]),
      db.select({ value: kv.value }).from(kv).where(eq(kv.key, `spent_settled:${latest.epoch}`)),
    ]);
    previousTotal = previous?.total ?? 0n;
    if (settledRow && /^\d+$/.test(String(settledRow.value))) settled = BigInt(String(settledRow.value));
    if (opts.verifyMerkle) {
      try {
        merkleMatches = leaves.length > 0 && new SpentTree(leaves).root === latest.root.toLowerCase();
      } catch {
        merkleMatches = false; // a malformed key hash or a duplicated leaf
      }
    }
  }
  const expectedTotal = leavesSum > previousTotal ? leavesSum : previousTotal;
  const totalMatches = !latest || latest.totalSpentUsdg === expectedTotal;
  const settledWithin = !latest || settled === null || settled <= latest.totalSpentUsdg;
  if (!totalMatches) failures.push("root total is not max(sum of leaves, previous root total)");
  if (!settledWithin) failures.push("settled usage recorded for the root exceeds its total");
  if (merkleMatches === false) failures.push("stored leaves do not hash to the stored root");

  const processedWithoutCredit = Number(ledgerCheck?.processed_without_credit ?? 0);
  const amountMismatches = Number(ledgerCheck?.amount_mismatches ?? 0);
  const creditsWithoutEvent = Number(orphanCredits?.n ?? 0);
  if (processedWithoutCredit) failures.push(`${processedWithoutCredit} processed funding event(s) have no ledger credit`);
  if (amountMismatches) failures.push(`${amountMismatches} ledger credit(s) differ from their funding event`);
  if (creditsWithoutEvent) failures.push(`${creditsWithoutEvent} ledger funding credit(s) have no indexed event`);

  const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n).toString();
  return {
    ok: failures.length === 0,
    failures,
    root: latest
      ? { epoch: latest.epoch, status: latest.status, created_at: latest.createdAt.toISOString(), as_of: latest.asOf.toISOString(), total_spent_usdg: latest.totalSpentUsdg.toString(), leaves: leaves.length, sorted, merkle_matches: merkleMatches }
      : null,
    funded_keys: funded.length,
    covered_keys: funded.length - missing.length - pending.length - overdue.length,
    missing_keys: cap(missing),
    pending_keys: cap(pending),
    overdue_keys: cap(overdue),
    overspent_keys: cap(overspent),
    unknown_leaves: cap(unknown),
    totals: {
      leaves_sum_usdg: leavesSum.toString(),
      previous_total_usdg: previousTotal.toString(),
      total_spent_usdg: (latest?.totalSpentUsdg ?? 0n).toString(),
      total_matches: totalMatches,
      settled_usdg: settled === null ? null : settled.toString(),
      settled_within_total: settledWithin,
      funded_usdg: sum(deposited),
      withdrawn_usdg: sum(withdrawn),
      processed_without_credit: processedWithoutCredit,
      credit_amount_mismatches: amountMismatches,
      credits_without_event: creditsWithoutEvent,
      absence_exits: Number(absenceExits?.n ?? 0),
    },
  };
}
