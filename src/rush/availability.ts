import type { Candidate } from "../catalog/catalog.ts";
import type { Ctx } from "../context.ts";
import type { Hono } from "hono";
import { balanceExhausted, refreshUpstreamHealth } from "./monitor.ts";

/** At most one run in flight and at most one start per window; failures keep the last state and retry after the window. */
export function refreshThrottle(run: () => Promise<void>, now: () => number = () => performance.now(), windowMs = 5_000) {
  let startedAt = -Infinity;
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    const t = now();
    if (t - startedAt < windowMs) return;
    startedAt = t;
    pending = run()
      .catch(() => { /* Keep the last known state; retry after the window. */ })
      .finally(() => { pending = undefined; });
    return pending;
  };
}

/** Read replica state at most every five seconds before the catalogue cache, including recovery invalidation. */
export function registerBalanceAvailability(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.rush.enabled) return;
  const refresh = refreshThrottle(() => refreshUpstreamHealth(ctx.health, ctx.db));
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
