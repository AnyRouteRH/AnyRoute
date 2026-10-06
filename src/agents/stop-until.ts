// B117: opt-in timed stops; callers serialize changes under the existing account lock.
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { agentPolicies } from "./schema.ts";
import { appendEvent, type PolicyRow } from "./store.ts";

export const MAX_STOP_MS = 30 * 86_400_000;
export const killBody = z.strictObject({ reason: z.string().max(160).optional(), until: z.iso.datetime({ offset: true }).refine(value => {
  const delta = Date.parse(value) - Date.now();
  return delta > 0 && delta <= MAX_STOP_MS;
}, "Choose a future stop time within 30 days.").optional() });
export const stopExpired = (row: { killed: boolean; killUntil?: Date | null }, now: Date) => row.killed && !!row.killUntil && row.killUntil.getTime() <= now.getTime();
// Omit the field on indefinite stops and running keys to preserve existing response bytes.
export const stopFields = (row: { killed: boolean; killUntil?: Date | null }) => row.killed && row.killUntil ? { stopped_until: row.killUntil.toISOString() } : {};
export function combinedStopFields(rows: { killed: boolean; stopped_until?: string }[]) {
  const stopped = rows.filter(row => row.killed);
  if (!stopped.length || stopped.some(row => !row.stopped_until)) return {};
  return { stopped_until: stopped.map(row => row.stopped_until!).sort().at(-1)! };
}
export const visibleStop = (row: PolicyRow, now: Date) => stopExpired(row, now) ? { ...row, killed: false, killUntil: null, killedAt: null, killedReason: null } : row;

/** Clear and append in the same checking transaction. The conditional update also protects stale rows. */
export async function resumeScheduled(tx: Db | Tx, row: PolicyRow, now: Date) {
  if (!stopExpired(row, now)) return;
  const [updated] = await tx.update(agentPolicies).set({ killed: false, killUntil: null, killedAt: null, killedReason: null, updatedAt: now, updatedBy: row.keyHash })
    .where(and(eq(agentPolicies.keyHash, row.keyHash), eq(agentPolicies.killed, true), lte(agentPolicies.killUntil, now))).returning();
  if (!updated) return;
  await appendEvent(tx, { keyHash: row.keyHash, kind: "resume", reasons: [{ code: "scheduled", message: "Scheduled stop ended." }], policySha256: updated.sha256 }, now);
  Object.assign(row, updated);
}
