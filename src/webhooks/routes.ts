import { configureWebhookEvents } from "./approvals.ts";
import type { Context, Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { principal } from "../api/agents.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { encrypt, uid } from "../lib/util.ts";
import { normalizeWebhookUrl } from "../services/spend-watch.ts";
import { webhookDeliveries, webhookDestinations } from "./schema.ts";
import { destinationJson, importLegacy, insertDestination, WEBHOOK_EVENTS } from "./store.ts";
import { newSigningSecret } from "./signature.ts";
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).transform(v => [...new Set(v)]);
const create = z.strictObject({ webhook_url: z.string().max(2048), events });
export function webhookRoutes(app: Hono, ctx: Ctx) {
  configureWebhookEvents(ctx);
  const caller = async (c: Context) => {
    c.header("cache-control", "no-store");
    if (!ctx.cfg.webhookSigningEnabled) fail(404, "Not found.", "not_found");
    return principal(ctx, c);
  };
  const visible = async (c: Context) => {
    const key = await caller(c);
    const [row] = await ctx.db.select().from(webhookDestinations).where(and(eq(webhookDestinations.id, c.req.param("id")! ), eq(webhookDestinations.accountId, key.accountId), key.management ? undefined : eq(webhookDestinations.keyHash, key.keyHash)));
    if (!row) fail(404, "Destination not found.", "not_found");
    return row;
  };
  app.get("/api/v1/webhooks", async c => {
    const key = await caller(c);
    await importLegacy(ctx, key.accountId);
    const data = await ctx.db.select().from(webhookDestinations).where(and(eq(webhookDestinations.accountId, key.accountId), key.management ? undefined : eq(webhookDestinations.keyHash, key.keyHash))).orderBy(desc(webhookDestinations.createdAt));
    return c.json({ data: data.map(d => destinationJson(ctx, d)), events: WEBHOOK_EVENTS, limits: { independent_destinations: 20, linked_destinations: 20, log: 100, attempts: 3 } });
  });
  app.post("/api/v1/webhooks", async c => {
    const key = await caller(c);
    if (!key.management) fail(403, "Use a management key to add account destinations.", "forbidden");
    const v = create.parse(await readJson(c));
    const url = normalizeWebhookUrl(v.webhook_url);
    await importLegacy(ctx, key.accountId);
    try {
      const { row, secret } = await ctx.db.transaction(tx => insertDestination(ctx, tx, { accountId: key.accountId, createdBy: key.keyHash, urlEnc: encrypt(ctx.cfg.appSecret, url), events: v.events }, true));
      return c.json({ data: destinationJson(ctx, row!), signing_secret: secret }, 201);
    } catch (e) { if ((e as Error).message === "destination_limit") fail(409, "At most 20 independent destinations. Remove one first.", "too_many_destinations"); throw e; }
  });
  app.patch("/api/v1/webhooks/:id", async c => {
    const d = await visible(c), v = z.strictObject({ events }).parse(await readJson(c));
    const [row] = await ctx.db.update(webhookDestinations).set({ events: v.events }).where(eq(webhookDestinations.id, d.id)).returning();
    await ctx.db.update(webhookDeliveries).set({ status: "cancelled" }).where(and(eq(webhookDeliveries.destinationId, d.id), eq(webhookDeliveries.status, "pending"), sql`not (${JSON.stringify(v.events)}::jsonb ? ${webhookDeliveries.event})`));
    return c.json({ data: destinationJson(ctx, row) });
  });
  app.post("/api/v1/webhooks/:id/rotate", async c => {
    const d = await visible(c), secret = newSigningSecret();
    const [row] = await ctx.db.update(webhookDestinations).set({ secretEnc: encrypt(ctx.cfg.appSecret, secret), revoked: false }).where(eq(webhookDestinations.id, d.id)).returning();
    return c.json({ data: destinationJson(ctx, row), signing_secret: secret });
  });
  app.post("/api/v1/webhooks/:id/revoke", async c => {
    const d = await visible(c);
    await ctx.db.transaction(async tx => {
      await tx.update(webhookDestinations).set({ secretEnc: null, revoked: true }).where(eq(webhookDestinations.id, d.id));
      await tx.update(webhookDeliveries).set({ status: "cancelled" }).where(and(eq(webhookDeliveries.destinationId, d.id), eq(webhookDeliveries.status, "pending")));
    });
    return c.json({ data: { id: d.id, signing: "revoked" } });
  });
  app.delete("/api/v1/webhooks/:id", async c => {
    const d = await visible(c);
    // Linked rules must be kept revoked, otherwise their transport would resume unsigned.
    if (d.ruleId) fail(409, "Remove the destination in Spend Watch, or revoke it here.", "linked_destination");
    await ctx.db.delete(webhookDestinations).where(eq(webhookDestinations.id, d.id));
    return c.json({ data: { id: d.id, deleted: true } });
  });
  app.get("/api/v1/webhooks/:id/deliveries", async c => {
    const d = await visible(c);
    const rows = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.destinationId, d.id)).orderBy(sql`${webhookDeliveries.attemptedAt} desc nulls last`, desc(webhookDeliveries.eventAt)).limit(100);
    const data = rows.flatMap(r => r.history.map(a => ({ ...a, event: r.event, event_id: r.eventId }))).sort((a,b) => b.at.localeCompare(a.at)).slice(0,100);
    return c.json({ data, pending: rows.filter(r => r.status === "pending").length });
  });
  app.post("/api/v1/webhooks/:id/test", async c => {
    const d = await visible(c);
    if (d.revoked) fail(409, "Rotate the secret before sending.", "destination_revoked");
    const id = uid("event_");
    await ctx.db.transaction(async tx => {
      await tx.select().from(webhookDestinations).where(eq(webhookDestinations.id, d.id)).for("update");
      const recent = await tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(and(eq(webhookDeliveries.destinationId, d.id), eq(webhookDeliveries.event, "endpoint.check"), sql`${webhookDeliveries.eventAt} > now() - interval '1 minute'`)).limit(1);
      if (recent.length) fail(429, "Wait a minute before sending another check.", "rate_limit");
      await tx.insert(webhookDeliveries).values({ id: uid("wd_"), destinationId: d.id, eventId: id, event: "endpoint.check", reference: d.id, eventAt: new Date() });
    });
    return c.json({ data: { event_id: id, status: "pending" } }, 202);
  });
}
