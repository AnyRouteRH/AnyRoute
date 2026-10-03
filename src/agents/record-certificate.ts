import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { Db, Tx } from "../db/client.ts";
import type { Config } from "../config.ts";
import { accounts, anchors, generations, ledger } from "../db/schema.ts";
import { agreementProjection } from "../agreements/schema.ts";
import { agreementScope } from "../agreements/state.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { picoToUsdString } from "../lib/money.ts";
import { rateBps, TRACK_RECORD_NOTICE, TRACK_RECORD_TREE, TRACK_RECORD_TTL_MS, TRACK_RECORD_TYPE, type TrackRecordPayload } from "./track-record-shared.ts";
import type { KeyRow } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { agentPolicyEvents } from "./schema.ts";
import { lockAccount, policiesFor } from "./store.ts";
import { RECORD_CERTIFICATE_NOTICE, RECORD_CERTIFICATE_TTL_MS, type RecordClaim, type RecordCertificate } from "./record-certificate-shared.ts";

/** Only the calling key's retained, completed, non-cancelled generation records count. No parent or sibling activity is added. */
export async function checkRecordClaims(tx: Db | Tx, key: KeyRow, claims: RecordClaim[], now: Date) {
  const [counts] = await tx.select({ requests: sql<string>`count(*)`, days: sql<string>`count(distinct (${generations.ts} at time zone 'UTC')::date)` }).from(generations)
    .where(sql`${generations.keyHash} = ${key.keyHash} and ${generations.ts} <= ${now.toISOString()} and ${generations.cancelled} = false and ${generations.finishReason} is not null`);
  const policies = await policiesFor(tx, key.keyHash);
  for (const claim of claims) {
    const [kind, value] = claim.split(":"), n = BigInt(value);
    let trueClaim = kind === "requests_at_least" ? BigInt(counts.requests) >= n : kind === "active_days_at_least" ? BigInt(counts.days) >= n : false;
    if (kind === "no_denials_days" || kind === "no_kills_days") {
      const cutoff = new Date(now.getTime() - Number(n) * 86_400_000);
      // A new, removed/recreated or recently edited policy cannot establish continuous coverage. Never infer absence from missing history.
      const covered = key.createdAt <= cutoff && policies.length > 0 && policies.every(p => p.updatedAt <= cutoff && !p.killed);
      if (covered) {
        const scope = policies.map(p => p.keyHash);
        const bad = kind === "no_kills_days" ? sql`${agentPolicyEvents.kind} = 'killed'` : sql`(${agentPolicyEvents.decision} = 'deny' or ${agentPolicyEvents.kind} = 'approval_denied')`;
        const [events] = await tx.select({ n: sql<string>`count(*)` }).from(agentPolicyEvents).where(sql`${agentPolicyEvents.keyHash} in (${sql.join(scope.map(h => sql`${h}`), sql`, `)}) and ${agentPolicyEvents.ts} >= ${cutoff.toISOString()} and ${agentPolicyEvents.ts} <= ${now.toISOString()} and ${bad}`);
        trueClaim = BigInt(events.n) === 0n;
      }
    }
    if (!trueClaim) fail(422, "A requested claim is false or lacks sufficient retained rulebook history.", "record_claim_unproven", { claim });
  }
}
export async function recordCertificatePayload(db: Db, key: KeyRow, claims: RecordClaim[]): Promise<RecordCertificate["payload"]> {
  return db.transaction(async tx => {
    await lockAccount(tx, key.accountId);
    const now = new Date();
    await checkRecordClaims(tx, key, claims, now);
    return { version: 1, type: "anyroute.agent.record-certificate", pseudonym: randomBytes(32).toString("hex"), claims, issued_at: now.toISOString(), expires_at: new Date(now.getTime() + RECORD_CERTIFICATE_TTL_MS).toISOString(), notice: RECORD_CERTIFICATE_NOTICE };
  });
}

// ---- Portable track record (v6 I4) ---------------------------------------------------------------------------------
// The same router-signed idea as above, over aggregates instead of claims, plus a Merkle root over the key's anchored
// receipt leaves: anyone holding one of those receipts can check it is counted (GET .../track-records/:id/proof) and
// that its leaf sits in an hourly anchor root. The payload is also what an ERC-8004 validation entry commits to.

export const TRACK_RECORD_MAX_RECEIPTS = 100_000;

