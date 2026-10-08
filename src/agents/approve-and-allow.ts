// B118: reuse the approval decision and policy hash chain under one account lock.
import { and, eq } from "drizzle-orm";
import { recordPolicyVersion } from "./policy-version-record.ts"; // D144
import type { Db, Tx } from "../db/client.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { agentApprovals } from "./approval-schema.ts";
import { approvalIntentHash, approvalStatus, decideApproval, type ApprovalRow } from "./approvals.ts";
import { agentIntentSchema, agentPolicySchema, agentPolicySha256, type AgentPolicy } from "./policy.ts";
import { agentPolicies, agentPolicyEvents, playbooks } from "./schema.ts";
import { appendEvent, lockAccount } from "./store.ts";

export function amountThresholdChange(policy: AgentPolicy, intent: unknown, amount: bigint) {
  const raw = intent as { intents?: unknown[] };
  const intents = (raw?.intents ?? [intent]).map(i => agentIntentSchema.parse(i));
  const action = intents.length === 1 && intents[0].kind === "action";
  if (!action && !intents.every(i => i.kind === "inference")) fail(409, "Only amount-based model calls and actions can allow next time.", "approval_not_amount");
  const before = action ? policy.actions?.approval_above_usd : policy.approval?.above_usd;
  if (before === undefined || amount <= usdToPico(before)) fail(409, "This request no longer exceeds its ask-first amount.", "approval_not_amount");
  const cents = (amount + 9_999_999_999n) / 10_000_000_000n;
  if (cents > 100_000_000n) fail(409, "This amount exceeds the rulebook's supported threshold.", "approval_not_amount");
  const after = Number(cents) / 100;
  const policyNext = agentPolicySchema.parse(action ? { ...policy, actions: { ...policy.actions, approval_above_usd: after } } : { ...policy, approval: { ...policy.approval, above_usd: after } });
  return { policy: policyNext, intents, reason: action ? "approval_action_amount" : "approval_required", field: action ? "actions.approval_above_usd" : "approval.above_usd", before_usd: String(before), after_usd: picoToUsdString(cents * 10_000_000_000n), amount_usd: picoToUsdString(amount) };
}

export async function previewAllow(tx: Db | Tx, row: ApprovalRow) {
  if (approvalStatus(row).status !== "pending" || row.usedAt) fail(409, "Approval is no longer pending.", "agent_approval_unavailable");
  const [own] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, row.keyHash));
  if (!own) fail(409, "This agent needs its own rulebook to allow next time.", "approval_not_amount");
  if (own.playbookId) {
    const [book] = await tx.select().from(playbooks).where(eq(playbooks.id, own.playbookId));
    fail(409, `This agent follows the playbook ${book?.name ?? "Unknown"}; change it there.`, "playbook_linked", { playbook_id: own.playbookId, playbook_name: book?.name ?? "Unknown" });
  }
  const change = amountThresholdChange(own.spec, row.intent, row.maxCostPico);
  // Read the original decision reasons, including call-count reasons. Existing approval responses stay byte-identical.
  const decisions = await tx.select().from(agentPolicyEvents).where(and(eq(agentPolicyEvents.keyHash, row.keyHash), eq(agentPolicyEvents.ts, row.requestedAt), eq(agentPolicyEvents.kind, "decision")));
  for (const intent of change.intents) {
    const decision = decisions.find(d => d.decision === "approval_required" && d.policySha256 === own.sha256 && approvalIntentHash([agentIntentSchema.parse(d.intent)]) === approvalIntentHash([intent]));
    const reasons = decision?.reasons as { code: string }[] | undefined;
    if (!reasons?.length || reasons.some(r => r.code !== change.reason)) fail(409, "Only approvals for the current rulebook's ask-first amount can allow next time. Request approval again if the rules changed.", "approval_not_amount");
  }
  return { own, change, data: { field: change.field, before_usd: change.before_usd, after_usd: change.after_usd, amount_usd: change.amount_usd, policy_sha256: own.sha256 } };
}

export async function approveAndAllow(db: Db, accountId: string, row: ApprovalRow, actor: string, expectedHash: string) {
  return db.transaction(async tx => {
    await lockAccount(tx, accountId);
    const [current] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, row.id)).for("update");
    if (!current) fail(404, "Approval not found.", "not_found");
    const preview = await previewAllow(tx, current);
    if (preview.own.sha256 !== expectedHash) fail(409, "The rulebook changed. Review the ask-first amount again.", "policy_changed");
    const policy = preview.change.policy, sha256 = agentPolicySha256(policy);
    await tx.update(agentPolicies).set({ spec: policy, version: policy.version, sha256, updatedBy: actor, updatedAt: new Date() }).where(eq(agentPolicies.keyHash, current.keyHash));
    await appendEvent(tx, { keyHash: current.keyHash, kind: "policy_set", policySha256: sha256 });
    await recordPolicyVersion(tx, current.keyHash, policy, actor, "approve_and_allow"); // D144
    const approved = await decideApproval(db, accountId, current.id, actor, "approve", tx);
    return { approved, change: preview.data, policy: { policy, version: policy.version, sha256 } };
  });
}
