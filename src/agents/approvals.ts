import { ledgerApproval } from "./ledger-context.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { agentApprovals } from "./approval-schema.ts";
import { intentJson, type AgentIntent } from "./policy.ts";
import { appendEvent, lockAccount, policiesFor, type PolicyRow } from "./store.ts";

export type ApprovalRow = typeof agentApprovals.$inferSelect;
// In-process adapters inherit the originating header without changing their billing or receipt paths.
export const approvalRequest = new AsyncLocalStorage<string | undefined>();
const ttl = new WeakMap<Db, number>();
export const configureApprovals = (db: Db, seconds: number) => ttl.set(db, seconds);
const statusAt = (r: ApprovalRow, now: Date) => ["pending", "approved"].includes(r.status) && r.expiresAt <= now ? "expired" : r.status;
export const approvalStatus = (r: ApprovalRow, now = new Date()) => ({ id: r.id, status: statusAt(r, now), expires_at: r.expiresAt.toISOString() });
export const approvalJson = (r: ApprovalRow) => ({ ...approvalStatus(r), key_hash: r.keyHash, intent: r.intent, intent_hash: r.intentHash, max_cost_pico: r.maxCostPico.toString(), requested_at: r.requestedAt.toISOString(), decided_at: r.decidedAt?.toISOString() ?? null, decided_by: r.decidedBy, used_at: r.usedAt?.toISOString() ?? null });
// Explicit projection: the caller's messages, descriptions and tool arguments never enter storage.
function project(intents: AgentIntent[], cost = true) {
  const rows = intents.map(i => i.kind === "inference" ? {
    kind: i.kind, model: i.model, lane: i.lane, ...(cost ? { est_cost_pico: i.est_cost_pico.toString() } : {}),
    ...(i.max_output_tokens === undefined ? {} : { max_output_tokens: i.max_output_tokens }), tools: [...new Set(i.tools)].sort(),
  } : intentJson(i)).sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
  return rows.length === 1 ? rows[0] : { intents: rows };
}
export const approvalIntentHash = (intents: AgentIntent[]) => sha256(canonicalJson(project(intents)));
function binding(value: unknown): string {
  const copy = JSON.parse(JSON.stringify(value));
  for (const i of copy.intents ?? [copy]) delete i.est_cost_pico;
  return canonicalJson(copy);
}
export async function expireApprovals(tx: Db | Tx, keyHash: string, now = new Date()) {
  await tx.update(agentApprovals).set({ status: "expired" }).where(and(eq(agentApprovals.keyHash, keyHash), inArray(agentApprovals.status, ["pending", "approved"]), lte(agentApprovals.expiresAt, now)));
}
async function event(tx: Db | Tx, row: ApprovalRow, kind: string, rows?: PolicyRow[], now = new Date()) {
  ledgerApproval(row.id, kind);
  const policies = rows ?? await policiesFor(tx, row.keyHash);
  await appendEvent(tx, { keyHash: row.keyHash, kind, intent: row.intent, policySha256: policies[0]?.sha256 ?? "" }, now);
}
/** Caller holds the account lock. Validate before reserving; consume only after the reservation succeeds. */
export async function prepareApproval(db: Db, tx: Tx, rows: PolicyRow[], intents: AgentIntent[], keyHash: string, refusal: ApiError | undefined, now: Date): Promise<{ error?: ApiError; use?: () => Promise<void> }> {
  if (refusal && refusal.type !== "agent_approval_required") return { error: refusal };
  const id = approvalRequest.getStore();
  if (!refusal && id === undefined) return {};
  const cost = intents.reduce((max, i) => i.kind === "inference" && i.est_cost_pico > max ? i.est_cost_pico : max, 0n);
  await expireApprovals(tx, keyHash, now);
  if (id !== undefined) {
    const [row] = await tx.select().from(agentApprovals).where(and(eq(agentApprovals.id, id), eq(agentApprovals.keyHash, keyHash))).for("update");
    if (!row || row.status !== "approved" || row.expiresAt <= now || row.usedAt || cost > row.maxCostPico || binding(row.intent) !== canonicalJson(project(intents, false))) {
      return { error: new ApiError(403, "Approval is unavailable or does not match this intent.", "agent_approval_invalid") };
    }
    return { use: async () => {
      const [used] = await tx.update(agentApprovals).set({ status: "used", usedAt: now }).where(and(eq(agentApprovals.id, id), eq(agentApprovals.status, "approved"), gt(agentApprovals.expiresAt, now))).returning();
      if (!used) fail(403, "Approval is unavailable.", "agent_approval_invalid");
      await event(tx, used, "approval_used", rows, now);
    } };
  }
  if (!refusal) return {};
  const intentHash = approvalIntentHash(intents);
  let [row] = await tx.select().from(agentApprovals).where(and(eq(agentApprovals.keyHash, keyHash), eq(agentApprovals.intentHash, intentHash), eq(agentApprovals.status, "pending"), gt(agentApprovals.expiresAt, now))).limit(1);
  if (!row) {
    [row] = await tx.insert(agentApprovals).values({ id: randomBytes(18).toString("base64url"), keyHash, intent: project(intents), intentHash, maxCostPico: cost, requestedAt: now, expiresAt: new Date(now.getTime() + (ttl.get(db) ?? 900) * 1000) }).returning();
    await event(tx, row, "approval_requested", rows, now);
  }
  return { error: new ApiError(403, refusal.message, refusal.type, { ...refusal.metadata, approval_id: row.id, expires_at: row.expiresAt.toISOString(), poll: `/api/v1/agents/approvals/${row.id}` }) };
}
export async function decideApproval(db: Db, accountId: string, id: string, actor: string, action: "approve" | "deny") {
  return db.transaction(async tx => {
    await lockAccount(tx, accountId);
    const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, id)).for("update");
    if (!row) fail(404, "Approval not found.", "not_found");
    const now = new Date();
    if (statusAt(row, now) !== "pending") fail(409, "Approval is no longer pending.", "agent_approval_unavailable");
    const [updated] = await tx.update(agentApprovals).set({ status: action === "approve" ? "approved" : "denied", decidedAt: now, decidedBy: actor }).where(eq(agentApprovals.id, id)).returning();
    await event(tx, updated, action === "approve" ? "approval_approved" : "approval_denied", undefined, now);
    return updated;
  });
}
