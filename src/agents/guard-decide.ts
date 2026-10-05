import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Tx } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import { usdToPico } from "../lib/money.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import type { guardDecideInput } from "./guard-input.ts";
import { agentActionDecisions } from "./guard-schema.ts";
import { approvalRequest } from "./approvals.ts";
import { recordDecisions, prepareApproval } from "./enforce.ts";
import { appendEvent, lockAccount, policiesFor } from "./store.ts";
import { intentJson, type AgentIntent } from "./policy.ts";

export type GuardDecideBody = z.infer<typeof guardDecideInput>;
export type GuardDecision = { decision: "allow" | "deny" | "approval_required"; decision_id: string; policy_sha256: string; now: Date };

/**
 * One Agent Guard decision for `key`, recorded and signed exactly as POST /api/v1/guard/decide does. `onDecided` runs in
 * the same transaction after the decision row is written, so a caller can attach its own record to it atomically.
 */
export async function guardDecide(ctx: Ctx, key: KeyRow, body: GuardDecideBody, onDecided?: (tx: Tx, d: GuardDecision) => Promise<void>) {
  const intent: AgentIntent = { kind: "action", action: body.action, amount_pico: usdToPico(body.amount_usd, "ceil"), ...(body.target === undefined ? {} : { target: body.target }), ...(body.details_sha256 === undefined ? {} : { details_sha256: body.details_sha256 }) };
  return approvalRequest.run(body.approval_id, () => ctx.db.transaction(async tx => {
    await lockAccount(tx, key.accountId);
    const rows = await policiesFor(tx, key.keyHash), now = new Date();
    const refusal = rows.length ? await recordDecisions(tx, rows, [intent], key.keyHash, now) : undefined;
    const approval = rows.length ? await prepareApproval(ctx.db, tx, rows, [intent], key.keyHash, refusal, now) : {};
    const error = approval.error;
    const decision = !rows.length ? "deny" : error ? error.type === "agent_approval_required" ? "approval_required" : "deny" : "allow";
    const reasons = !rows.length ? [{ code: "no_rulebook", message: "No rulebook is configured for this key." }] : error ? (error.metadata?.reasons ?? [{ code: error.type, message: error.message }]) : [];
    // A session can inherit several rulebooks. The single digest binds their sorted hashes.
    const policy_sha256 = rows.length === 1 ? rows[0]!.sha256 : rows.length ? sha256(canonicalJson(rows.map(r => r.sha256).sort())) : "";
    if (decision === "allow") await approval.use?.();
    const decision_id = randomBytes(18).toString("base64url");
    const entry = await appendEvent(tx, { keyHash: key.keyHash, kind: "action_decision", decision, reasons, intent: { ...intentJson(intent), decision_id }, policySha256: policy_sha256 }, now);
    await tx.insert(agentActionDecisions).values({ id: decision_id, keyHash: key.keyHash, eventId: entry.id, action: body.action, target: body.target, amountPico: intent.amount_pico, detailsSha256: body.details_sha256, decision, createdAt: now });
    await onDecided?.(tx, { decision, decision_id, policy_sha256, now });
    const payload = { type: "anyroute.guard.decision.v1", decision_id, key_hash: key.keyHash, intent: intentJson(intent), decision, reasons, policy_sha256, ts: now.toISOString() };
    const signed = ctx.signer.sign(payload);
    const metadata = error?.metadata;
    return { decision, reasons, decision_id, policy_sha256, ...(decision === "approval_required" ? { approval_id: metadata?.approval_id, expires_at: metadata?.expires_at, poll: metadata?.poll } : {}), signed: { payload, alg: "Ed25519", key_id: signed.keyId, sig: signed.sig } };
  }));
}

type DecisionRow = typeof agentActionDecisions.$inferSelect;
/** Record an allowed decision's outcome once, on the decision chain. The caller holds the account lock and the row. */
export async function recordGuardOutcome(tx: Tx, keyHash: string, row: DecisionRow, status: "executed" | "skipped" | "failed", amount: bigint | null, now: Date) {
  const over_allowed = amount !== null && amount > row.amountPico;
  await tx.update(agentActionDecisions).set({ outcomeStatus: status, outcomeAmountPico: amount, outcomeAt: now }).where(eq(agentActionDecisions.id, row.id));
  const rows = await policiesFor(tx, keyHash);
  await appendEvent(tx, { keyHash, kind: "action_outcome", intent: { decision_id: row.id, status, amount_pico: amount?.toString() ?? null, over_allowed }, policySha256: rows[0]?.sha256 ?? "" }, now);
  return { decision_id: row.id, status, amount_pico: amount?.toString() ?? null, over_allowed };
}
