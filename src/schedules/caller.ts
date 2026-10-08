import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import { batchKey } from "../router/batch-line.ts";
import { requireRole, type KeyRow } from "../api/auth.ts";
import { ownedKey } from "../api/agents.ts";
import { fail } from "../lib/errors.ts";
// An in-process capability, never accepted from a header, body, or private socket address.
export const SCHEDULE_CALL = Symbol("anyroute.schedule-call");
export type ScheduleCall = { ownerHash: string; keyHash: string; maxCostPico: bigint; generationId: string };
export function scheduleCallOf(c: Context): ScheduleCall | undefined {
  return (c.env as Record<symbol, ScheduleCall> | undefined)?.[SCHEDULE_CALL];
}
export async function scheduleKey(ctx: Ctx, call: ScheduleCall) {
  if (!ctx.cfg.scheduledPromptsEnabled) fail(404, "Scheduled prompts are not switched on.", "feature_disabled");
  const owner = await batchKey(ctx, call.ownerHash);
  if (owner.scope === "inference") fail(403, "Use an owner key to manage schedules.", "forbidden");
  await requireRole(ctx, owner, ["owner"]);
  await ownedKey(ctx, owner, call.keyHash);
  return batchKey(ctx, call.keyHash);
}
export function enforceScheduleCost(call: ScheduleCall | undefined, hold: bigint) {
  if (call && hold > call.maxCostPico) fail(403, "This run exceeds its maximum cost.", "schedule_max_cost");
}

export const scheduleNoticeOwner = (ctx: Ctx, key: KeyRow) => requireRole(ctx, key, ["owner"]);
