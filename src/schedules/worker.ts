import { and, eq, lte, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Dispatch } from "../services/batches.ts";
import { schedules, scheduleRuns, type Schedule } from "./schema.ts";
import { nextDue, type Cadence } from "./time.ts";
import { assertIdle, openContent, sealContent, pruneRuns } from "./store.ts";
import { genId } from "../lib/util.ts";
import { isApiError } from "../lib/errors.ts";
import { SCHEDULE_CALL, scheduleKey, scheduleNoticeOwner } from "./caller.ts";
import { linkedAlertTargets } from "../telegram/delivery.ts";

export async function claimRun(ctx: Ctx, id: string, now: Date, manual = false) {
  return ctx.db.transaction(async tx => {
    const [row] = await tx.select().from(schedules).where(eq(schedules.id, id)).for("update");
    if (!row) return null;
    await assertIdle(tx as unknown as Ctx["db"], id);
    if (!manual && (row.paused || row.nextAt > now)) return null;
    // Manual runs occupy their own slot and leave the recurring due time alone.
    const due = manual ? now : row.nextAt;
    const [run] = await tx.insert(scheduleRuns).values({ id: genId(), scheduleId: id, dueAt: due, startedAt: now, generationId: genId() }).onConflictDoNothing().returning();
    if (!run) return null;
    if (!manual) await tx.update(schedules).set({ nextAt: nextDue(row.cadence as Cadence, row.timeUtc, now) }).where(eq(schedules.id, id));
    await pruneRuns(tx as unknown as Ctx["db"], id);
    return { row, run };
  });
}
export const runHref = (id: string, run: string) => `/dashboard/?schedule=${encodeURIComponent(id)}&run=${encodeURIComponent(run)}#schedules`;
export function failureText(reason: string | null) {
  const reasons: Record<string, string> = { schedule_max_cost: "Maximum cost exceeded.", agent_approval_required: "Approval needed.", agent_policy_denied: "Your rulebook refused the request.", agent_killed: "The agent is stopped.", insufficient_credits: "More funds are needed.", key_disabled: "The paying key is disabled.", key_expired: "The paying key has expired.", worker_interrupted: "Worker interrupted; the call was not retried.", run_interrupted: "Run interrupted.", model_not_allowed: "The key does not allow this model.", no_providers: "No provider could serve the request." };
  return reasons[reason ?? ""] ?? "The request could not be completed.";
}
export function notificationText(name: string, reply: string | null, reason: string | null, paused: boolean) {
  return `${name}: ${reply === null ? `Run stopped: ${failureText(reason)}${paused ? " Schedule paused after three failures." : ""}` : reply.slice(0, 300)}`;
}
async function finish(ctx: Ctx, row: Schedule, id: string, reply: string | null, reason: string | null) {
  return ctx.db.transaction(async tx => {
    const [live] = await tx.select().from(schedules).where(eq(schedules.id, row.id)).for("update");
    if (!live) return null;
    const failures = reason ? live.failures + 1 : 0;
    const [done] = await tx.update(scheduleRuns).set({ status: reason ? "failed" : "succeeded", replyEnc: reply === null ? null : sealContent(ctx, row, reply), reason, finishedAt: new Date() }).where(and(eq(scheduleRuns.id, id), eq(scheduleRuns.status, "running"))).returning();
    if (!done) return null;
    await tx.update(schedules).set({ failures, paused: live.paused || failures >= 3 }).where(eq(schedules.id, row.id));
    return { ...done, paused: live.paused || failures >= 3 };
  });
}
export async function deliverScheduleNotice(ctx: Ctx, row: Schedule, run: { id: string; reason: string | null; paused: boolean }, reply: string | null, fetchImpl?: typeof fetch) {
  // Claim one outbound attempt before sending. Inbox reads the encrypted result directly; no second plaintext store.
  const [claimed] = await ctx.db.update(scheduleRuns).set({ notified: true }).where(and(eq(scheduleRuns.id, run.id), eq(scheduleRuns.notified, false))).returning();
  if (!claimed) return;
  const text = notificationText(row.name, reply, run.reason, run.paused) + "\nhttps://anyroute.tech" + runHref(row.id, run.id);
  for (const target of await linkedAlertTargets(ctx, row.accountId, row.keyHash, text, fetchImpl, scheduleNoticeOwner, "scheduled_results")) await target.send().catch(() => false); // E146
}
export async function executeRun(ctx: Ctx, claimed: NonNullable<Awaited<ReturnType<typeof claimRun>>>, dispatch: Dispatch, approval?: string) {
  const { row, run } = claimed;
  let reply: string | null = null, reason: string | null = null;
  try {
    const call = { ownerHash: row.ownerHash, keyHash: row.keyHash, maxCostPico: row.maxCostPico, generationId: run.generationId! };
    await scheduleKey(ctx, call);
    const response = await dispatch("/api/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...(approval ? { "x-agent-approval": approval } : {}) }, body: JSON.stringify({ model: row.model, messages: [{ role: "user", content: openContent(ctx, row, row.promptEnc) }], stream: false, max_tokens: 1024 }), signal: AbortSignal.timeout(600_000) }, { [SCHEDULE_CALL]: call });
    const result = await response.json() as any;
    if (!response.ok) {
      // Store only a bounded machine reason: upstream error messages may repeat prompt text.
      reason = typeof result?.error?.type === "string" && /^[a-z_]{1,80}$/.test(result.error.type) ? result.error.type : "request_failed";
    } else {
      const text = result?.choices?.[0]?.message?.content;
      if (typeof text !== "string") reason = "unreadable_reply";
      else reply = text;
    }
  } catch (error) { reason = isApiError(error) && /^[a-z_]{1,80}$/.test(error.type) ? error.type : "run_interrupted"; }
  const done = await finish(ctx, row, run.id, reply, reason);
  if (done) await deliverScheduleNotice(ctx, row, done, reply).catch(() => undefined);
  return done;
}
export async function runSchedules(ctx: Ctx, dispatch: Dispatch, now = new Date()) {
  if (!ctx.cfg.scheduledPromptsEnabled) return { runs: 0 };
  // An interrupted worker's uncertain call is never reissued; this prevents duplicate billing.
  const stale = await ctx.db.select({ row: schedules, run: scheduleRuns }).from(scheduleRuns).innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId)).where(and(eq(scheduleRuns.status, "running"), lte(scheduleRuns.startedAt, new Date(now.getTime() - 900_000)))).limit(100);
  for (const { row, run } of stale) { const done = await finish(ctx, row, run.id, null, "worker_interrupted"); if (done) await deliverScheduleNotice(ctx, row, done, null).catch(() => undefined); }
  const due = await ctx.db.select({ id: schedules.id }).from(schedules).where(and(eq(schedules.paused, false), lte(schedules.nextAt, now))).orderBy(schedules.nextAt).limit(50);
  let runs = 0;
  for (const row of due) {
    let claimed;
    try { claimed = await claimRun(ctx, row.id, now); } catch { continue; }
    if (claimed) { await executeRun(ctx, claimed, dispatch); runs++; }
  }
  return { runs };
}
export function registerScheduledPrompts(ctx: Ctx, dispatch?: Dispatch) {
  if (ctx.cfg.scheduledPromptsEnabled && ctx.cfg.runtimeRole !== "api" && dispatch) ctx.jobs.register("scheduled-prompts", 60_000, () => runSchedules(ctx, dispatch));
}
