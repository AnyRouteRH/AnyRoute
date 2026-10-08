// D144: readable differences use the same formatter as the current rulebook.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { fail } from "../lib/errors.ts";
import { agentPolicySchema, agentPolicySha256, type AgentPolicy } from "./policy.ts";
import { policyVersions } from "./policy-versions-schema.ts";
import { recordPolicyVersion } from "./policy-version-record.ts";
import { rulebookWords } from "./rulebook-words.ts";
import { agentPolicies } from "./schema.ts";
import { appendEvent, assertOwnRulebook, lockAccount } from "./store.ts";

export function rulebookDiff(before: AgentPolicy | null, after: AgentPolicy) {
  const previous = before ? rulebookWords(before) : [], next = rulebookWords(after);
  return { added: next.filter(line => !previous.includes(line)), removed: previous.filter(line => !next.includes(line)) };
}

export async function policyHistory(db: Db, keyHash: string) {
  // Read one extra so the last displayed version still compares with its predecessor.
  const rows = await db.select().from(policyVersions).where(eq(policyVersions.keyHash, keyHash)).orderBy(desc(policyVersions.id)).limit(51);
  return rows.slice(0, 50).map((row, index) => ({
    id: row.id, key_hash: row.keyHash, sha256: row.sha256, spec: row.spec,
    saved_at: row.savedAt.toISOString(), saved_by: row.savedBy, source: row.source,
    diff: rulebookDiff(rows[index + 1]?.spec ?? null, row.spec),
  }));
}

export async function restorePolicy(db: Db, accountId: string, keyHash: string, sha256: string, actor: string) {
  return db.transaction(async tx => {
    await lockAccount(tx, accountId);
    await assertOwnRulebook(tx, keyHash);
    const [version] = await tx.select().from(policyVersions).where(and(eq(policyVersions.keyHash, keyHash), eq(policyVersions.sha256, sha256))).orderBy(desc(policyVersions.id)).limit(1);
    if (!version) fail(404, "Rulebook version not found.", "not_found");
    const policy = agentPolicySchema.parse(version.spec);
    if (agentPolicySha256(policy) !== sha256) fail(409, "This saved rulebook does not match its fingerprint.", "policy_version_invalid");
    const now = new Date();
    const values = { version: policy.version, spec: policy, sha256, updatedBy: actor, updatedAt: now };
    const [row] = await tx.insert(agentPolicies).values({ keyHash, ...values }).onConflictDoUpdate({ target: agentPolicies.keyHash, set: values }).returning();
    await recordPolicyVersion(tx, keyHash, policy, actor, "restore", now);
    await appendEvent(tx, { keyHash, kind: "policy_set", policySha256: sha256 }, now);
    return { key_hash: keyHash, policy: row.spec, sha256: row.sha256, version: row.version };
  });
}
