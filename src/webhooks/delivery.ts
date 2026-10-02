import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { decrypt, uid } from "../lib/util.ts";
import { sendWebhook, type SpendWatchOptions } from "../services/spend-watch.ts";
import { spendAlerts } from "../db/schema.ts";
import { webhookDeliveries, webhookDestinations } from "./schema.ts";
import { importLegacy, subscribed, type Destination } from "./store.ts";
import { webhookSignature } from "./signature.ts";
export type EventReference = { id: string; event: string; reference: string; at: Date; status?: string | null };
export const metadataPayload = (event: EventReference) => ({ id: event.id, type: event.event, at: event.at.toISOString(), reference: event.reference, status: event.status ?? null });
export async function enqueue(ctx: Ctx, destination: Destination, event: EventReference, db = ctx.db) {
  if (!subscribed(destination, event.event)) return;
  await db.insert(webhookDeliveries).values({ id: uid("wd_"), destinationId: destination.id, eventId: event.id, event: event.event, reference: event.reference, eventAt: event.at, eventStatus: event.status ?? null }).onConflictDoNothing();
}
export async function deliver(ctx: Ctx, destination: Destination, event: EventReference, payload: unknown, opts: SpendWatchOptions = {}) {
  if (!(event.event === "endpoint.check" ? !destination.revoked : subscribed(destination, event.event))) return { ok: true, status: null, error: null, blocked: false, latency: 0 };
  const [current] = await ctx.db.select().from(webhookDestinations).where(eq(webhookDestinations.id, destination.id));
  if (!current || current.revoked || (event.event !== "endpoint.check" && !subscribed(current, event.event))) return { ok: false, status: null, error: "cancelled", blocked: true, latency: 0 };
  destination = current;
  const start = Date.now();
  try {
    const url = decrypt(ctx.cfg.appSecret, destination.urlEnc);
    const secret = destination.secretEnc ? decrypt(ctx.cfg.appSecret, destination.secretEnc) : null;
    const wire = secret ? { ...payload as Record<string, unknown>, event_id: event.id } : payload;
    const headers: Record<string, string> = { "x-anyroute-event-id": event.id };
    if (secret) headers["x-anyroute-signature"] = webhookSignature(secret, JSON.stringify(wire));
    return { ...await sendWebhook(url, wire, { ...opts, headers }), latency: Date.now() - start };
  } catch { return { ok: false, status: null, error: "undecryptable", blocked: true, latency: Date.now() - start }; }
}
export async function recordAttempt(ctx: Ctx, id: string, attempt: number, result: Awaited<ReturnType<typeof deliver>>) {
  const at = new Date();
  const status = result.ok ? "delivered" : result.blocked ? "blocked" : attempt >= 3 ? "failed" : "pending";
  const entry = { at: at.toISOString(), status, http_status: result.status, latency_ms: result.latency ?? 0, retry_count: attempt - 1 };
  await ctx.db.update(webhookDeliveries).set({ attempts: attempt, status, httpStatus: result.status, latencyMs: entry.latency_ms, attemptedAt: at, nextAttempt: new Date(at.getTime() + 300_000), history: sql`${webhookDeliveries.history} || ${JSON.stringify([entry])}::jsonb` }).where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.attempts, attempt), eq(webhookDeliveries.status, "pending")));
}
/** Existing alert retries retain their own leases and payloads. No unsigned fallback for a revoked key. */
export async function sendRuleWebhook(ctx: Ctx, ruleId: string, url: string, event: EventReference, payload: unknown, opts: SpendWatchOptions = {}) {
  if (!ctx.cfg.webhookSigningEnabled) return sendWebhook(url, payload, opts);
  let [destination] = await ctx.db.select().from(webhookDestinations).where(eq(webhookDestinations.ruleId, ruleId));
  if (!destination) {
    const [rule] = await ctx.db.select().from(spendAlerts).where(eq(spendAlerts.id, ruleId));
    if (rule) { await importLegacy(ctx, rule.accountId); [destination] = await ctx.db.select().from(webhookDestinations).where(eq(webhookDestinations.ruleId, ruleId)); }
  }
  if (!destination) return sendWebhook(url, payload, { ...opts, headers: { "x-anyroute-event-id": event.id } });
  if (!(event.event === "endpoint.check" ? !destination.revoked : subscribed(destination, event.event))) return { ok: true, status: null, error: null, blocked: false };
  // Refuse stale credentials after a rule URL change that did not pass the managed writer.
  try { if (decrypt(ctx.cfg.appSecret, destination.urlEnc) !== url) return { ok: false, status: null, error: "destination_changed", blocked: true }; } catch { return { ok: false, status: null, error: "undecryptable", blocked: true }; }
  await enqueue(ctx, destination, event);
  const [prior] = await ctx.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.destinationId, destination.id), eq(webhookDeliveries.eventId, event.id)));
  if (prior?.status === "delivered") return { ok: true, status: prior.httpStatus, error: null, blocked: false };
  const [row] = await ctx.db.update(webhookDeliveries).set({ attempts: sql`${webhookDeliveries.attempts} + 1` }).where(and(eq(webhookDeliveries.destinationId, destination.id), eq(webhookDeliveries.eventId, event.id), sql`${webhookDeliveries.attempts} < 3`)).returning();
  if (!row) return { ok: false, status: null, error: "attempts_exhausted", blocked: true };
  const result = await deliver(ctx, destination, event, payload, opts);
  if (row) await recordAttempt(ctx, row.id, row.attempts, result);
  return result;
}
