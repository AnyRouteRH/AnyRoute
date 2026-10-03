import { roleOf, type KeyRow } from "../api/auth.ts"; // V86: recheck retained principal access.
import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { keys, spendAlerts, agentSessions } from "../db/schema.ts";
import { readActivity } from "../activity/read.ts";
import { activityQuery } from "../activity/query.ts";
import { webhookDeliveries, webhookDestinations } from "./schema.ts";
import { deliver, enqueue, metadataPayload, recordAttempt, type EventReference } from "./delivery.ts";
import type { SpendWatchOptions } from "../services/spend-watch.ts";
import type { Destination } from "./store.ts";
export function activityEvent(row: { id: string; kind: string; status: string }) {
  if (row.kind === "deposit" && row.status === "posted") return "deposit.credited";
  if (row.kind === "alert") return row.id.startsWith("spend-alert:") ? "spend.alert" : "agent.alert";
  if (row.kind === "agreement") return ({ MilestoneFunded: "agreement.funded", DisputeOpened: "agreement.disputed", RulingPosted: "agreement.ruled" } as Record<string, string>)[row.status] ?? null;
  return null;
}
async function ownerActive(ctx: Ctx, key: KeyRow | undefined, d: Destination) {
  if (!key || key.accountId !== d.accountId || key.disabled || (key.expiresAt && key.expiresAt <= new Date())) return false;
  if (!key.management && d.keyHash !== key.keyHash) return false;
  if (!(await roleOf(ctx, key)).match(/^(owner|admin)$/)) return false;
  return !(await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length;
}
async function ingest(ctx: Ctx, destination: Destination) {
  await ctx.db.transaction(async tx => {
    // Every read inside the lock goes through the transaction: a second connection is not guaranteed (PGlite has one).
    const scoped = { ...ctx, db: tx as unknown as Db };
    const [d] = await tx.select().from(webhookDestinations).where(eq(webhookDestinations.id, destination.id)).for("update", { skipLocked: true });
    if (!d || d.revoked) return;
    const [key] = await tx.select().from(keys).where(and(eq(keys.keyHash, d.createdBy), eq(keys.accountId, d.accountId)));
    if (!await ownerActive(scoped, key, d)) return;
    const state = { ...d.scan };
    // One page per destination per minute, with a fixed upper bound and cursor carried across ticks.
    const to = state.to ?? new Date(Date.now() - 1000).toISOString();
    if (Date.parse(to) > Date.parse(state.from)) {
      const page = await readActivity(scoped, key, activityQuery({ from: state.from, to, limit: "100", ...(state.cursor ? { cursor: state.cursor } : {}), ...(d.keyHash ? { key: d.keyHash } : {}) }), sql`kind in ('alert','deposit','agreement')`);
      for (const row of page.data) {
        const event = activityEvent(row);
        // Linked rules continue to own the exact spend/agent payload and retry lease.
        if (event && !(d.ruleId && ["spend.alert", "agent.alert"].includes(event))) await enqueue(ctx, d, { id: row.id, event, reference: row.reference ?? row.id, at: new Date(row.at), status: row.status }, tx);
      }
      if (page.next_cursor) Object.assign(state, { to, cursor: page.next_cursor });
      else { state.from = new Date(Math.max(Date.parse(d.createdAt.toISOString()), Date.parse(to) - 300_000)).toISOString(); delete state.to; delete state.cursor; }
    }
    await tx.update(webhookDestinations).set({ scan: state }).where(eq(webhookDestinations.id, d.id));
  });
}
export async function runWebhooks(ctx: Ctx, opts: SpendWatchOptions = {}) {
  if (!ctx.cfg.webhookSigningEnabled) return { skipped: "disabled", attempted: 0 };
  // Order by last sweep, not a fixed id page, to avoid starving later accounts.
  const destinations = await ctx.db.select().from(webhookDestinations).where(eq(webhookDestinations.revoked, false)).orderBy(sql`${webhookDestinations.scan}->>'swept' nulls first`, asc(webhookDestinations.id)).limit(50);
  let scanFailures = 0;
  for (const d of destinations) {
    try { await ingest(ctx, d); } catch { scanFailures++; } // Report only a fixed failure, never reader exception text.
    await ctx.db.update(webhookDestinations).set({ scan: sql`${webhookDestinations.scan} || ${JSON.stringify({ swept: new Date().toISOString() })}::jsonb` }).where(eq(webhookDestinations.id, d.id));
  }
  let attempted = 0;
  for (let i = 0; i < 100; i++) {
    const claim = await ctx.db.transaction(async tx => {
      const [row] = await tx.select({ delivery: webhookDeliveries, destination: webhookDestinations }).from(webhookDeliveries).innerJoin(webhookDestinations, eq(webhookDestinations.id, webhookDeliveries.destinationId)).where(and(eq(webhookDeliveries.status, "pending"), lt(webhookDeliveries.nextAttempt, new Date()), eq(webhookDestinations.revoked, false), sql`${webhookDeliveries.attempts} < 3`, sql`(${webhookDestinations.ruleId} is null or ${webhookDeliveries.event} not in ('spend.alert','agent.alert'))`)).orderBy(asc(webhookDeliveries.nextAttempt)).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      const [owner] = await tx.select().from(keys).where(eq(keys.keyHash, row.destination.createdBy));
      if (!await ownerActive({ ...ctx, db: tx as unknown as Db }, owner, row.destination)) {
        await tx.update(webhookDeliveries).set({ status: "cancelled" }).where(eq(webhookDeliveries.id, row.delivery.id)); return null;
      }
      if (row.destination.ruleId) {
        const [rule] = await tx.select().from(spendAlerts).where(eq(spendAlerts.id, row.destination.ruleId));
        if (!rule?.enabled || !rule.webhookUrlEnc) { await tx.update(webhookDeliveries).set({ status: "cancelled" }).where(eq(webhookDeliveries.id, row.delivery.id)); return null; }
      }
      const [delivery] = await tx.update(webhookDeliveries).set({ attempts: row.delivery.attempts + 1, nextAttempt: new Date(Date.now() + 300_000) }).where(eq(webhookDeliveries.id, row.delivery.id)).returning();
      return { ...row, delivery };
    });
    if (!claim) break;
    attempted++;
    const r = claim.delivery;
    const event: EventReference = { id: r.eventId, event: r.event, reference: r.reference, at: r.eventAt, status: r.eventStatus };
    await recordAttempt(ctx, r.id, r.attempts, await deliver(ctx, claim.destination, event, metadataPayload(event), opts));
  }
  // A crash after a final lease is visible as failure, never retries forever. Keep dedup metadata 90 days.
  await ctx.db.update(webhookDeliveries).set({ status: "failed" }).where(and(eq(webhookDeliveries.status, "pending"), eq(webhookDeliveries.attempts, 3), lt(webhookDeliveries.nextAttempt, new Date())));
  await ctx.db.delete(webhookDeliveries).where(and(sql`${webhookDeliveries.status} <> 'pending'`, lt(webhookDeliveries.eventAt, new Date(Date.now() - 90 * 86_400_000))));
  if (scanFailures) throw new Error("Webhook event discovery failed; retained progress can be retried.");
  return { attempted };
}
