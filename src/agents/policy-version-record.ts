// D144: callers hold the account lock and use the rulebook change's transaction.
import type { Tx } from "../db/client.ts";
import type { AgentPolicy } from "./policy.ts";
import { agentPolicySha256 } from "./policy.ts";
import { policyVersions } from "./policy-versions-schema.ts";

export async function recordPolicyVersion(tx: Tx, keyHash: string, spec: AgentPolicy, savedBy: string, source: typeof policyVersions.$inferInsert.source, savedAt = new Date()) {
  await tx.insert(policyVersions).values({ keyHash, spec, sha256: agentPolicySha256(spec), savedBy, source, savedAt });
}
