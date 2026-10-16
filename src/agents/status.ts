// J176: compose existing metadata in one read-only snapshot; no report is stored.
import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import { agentApprovals } from "./approval-schema.ts";
import { policiesFor } from "./store.ts";
import { combinedStopFields, stopFields, visibleStop } from "./stop-until.ts";
import { workHoursCheck } from "./work-hours.ts";
import { readAgentRunway } from "./runway.ts";
import { lastQuietActivityForStatus, quietDue, readQuietSetting } from "./quiet-alerts.ts";

const guardReasons = new Set(["actions_not_configured", "action_not_allowed", "target_not_allowed", "over_action_per_request", "over_action_per_day", "over_action_per_hour"]);
export async function readAgentStatus(db: Db | Tx, key: KeyRow, options: { quiet: boolean; guard: boolean }, now = new Date()) {
  const policies = (await policiesFor(db, key.keyHash)).map(row => visibleStop(row, now));
  const stopped = policies.filter(row => row.killed);
  const hours = policies.flatMap(row => row.spec.work_hours ? [{ key_hash: row.keyHash, ...row.spec.work_hours, ...workHoursCheck(row.spec.work_hours, now) }] : []);
  const [approvals] = await db.select({ count: sql<number>`count(*)::int` }).from(agentApprovals).where(and(
    eq(agentApprovals.keyHash, key.keyHash), eq(agentApprovals.status, "pending"), lte(agentApprovals.requestedAt, now), gt(agentApprovals.expiresAt, now),
  ));
  const setting = options.quiet ? await readQuietSetting(db, key.keyHash) : null;
  let quiet = null;
  if (setting?.hours != null) {
    const last = await lastQuietActivityForStatus(db, key, now);
    const anchor = last ?? setting.enabled_at;
    if (quietDue(setting.hours, anchor, null, now)) quiet = { hours: Math.floor((now.getTime() - Date.parse(anchor)) / 3_600_000), last_call_at: last };
  }
  return { key_hash: key.keyHash, as_of: now.toISOString(), stopped: stopped.length > 0,
    ...combinedStopFields(stopped.map(row => ({ killed: row.killed, ...stopFields(row) }))),
    work_hours: hours.map(({ key_hash, inside, time_zone, outside, next }) => ({ key_hash, inside, time_zone, outside, next_at: next?.toISOString() ?? null })),
    pending_approvals: Number(approvals.count), runway: await readAgentRunway(db, key, now), quiet,
    guard_paused: options.guard && stopped.some(row => row.killedReason?.split(",").some(reason => guardReasons.has(reason))),
  };
}
