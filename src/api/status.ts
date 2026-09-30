import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { statusIncidents } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { safeEqual } from "../lib/util.ts";
import { bearer } from "./auth.ts";
import { readJson } from "./common.ts";
import { requireOperator } from "./lane.ts";
import { ACTIVE_STATUSES, IMPACTS, LANES, SURFACES, activeSurfaces, atomFeed, buildSlo, incidentJson, isPublicIncident, publicIncidents, rssFeed, type IncidentUpdate, type Surface } from "../services/slo.ts";

// The public status page's API (services/slo.ts has the sources and the math):
//   GET  /api/v1/status/slo                         per lane and surface: availability, latency, error budget, incidents (cached 30 s)
//   GET  /api/v1/status/incidents                   confirmed incidents of the last 90 days, newest first
//   GET  /api/v1/status/incidents/:id               one confirmed incident
//   GET  /api/v1/status/incidents.atom | .rss       the same as feeds
//   operator token (ADMIN_TOKEN) only:
//   GET  /api/v1/status/incidents?all=true          also automatic suggestions and dismissed ones
//   POST /api/v1/status/incidents                   open an incident
//   PATCH /api/v1/status/incidents/:id              change its title, impact, lanes or surfaces
//   POST /api/v1/status/incidents/:id/updates       post a status update; confirms a suggestion, resolves, or dismisses one

const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "control characters are not allowed");
const lanes = z.array(z.enum(LANES)).min(1).max(3).transform((l) => [...new Set(l)]);
const surfaces = z.array(z.enum(SURFACES)).max(SURFACES.length).transform((s) => [...new Set(s)]);
const createSchema = z.object({
  title: text(140),
  lanes,
  surfaces: surfaces.default([]),
  impact: z.enum(IMPACTS).default("minor"),
  status: z.enum(ACTIVE_STATUSES).default("investigating"),
  message: text(2000),
  started_at: z.iso.datetime().optional(),
}).strict();
const patchSchema = z.object({ title: text(140).optional(), lanes: lanes.optional(), surfaces: surfaces.optional(), impact: z.enum(IMPACTS).optional() }).strict();
const updateSchema = z.object({ status: z.enum([...ACTIVE_STATUSES, "resolved", "dismissed"]), message: text(2000), impact: z.enum(IMPACTS).optional() }).strict();

const isOperator = (ctx: Ctx, token: string | undefined) => !!ctx.cfg.adminToken && !!token && safeEqual(token, ctx.cfg.adminToken);

export function statusRoutes(app: Hono, ctx: Ctx) {
  let cached: { at: number; body: unknown } | null = null;
  let surfaces: Surface[] | null = null;
  const base = () => (ctx.cfg.publicUrl ?? "").replace(/\/$/, "");

  app.get("/api/v1/status/slo", async (c) => {
    surfaces ??= activeSurfaces(app.routes);
    if (!cached || Date.now() - cached.at > 30_000) cached = { at: Date.now(), body: { data: await buildSlo(ctx, surfaces) } };
    c.header("Cache-Control", "public, max-age=30");
    return c.json(cached.body as object);
  });

  const feedList = async () => (await publicIncidents(ctx, 50)).map(incidentJson);
  app.get("/api/v1/status/incidents.atom", async (c) => {
    c.header("Cache-Control", "public, max-age=60");
    c.header("Content-Type", "application/atom+xml; charset=utf-8");
    return c.body(atomFeed(base(), await feedList()));
  });
  app.get("/api/v1/status/incidents.rss", async (c) => {
    c.header("Cache-Control", "public, max-age=60");
    c.header("Content-Type", "application/rss+xml; charset=utf-8");
    return c.body(rssFeed(base(), await feedList()));
  });

  app.get("/api/v1/status/incidents", async (c) => {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(c.req.query("limit") ?? 50)) || 50));
    if (c.req.query("all") === "true") {
      requireOperator(ctx, c);
      c.header("Cache-Control", "no-store");
      const rows = await ctx.db.select().from(statusIncidents).orderBy(desc(statusIncidents.startedAt)).limit(limit);
      return c.json({ data: rows.map(incidentJson) });
    }
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ data: (await publicIncidents(ctx, limit)).map(incidentJson) });
  });

  app.get("/api/v1/status/incidents/:id", async (c) => {
    const [row] = await ctx.db.select().from(statusIncidents).where(eq(statusIncidents.id, c.req.param("id")));
    const operator = isOperator(ctx, c.req.header("x-admin-token") ?? bearer(c.req.header("authorization")) ?? undefined);
    if (!row || (!isPublicIncident(row) && !operator)) fail(404, "Unknown incident.", "not_found");
    return c.json({ data: incidentJson(row!) });
  });

  app.post("/api/v1/status/incidents", async (c) => {
    requireOperator(ctx, c);
    const input = createSchema.parse(await readJson(c));
    const now = new Date();
    const [row] = await ctx.db
      .insert(statusIncidents)
      .values({
        id: `inc_${randomBytes(8).toString("hex")}`,
        title: input.title,
        status: input.status,
        impact: input.impact,
        lanes: input.lanes,
        surfaces: input.surfaces,
        source: "operator",
        updates: [{ at: now.toISOString(), status: input.status, text: input.message }],
        startedAt: input.started_at ? new Date(input.started_at) : now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return c.json({ data: incidentJson(row) }, 201);
  });

  const load = async (id: string) => {
    const [row] = await ctx.db.select().from(statusIncidents).where(eq(statusIncidents.id, id));
    if (!row) fail(404, "Unknown incident.", "not_found");
    return row!;
  };

  app.patch("/api/v1/status/incidents/:id", async (c) => {
    requireOperator(ctx, c);
    const input = patchSchema.parse(await readJson(c));
    const row = await load(c.req.param("id"));
    const [next] = await ctx.db.update(statusIncidents).set({ ...input, updatedAt: new Date() }).where(eq(statusIncidents.id, row.id)).returning();
    return c.json({ data: incidentJson(next) });
  });

  app.post("/api/v1/status/incidents/:id/updates", async (c) => {
    requireOperator(ctx, c);
    const input = updateSchema.parse(await readJson(c));
    const row = await load(c.req.param("id"));
    if (row.status === "resolved" || row.status === "dismissed") fail(409, `This incident is ${row.status}; open a new one instead.`, "incident_closed");
    if (input.status === "dismissed" && row.status !== "suggested") fail(409, "Only an automatic suggestion can be dismissed; resolve a confirmed incident instead.", "invalid_transition");
    const now = new Date();
    const updates = [...((row.updates as IncidentUpdate[]) ?? []), { at: now.toISOString(), status: input.status, text: input.message }];
    const [next] = await ctx.db
      .update(statusIncidents)
      .set({ status: input.status, updates, updatedAt: now, ...(input.impact ? { impact: input.impact } : {}), ...(input.status === "resolved" ? { resolvedAt: now } : {}) })
      .where(eq(statusIncidents.id, row.id))
      .returning();
    return c.json({ data: incidentJson(next) });
  });
}
