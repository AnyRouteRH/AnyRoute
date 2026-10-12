import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { health, models, offers, providers } from "../db/schema.ts";
import { accountLinks } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { modelWatches } from "./schema.ts";
import { FRESH_MS, HOLD_MS, PAIR_MS, replay, type WatchNotice } from "./state.ts";
import type { HealthEvent } from "../services/health.ts";
export function registerModelWatchJob(ctx: Ctx) {
  if (ctx.cfg.modelWatchEnabled && ctx.cfg.runtimeRole !== "api") ctx.jobs.register("model-watch", 60_000, () => runModelWatch(ctx));
}
export async function runModelWatch(ctx: Ctx, opts: { now?: Date; telegramFetch?: typeof fetch } = {}) {
  if (!ctx.cfg.modelWatchEnabled || ctx.cfg.runtimeRole === "api") return { created: 0, skipped: "disabled" };
  const now = opts.now ?? new Date();
  const outgoing = await ctx.db.transaction(async tx => {
    const watches = await tx.select().from(modelWatches).where(eq(modelWatches.watching, true)).orderBy(asc(modelWatches.accountId), asc(modelWatches.modelId)).for("update");
    const outgoing: { account: string; item: WatchNotice }[] = [];
    const observations = new Map<string, { routes: string[]; events: HealthEvent[]; name: string }>();
    for (const watch of watches) {
      let snapshot = observations.get(watch.modelId);
      if (!snapshot) {
        // Shared database only: never this API process's catalogue or in-memory HealthTracker.
        const [model] = await tx.select().from(models).where(eq(models.id, watch.modelId));
        const routes = model && !model.hidden ? await tx.select({ provider: offers.providerId }).from(offers).innerJoin(providers, eq(providers.id, offers.providerId)).where(and(eq(offers.modelId, watch.modelId), eq(offers.status, "live"), eq(providers.status, "live"))) : [];
        const rows = await tx.select().from(health).where(and(eq(health.modelId, watch.modelId), gte(health.ts, new Date(now.getTime() - HOLD_MS - FRESH_MS - 1)), lte(health.ts, now))).orderBy(asc(health.ts));
        snapshot = { routes: routes.map(r => r.provider), name: model?.name ?? watch.modelId, events: rows.map(r => ({ ...r, at: r.ts.getTime(), source: r.source as HealthEvent["source"] })) };
        observations.set(watch.modelId, snapshot);
      }
      const state = watch.state, transition = replay(state, snapshot.routes, snapshot.events, now.getTime());
      state.notices = state.notices.filter(item => Date.parse(item.at) > now.getTime() - 30 * 86_400_000);
      if (transition) {
        const item = { id: uid("mw_"), at: now.toISOString(), model: watch.modelId, title: snapshot.name + (transition === "down" ? " is unavailable right now" : " is back") };
        state.notices.push(item); outgoing.push({ account: watch.accountId, item });
      }
      await tx.update(modelWatches).set({ state }).where(and(eq(modelWatches.accountId, watch.accountId), eq(modelWatches.modelId, watch.modelId)));
    }
    await tx.delete(modelWatches).where(and(eq(modelWatches.watching, false), sql`(${modelWatches.state}->>'lastDown')::bigint <= ${now.getTime() - PAIR_MS}`));
    return outgoing;
  });
  // Claim before outbound delivery: concurrent workers cannot send the same transition twice.
  for (const notice of outgoing) for (const link of await accountLinks(ctx.db, notice.account)) {
    await sendLinkedAlert(ctx, link, notice.item.title, link.key_hash, opts.telegramFetch, async (_ctx, key) => {
      if (!key.management || key.accountId !== notice.account) fail(403, "Account management access required.", "forbidden");
    }, "model_watch");
  }
  return { created: outgoing.length, skipped: false };
}
export async function modelWatchInbox(ctx: Ctx, account: string, asOf: string, since?: string) {
  if (!ctx.cfg.modelWatchEnabled) return [];
  const rows = await ctx.db.select().from(modelWatches).where(and(eq(modelWatches.accountId, account), eq(modelWatches.watching, true))).orderBy(desc(modelWatches.createdAt));
  return rows.flatMap(row => row.state.notices).filter(item => item.at <= asOf && (!since || item.at > since))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 101)
    .map(item => ({ ...item, kind: "model_watch", status: null, href: "/models/model/?id=" + encodeURIComponent(item.model), unread: true }));
}
