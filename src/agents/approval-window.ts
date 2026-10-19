// K194: opt-in, account-locked allowances in the existing approval settings store.
import { and, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { keys, kv } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { keyActor, recordSecurity } from "../security-alerts/records.ts";
import { approvalIdentity, canApprove } from "./approvers.ts";
import { ledgerApproval } from "./ledger-context.ts";
import { agentApprovals } from "./approval-schema.ts";
import { approvalIntentHash, approvalStatus, decideApproval, type ApprovalRow } from "./approvals.ts";
import { agentIntentSchema, intentJson, type AgentIntent } from "./policy.ts";
import { agentPolicyEvents } from "./schema.ts";
import { appendEvent, lockAccount, policiesFor, type PolicyRow } from "./store.ts";

type Window = { id: string; until: string; actor: string; binding: string; rules: string; policies: string };
export const approvalWindowKey = (hash: string) => `agent-approval-window:${hash}`;
const policyBinding = (rows: PolicyRow[]) => sha256(canonicalJson(rows.map(r => [r.keyHash, r.sha256]).sort()));
export function windowBinding(value: unknown): string {
  const raw = value as { intents?: unknown[] };
  const intents = (raw.intents ?? [value]).map(i => agentIntentSchema.parse(i));
  return sha256(canonicalJson(intents.map(i => i.kind === "inference"
    ? { kind: i.kind, model: i.model, lane: i.lane, tools: [...new Set(i.tools)].sort() }
    : i.kind === "action" ? { kind: i.kind, action: i.action, target: i.target ?? null } : { kind: i.kind }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))));
}
async function rulesAt(db: Db | Tx, rows: PolicyRow[], intents: AgentIntent[], at: Date) {
  if (!rows.length || !intents.length || !(intents.every(i => i.kind === "inference") || intents.length === 1 && intents[0].kind === "action")) return null;
  const events = await db.select().from(agentPolicyEvents).where(and(inArray(agentPolicyEvents.keyHash, rows.map(r => r.keyHash)), eq(agentPolicyEvents.ts, at), eq(agentPolicyEvents.kind, "decision")));
  const rules: string[] = [];
  let asked = false;
  for (const row of rows) for (const intent of intents) {
    const matching = events.filter(e => e.keyHash === row.keyHash && e.policySha256 === row.sha256 && approvalIntentHash([agentIntentSchema.parse(e.intent)]) === approvalIntentHash([intent]));
    if (!matching.length) return null;
    for (const event of matching) {
      const reasons = event.reasons as { code: string }[];
      if (event.decision === "deny" || reasons.some(r => r.code !== (intent.kind === "action" ? "approval_action_amount" : "approval_required"))) return null;
      if (event.decision === "approval_required") asked = true;
      rules.push(canonicalJson([row.keyHash, row.sha256, windowBinding(intent), reasons.map(r => r.code).sort()]));
    }
  }
  return asked ? sha256(canonicalJson([...new Set(rules)].sort())) : null;
}
async function readWindows(db: Db | Tx, hash: string, now: Date, rows?: PolicyRow[]) {
  const [saved] = await db.select().from(kv).where(eq(kv.key, approvalWindowKey(hash)));
  const policies = policyBinding(rows ?? await policiesFor(db, hash));
  return ((saved?.value as { windows?: Window[] } | undefined)?.windows ?? []).filter(w => Date.parse(w.until) > now.getTime() && w.policies === policies);
}
export const windowText = (until: string, now = new Date()) => `Approved for the next ${Math.max(1, Math.ceil((Date.parse(until) - now.getTime()) / 60_000))} minutes`;
export async function approvalWindowView(db: Db | Tx, hash: string, now = new Date(), intent?: unknown) {
  const windows = await readWindows(db, hash, now);
  return windows.filter(w => intent === undefined || w.binding === windowBinding(intent)).map(w => ({ id: w.id, until: w.until, text: windowText(w.until, now) }));
}
export async function matchesApprovalWindow(db: Db | Tx, rows: PolicyRow[], intents: AgentIntent[], hash: string, now: Date, approvalId?: string) {
  const windows = (await readWindows(db, hash, now, rows)).filter(w => approvalId === undefined || w.id === approvalId);
  const binding = windowBinding({ intents });
  if (!windows.some(w => w.binding === binding)) return undefined;
  const rules = await rulesAt(db, rows, intents, now);
  return rules ? windows.find(w => w.binding === binding && w.rules === rules) : undefined;
}
export async function recordApprovalWindowUse(tx: Tx, window: Window, rows: PolicyRow[], intents: AgentIntent[], hash: string, now: Date) {
  await tx.update(agentApprovals).set({ status: "used", usedAt: now }).where(and(eq(agentApprovals.id, window.id), eq(agentApprovals.status, "approved")));
  ledgerApproval(window.id, "approval_used");
  const projected = intents.map(intentJson);
  await appendEvent(tx, { keyHash: hash, kind: "approval_used", intent: projected.length === 1 ? projected[0] : { intents: projected }, policySha256: rows[0]?.sha256 ?? "" }, now);
}
export async function assertWindowManager(ctx: Ctx, db: Db | Tx, actorHash: string, hash: string) {
  const [actor] = await db.select().from(keys).where(eq(keys.keyHash, actorHash)).for("share");
  const [key] = await db.select().from(keys).where(eq(keys.keyHash, hash)).for("share");
  if (!actor || !key || actor.accountId !== key.accountId) fail(404, "Key not found.", "not_found");
  const who = await approvalIdentity(db, actor);
  if (!["owner", "admin"].includes(who.role) || actor.keyHash === key.keyHash || !actor.management && (!actor.teamId || actor.teamId !== key.teamId)) fail(403, "Only owners and admins can manage approval hours.", "forbidden");
  if (ctx.cfg.agentTeamApproversEnabled && !await canApprove(db, actor, key)) fail(403, "You cannot decide this agent's requests.", "forbidden");
  return { actor, key };
}
export async function previewApprovalWindow(db: Db | Tx, row: ApprovalRow) {
  if (approvalStatus(row).status !== "pending" || row.usedAt) fail(409, "Approval is no longer pending.", "agent_approval_unavailable");
  const intents = ((row.intent as { intents?: unknown[] }).intents ?? [row.intent]).map(i => agentIntentSchema.parse(i));
  const rows = await policiesFor(db, row.keyHash), rules = await rulesAt(db, rows, intents, row.requestedAt);
  if (!rules) fail(409, "Only the current rulebook's ask-first amount can be approved for an hour. Request approval again if the rules changed.", "approval_window_unavailable");
  const policies = policyBinding(rows), binding = windowBinding(row.intent);
  return { rules, policies, binding, confirmation: sha256(canonicalJson([row.id, rules, policies, binding])) };
}
export async function approveForHour(ctx: Ctx, account: string, id: string, actorHash: string, confirmation?: string, transaction?: Tx) {
  const run = async (tx: Tx) => {
    await lockAccount(tx, account);
    const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, id)).for("update");
    if (!row) fail(404, "Approval not found.", "not_found");
    const { actor, key } = await assertWindowManager(ctx, tx, actorHash, row.keyHash);
    if (key.accountId !== account) fail(404, "Key not found.", "not_found");
    if ((row.intent as { kind?: string }).kind === "action" && !ctx.cfg.agentGuardEnabled) fail(404, "Not found.", "not_found");
    const preview = await previewApprovalWindow(tx, row);
    if (confirmation !== undefined && confirmation !== preview.confirmation) fail(409, "The rulebook changed. Review this approval again.", "policy_changed");
    const now = new Date(), until = new Date(now.getTime() + 3_600_000).toISOString();
    const windows = (await readWindows(tx, row.keyHash, now)).filter(w => w.binding !== preview.binding);
    if (windows.length >= 64) fail(409, "End an approval hour before adding another.", "approval_window_limit");
    const window: Window = { id, until, actor: actorHash, binding: preview.binding, rules: preview.rules, policies: preview.policies };
    // Cap before deciding so the existing webhook also carries the actual deadline.
    if (row.expiresAt > new Date(until)) await tx.update(agentApprovals).set({ expiresAt: new Date(until) }).where(eq(agentApprovals.id, id));
    const approved = await decideApproval(ctx.db, account, id, actorHash, "approve", tx);
    windows.push(window);
    await tx.insert(kv).values({ key: approvalWindowKey(row.keyHash), value: { windows } }).onConflictDoUpdate({ target: kv.key, set: { value: { windows }, updatedAt: now } });
    await appendEvent(tx, { keyHash: row.keyHash, kind: "approval_window_started", intent: { approval_id: id, until, actor: actorHash }, policySha256: preview.policies }, now);
    await recordSecurity(ctx, tx, account, key.teamId, `Approved requests for the next hour for agent ${keyActor(key.name).slice(7)} ${keyActor(actor.name)}`, `approval-window:${id}`);
    return { approval: approved, window: { id, until, text: windowText(until, now) } };
  };
  return transaction ? run(transaction) : ctx.db.transaction(run);
}
export async function endApprovalWindow(ctx: Ctx, account: string, hash: string, id: string, actorHash: string) {
  return ctx.db.transaction(async tx => {
    await lockAccount(tx, account);
    const { key, actor } = await assertWindowManager(ctx, tx, actorHash, hash);
    const now = new Date(), windows = await readWindows(tx, hash, now);
    if (!windows.some(w => w.id === id)) fail(404, "Approval hour not found.", "not_found");
    await tx.update(kv).set({ value: { windows: windows.filter(w => w.id !== id) }, updatedAt: now }).where(eq(kv.key, approvalWindowKey(hash)));
    // Ending early also withdraws the unused original single-use approval.
    await tx.update(agentApprovals).set({ status: "denied" }).where(and(eq(agentApprovals.id, id), eq(agentApprovals.keyHash, hash), eq(agentApprovals.status, "approved")));
    await appendEvent(tx, { keyHash: hash, kind: "approval_window_ended", intent: { approval_id: id, actor: actorHash }, policySha256: policyBinding(await policiesFor(tx, hash)) }, now);
    await recordSecurity(ctx, tx, account, key.teamId, `Ended the approval hour early for agent ${keyActor(key.name).slice(7)} ${keyActor(actor.name)}`, `approval-window-ended:${id}`);
    return { id, ended: true };
  });
}
