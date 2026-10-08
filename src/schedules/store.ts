import { and, desc, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { ownedKey } from "../api/agents.ts";
import { schedules, scheduleRuns, type Schedule } from "./schema.ts";
import { decrypt, encrypt } from "../lib/util.ts";
import { picoToUsdString } from "../lib/money.ts";
import { fail } from "../lib/errors.ts";
export const contentScope = (ctx: Ctx, row: Pick<Schedule, "accountId" | "id">) => `${ctx.cfg.appSecret}:schedule:${row.accountId}:${row.id}`;
export const sealContent = (ctx: Ctx, row: Pick<Schedule, "accountId" | "id">, text: string) => encrypt(contentScope(ctx, row), text);
export const openContent = (ctx: Ctx, row: Pick<Schedule, "accountId" | "id">, text: string) => decrypt(contentScope(ctx, row), text);
export const scheduleJson = (ctx: Ctx, row: Schedule) => ({ id: row.id, name: row.name, prompt: openContent(ctx, row, row.promptEnc), model: row.model, key_hash: row.keyHash, cadence: row.cadence, time_utc: row.timeUtc, max_cost_usd: picoToUsdString(row.maxCostPico), paused: row.paused, consecutive_failures: row.failures, next_at: row.nextAt.toISOString(), created_at: row.createdAt.toISOString() });
export async function ownSchedule(ctx: Ctx, key: KeyRow, id: string) {
  const [row] = await ctx.db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.accountId, key.accountId)));
  if (!row) fail(404, "Schedule not found.", "not_found");
  await ownedKey(ctx, key, row.keyHash);
  return row;
}
export async function assertIdle(db: Ctx["db"], id: string) {
  if ((await db.select({ id: scheduleRuns.id }).from(scheduleRuns).where(and(eq(scheduleRuns.scheduleId, id), eq(scheduleRuns.status, "running"))).limit(1)).length)
    fail(409, "Wait for the current run to finish.", "schedule_busy");
}
export async function retainedRuns(ctx: Ctx, row: Schedule) {
  const runs = await ctx.db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, row.id)).orderBy(desc(scheduleRuns.startedAt), desc(scheduleRuns.id)).limit(10);
  return runs.map(run => ({ id: run.id, due_at: run.dueAt.toISOString(), started_at: run.startedAt.toISOString(), finished_at: run.finishedAt?.toISOString() ?? null, status: run.status, reply: run.replyEnc ? openContent(ctx, row, run.replyEnc) : null, reason: run.reason, generation_id: run.generationId }));
}
export async function pruneRuns(db: Ctx["db"], id: string) {
  await db.delete(scheduleRuns).where(and(eq(scheduleRuns.scheduleId, id), sql`${scheduleRuns.id} NOT IN (SELECT id FROM schedule_runs WHERE schedule_id = ${id} ORDER BY started_at DESC, id DESC LIMIT 10)`));
}
