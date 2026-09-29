import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { CURSOR_MESSAGE, EVENT_KINDS, parseEventCursor, type EventKind } from "../services/attestation-history.ts";
import { buildSummary, listHistory } from "../services/attestation-events.ts";

// Proof-time: the public, live record of how long each provider has actually held a fresh attestation.
//   GET /api/v1/attestation/summary                    per provider: status, coverage of the last 24h and 7d, changes, last failure
//   GET /api/v1/attestation/:providerId/history        that provider's events, newest first, paged by a compound cursor
// Both are public and carry no raw provider output: failures are codes with fixed messages, and measurements are digests.
// Register before attestationRoutes, whose /:providerId would otherwise take the word "summary" for a provider id.

const intParam = (v: string | undefined, dflt: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(Number(v ?? dflt)) || dflt));

export function attestationHistoryRoutes(app: Hono, ctx: Ctx) {
  const requireOn = () => {
    if (ctx.cfg.attestation.historyDays <= 0) fail(501, "This router does not keep an attestation history (ATTESTATION_HISTORY_DAYS is 0).", "not_enabled");
  };

  app.get("/api/v1/attestation/summary", async (c) => {
    requireOn();
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ data: await buildSummary(ctx) });
  });

  app.get("/api/v1/attestation/:providerId/history", async (c) => {
    requireOn();
    const id = c.req.param("providerId");
    const [p] = await ctx.db.select({ id: providers.id, status: providers.status }).from(providers).where(eq(providers.id, id));
    if (!p || p.status === "applied") fail(404, "Unknown provider.", "not_found");
    const kindParam = c.req.query("kind");
    if (kindParam && !(EVENT_KINDS as readonly string[]).includes(kindParam)) fail(400, `kind must be one of ${EVENT_KINDS.join(", ")}.`, "invalid_request");
    const okParam = c.req.query("ok");
    if (okParam !== undefined && okParam !== "true" && okParam !== "false") fail(400, "ok must be true or false.", "invalid_request");
    const beforeParam = c.req.query("before");
    const before = beforeParam ? parseEventCursor(beforeParam) : undefined;
    if (beforeParam && !before) fail(400, CURSOR_MESSAGE, "invalid_request");
    const page = await listHistory(ctx, p.id, { limit: intParam(c.req.query("limit"), 50, 1, 200), before: before ?? undefined, kind: (kindParam as EventKind | undefined) || undefined, ok: okParam === undefined ? undefined : okParam === "true" });
    c.header("Cache-Control", "public, max-age=15");
    return c.json({ provider: p.id, history_days: ctx.cfg.attestation.historyDays, ...page });
  });
}
