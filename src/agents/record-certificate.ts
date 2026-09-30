import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { generations } from "../db/schema.ts";
import type { KeyRow } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { agentPolicyEvents } from "./schema.ts";
import { lockAccount, policiesFor } from "./store.ts";
import { RECORD_CERTIFICATE_NOTICE, RECORD_CERTIFICATE_TTL_MS, type RecordClaim, type RecordCertificate } from "../../packages/client/src/record-certificate.ts";

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