/** The counted receipts: this key's generations with a v1 anchor leaf in an anchor up to `maxAnchorIndex`. */
export async function trackRecordLeaves(db: Db | Tx, keyHash: string, maxAnchorIndex: number) {
  const rows = await db.select({ id: generations.id, leaf: generations.receiptLeaf, cost: generations.cost, ts: generations.ts, anchorIndex: generations.anchorIndex })
    .from(generations)
    .where(sql`${generations.keyHash} = ${keyHash} and ${generations.receiptLeaf} is not null and ${generations.anchorIndex} is not null and ${generations.anchorIndex} <= ${maxAnchorIndex}`)
    .limit(TRACK_RECORD_MAX_RECEIPTS + 1);
  const byLeaf = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byLeaf.set(r.leaf!.toLowerCase(), r);
  const leaves = [...byLeaf.keys()].sort() as Hex[];
  return { rows: [...byLeaf.values()], leaves, byLeaf, truncated: rows.length > TRACK_RECORD_MAX_RECEIPTS };
}

export async function trackRecordPayload(db: Db, cfg: Config, key: KeyRow, agent: TrackRecordPayload["agent"]): Promise<TrackRecordPayload> {
  return db.transaction(async tx => {
    const now = new Date();
    const [top] = await tx.select({ index: sql<number | null>`max(${anchors.index})` }).from(anchors);
    const maxAnchor = top?.index == null ? null : Number(top.index);
    const counted = maxAnchor == null ? { rows: [], leaves: [] as Hex[], truncated: false } : await trackRecordLeaves(tx, key.keyHash, maxAnchor);
    if (counted.truncated) fail(422, `A track record covers at most ${TRACK_RECORD_MAX_RECEIPTS} receipts.`, "track_record_too_large");
    const indexes = new Set(counted.rows.map(r => r.anchorIndex!));
    // Subqueries over the same counted set, not id lists: a large record would exceed the bind-parameter limit.
    const countedIds = sql`(select ${generations.id} from ${generations} where ${generations.keyHash} = ${key.keyHash} and ${generations.receiptLeaf} is not null and ${generations.anchorIndex} is not null and ${generations.anchorIndex} <= ${maxAnchor ?? -1})`;
    let refunded = 0;
    if (counted.rows.length) {
      const [r] = await tx.select({ n: sql<string>`count(distinct ${ledger.generationId})` }).from(ledger).where(and(eq(ledger.kind, "refund"), sql`${ledger.generationId} in ${countedIds}`));
      refunded = Number(r?.n ?? 0);
    }
    const status = { confirmed: 0, local: 0, pending: 0 };
    if (indexes.size) for (const a of await tx.select({ index: anchors.index, status: anchors.status }).from(anchors).where(sql`${anchors.index} in (select distinct ${generations.anchorIndex} from ${generations} where ${generations.id} in ${countedIds})`)) {
      if (!indexes.has(a.index)) continue;
      if (a.status === "confirmed") status.confirmed++; else if (a.status === "local") status.local++; else status.pending++;
    }
    let agreements = 0, disputed = 0;
    if (cfg.agreements.enabled) {
      const [account] = await tx.select({ wallet: accounts.wallet }).from(accounts).where(eq(accounts.id, key.accountId));
      const wallet = account?.wallet?.toLowerCase();
      if (wallet) {
        const [r] = await tx.select({ total: sql<string>`count(*)`, disputed: sql<string>`count(*) filter (where ${agreementProjection.data}->>'dispute' is not null)` }).from(agreementProjection)
          .where(and(eq(agreementProjection.scope, agreementScope(cfg)), eq(agreementProjection.kind, "agreement"), sql`(${agreementProjection.data}->>'payer' = ${wallet} or ${agreementProjection.data}->>'payee' = ${wallet})`));
        agreements = Number(r?.total ?? 0); disputed = Number(r?.disputed ?? 0);
      }
    }
    const spend = counted.rows.reduce((s, r) => s + r.cost, 0n);
    const times = counted.rows.map(r => r.ts.getTime()).sort((a, b) => a - b);
    const receipts = counted.leaves.length;
    return {
      version: 1, type: TRACK_RECORD_TYPE, pseudonym: randomBytes(32).toString("hex"), agent,
      stats: { receipts, spend_usd: picoToUsdString(spend), refunded_receipts: refunded, refund_rate_bps: rateBps(refunded, receipts), agreements, disputed_agreements: disputed, dispute_rate_bps: rateBps(disputed, agreements),
        first_receipt_at: times.length ? new Date(times[0]).toISOString() : null, last_receipt_at: times.length ? new Date(times.at(-1)!).toISOString() : null },
      merkle: { root: receipts ? (new MerkleTree(counted.leaves).root.toLowerCase() as Hex) : null, leaf_count: receipts, tree: TRACK_RECORD_TREE, max_anchor_index: maxAnchor,
        anchors: { count: indexes.size, ...status }, receipt_anchor: { chain_id: cfg.chain.id, contract: cfg.chain.receiptAnchor?.toLowerCase() ?? null } },
      issued_at: now.toISOString(), expires_at: new Date(now.getTime() + TRACK_RECORD_TTL_MS).toISOString(), notice: TRACK_RECORD_NOTICE,
    };
  }, { isolationLevel: "repeatable read" });
}
