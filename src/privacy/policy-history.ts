// D144: retained rules, including the owner's readable labels, not inference bodies.
import type { ExternalDoc, TableDoc } from "./types.ts";
import { rv } from "./tables/common.ts";

export function describePolicyHistory(tables: Record<string, TableDoc>) {
  tables.agent_policies.notes = [...(tables.agent_policies.notes ?? []), "D144: Saving replacements also appends full rules to policy_versions; removing the current rulebook does not remove those revisions."];
  tables.policy_versions = {
    category: "keys", purpose: "Saved revisions of each key's rulebook, copied atomically when its rules are saved, restored, allowed next time or copied from a playbook.", request: "no",
    retention: "Until operator deletion, including after removal of the current rulebook. The migration copies the current rules only; it cannot recover earlier versions.",
    notes: ["Readable rulebooks include owner-written model, tool, action and target labels. Shape checks cannot judge the meaning an owner gives a label. No inference prompt or answer fields are accepted. Backfilled date and actor use the current row's last update, which can be a Stop or Resume."],
    columns: {
      id: "Monotonically allocated revision identifier; repeated saves of the same digest remain separate revisions.",
      key_hash: "The API key governed by this saved rulebook.",
      sha256: "SHA-256 of the canonical rulebook JSON.",
      spec: { purpose: "Complete strict rulebook as saved, including caps, models, lanes, tools, hours, approvals, actions and optional rules.", review: rv(["type:json"], "config", "The strict rulebook schema excludes inference prompt and answer fields; owner-written labels remain readable and may carry whatever meaning the owner chooses.") },
      saved_at: "When the revision was retained; for the migration copy, the current rulebook row's last update time.",
      saved_by: "Hash of the principal key that saved this revision; backfill uses the current row's last updater.",
      source: "save, approve_and_allow, restore or playbook; backfill uses save for own rules and playbook for following keys.",
    },
  };
}

export function describePolicyHistoryReaders(readers: ExternalDoc["bodyReaders"]) {
  for (const reader of readers) {
    if (!["src/api/agents.ts", "src/api/agent-approve-and-allow.ts", "src/api/playbooks.ts"].includes(reader.file)) continue;
    reader.kept = reader.kept.replace("No new tables, columns, Redis families, log fields or address readers.", "No new Redis families, log fields or address readers.") + " D144: Each rulebook save or playbook copy also retains its full readable rules, digest, date, saving key hash and source in policy_versions, in the same transaction. These revisions remain until operator deletion, including after the current rulebook is removed.";
  }
}

export const policyHistoryBodyReader = {
  file: "src/api/agent-policy-history.ts", carries: "settings" as const,
  reads: "A strict object containing only a 64-character rulebook SHA-256 to restore from the target key's history.",
  then: "Requires the same owner/admin, management, account and team permissions as PUT policy. Validates saved rules and digest, refuses following playbook keys, and atomically appends a revision and a policy_set event while keeping Stop state.",
  kept: "Full readable saved rules, digest, time, saving key hash and change source in policy_versions. The current rulebook in agent_policies and its digest in the existing event chain. No new Redis families, log fields or address readers. Ordinary request text remains readable by the router in memory.",
  evidence: [{ file: "src/api/agent-policy-history.ts", contains: "restoreBody.parse(await readJson(c))" }],
};
