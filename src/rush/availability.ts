import type { Candidate } from "../catalog/catalog.ts";
import type { Ctx } from "../context.ts";
import type { Hono } from "hono";
import { balanceExhausted, refreshUpstreamHealth } from "./monitor.ts";

/** Read replica state at most every five seconds before the catalogue cache, including recovery invalidation. */
export function registerBalanceAvailability(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.rush.enabled) return;
  let startedAt = -Infinity;
  let pending: Promise<void> | undefined;
  const refresh = () => {
    if (pending) return pending;
    const now = performance.now();
    if (now - startedAt < 5_000) return;
    startedAt = now;
    pending = refreshUpstreamHealth(ctx.health, ctx.db)
      .catch(() => { /* Keep the last known state; retry after the window. */ })
      .finally(() => { pending = undefined; });
    return pending;
  };
  for (const path of ["/api/v1/models", "/v1/models"]) app.use(path, async (_c, next) => {
    await refresh();
    await next();
  });
}

/** Omitted when healthy, preserving existing catalogue bytes. No account balances are public. */
export function modelAvailability(ctx: Ctx, offers: Candidate[]) {
  return offers.length && offers.every(o => balanceExhausted(ctx.health, o.providerId))
    ? { availability: "temporarily_unavailable" as const } : {};
}

/** Prefer funded endpoints for catalogue prices and evidence, retaining metadata for unavailable entries. */
export function fundedOffers(ctx: Ctx, offers: Candidate[]) {
  const funded = offers.filter(o => !balanceExhausted(ctx.health, o.providerId));
  return funded.length ? funded : offers;
}
