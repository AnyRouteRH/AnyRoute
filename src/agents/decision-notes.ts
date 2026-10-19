// K186: owner-written text stays on the approval and its existing event chain.
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { agentApprovals } from "./approval-schema.ts";
import type { ApprovalRow } from "./approvals.ts";
import { assertDecisionApprover } from "./approvers.ts";
import { appendEvent, lockAccount, policiesFor } from "./store.ts";

export function decisionNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Array.from(value).length > 280 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    fail(400, "Use plain text up to 280 characters for the decision note.");
  return value.trim() || null;
}
export const readDecisionNote = async (c: Context) => decisionNote((await readJson(c)).decision_note);
export const decisionNoteFields = (row: Pick<ApprovalRow, "decisionNote" | "status">) => row.decisionNote ? {
  decision_note: row.decisionNote,
  ...(row.status === "denied" ? { message: `Denied by your owner: ${row.decisionNote}` } : {}),
} : {};
export const decisionNoteReasons = (row: Pick<ApprovalRow, "decisionNote">) => row.decisionNote ? [{ code: "decision_note", message: row.decisionNote }] : [];

/** Telegram may attach one note just after deciding. Caller holds its link lock; recheck decision authority. */
export async function attachDecisionNote(db: Db, tx: Tx, account: string, id: string, actor: string, note: string) {
  const value = decisionNote(note);
  if (!value) fail(400, "Write a note, or send /skip.");
  await lockAccount(tx, account);
  const [row] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, id)).for("update");
  if (!row || !row.decidedAt || row.decidedBy !== actor || row.decisionNote) fail(409, "This decision can no longer receive a note.");
  await assertDecisionApprover(db, tx, account, actor, row.keyHash);
  const [updated] = await tx.update(agentApprovals).set({ decisionNote: value }).where(and(eq(agentApprovals.id, id), eq(agentApprovals.decidedBy, actor))).returning();
  const policies = await policiesFor(tx, row.keyHash);
  await appendEvent(tx, { keyHash: row.keyHash, kind: "approval_note_added", reasons: decisionNoteReasons(updated), intent: row.intent, policySha256: policies[0]?.sha256 ?? "" });
  return updated;
}
