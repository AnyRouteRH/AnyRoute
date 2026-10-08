import { and, desc, eq, lte, ne } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { ownedKey } from "../api/agents.ts";
import { schedules, scheduleRuns } from "./schema.ts";
import { openContent } from "./store.ts";
import { notificationText, runHref } from "./worker.ts";
export async function scheduleInbox(ctx: Ctx, key: KeyRow, asOf: string, since?: string) {
  if (!ctx.cfg.scheduledPromptsEnabled || key.scope === "inference") return [];
  const rows = await ctx.db.select({ row: schedules, run: scheduleRuns }).from(scheduleRuns).innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId)).where(and(eq(schedules.accountId, key.accountId), ne(scheduleRuns.status, "running"), lte(scheduleRuns.finishedAt, new Date(asOf)))).orderBy(desc(scheduleRuns.finishedAt)).limit(101);
  const items = [];
  for (const { row, run } of rows) {
    try { await ownedKey(ctx, key, row.keyHash); } catch { continue; }
    const at = run.finishedAt!.toISOString();
    items.push({ id: `schedule:${run.id}`, at, kind: "schedule", title: notificationText(row.name, run.replyEnc ? openContent(ctx, row, run.replyEnc) : null, run.reason, row.paused), status: run.status, href: runHref(row.id, run.id), unread: !since || at > since });
  }
  return items;
}
