import type { Context, Hono } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { savedRoutes } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import {
  MAX_ROUTES_PER_ACCOUNT,
  ROUTE_PREFIX,
  SLUG_RE,
  lockAccountRoutes,
  modelsOffLane,
  normalizeConfig,
  patchConfig,
  routeCeiling,
  routeConfigSchema,
  routeCreateSchema,
  routePatchSchema,
  unknownModels,
  type ClassesOf,
  type RouteConfig,
} from "../routing/saved-routes.ts";
import { requireKey, requireRole, type Role } from "./auth.ts";
import { actorOf, auditAccount } from "../teams/audit.ts";
import { readJson } from "./common.ts";
import { servedDisclosure } from "./disclosure.ts";
import { offerEligible } from "./lane.ts";

// Saved Routes: CRUD for an account's named routing policies (`model: "@route/<slug>"`).
// Any role on the account can read them (they are settings, not secrets); owners and admins write.

type RouteRow = typeof savedRoutes.$inferSelect;
const READ: Role[] = ["owner", "admin", "member", "viewer"];
const WRITE: Role[] = ["owner", "admin"];

export function routeJson(r: RouteRow) {
  return {
    id: r.id,
    slug: r.slug,
    model: ROUTE_PREFIX + r.slug,
    name: r.name,
    description: r.description,
    config: r.config as RouteConfig,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function notFound(slug: string): never {
  fail(404, `No saved route @route/${slug.slice(0, 60)} in this account.`, "route_not_found");
}

export async function assertModels(ctx: Ctx, ids: string[]) {
  await ctx.catalog.ensureFresh();
  const unknown = unknownModels(ctx.catalog, ids);
  if (unknown.length) fail(400, `Unknown model${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. See GET /api/v1/models.`, "model_not_found", { unknown_models: unknown });
}

/**
 * The disclosure classes a model's endpoints are served under right now, counting only endpoints that could take
 * the route's calls: live, eligible for the model's variant, and allowed by the route's own `only` / `ignore`.
 */
function classesOf(ctx: Ctx, provider: RouteConfig["provider"]): ClassesOf {
  const only = provider?.only?.length ? new Set(provider.only.map((s) => s.toLowerCase())) : null;
  const ignore = new Set((provider?.ignore ?? []).map((s) => s.toLowerCase()));
  return (id) => {
    const r = ctx.catalog.resolve(id);
    if (!r) return null;
    const lane = ctx.catalog.laneOf(r.model);
    return ctx.catalog
      .offers(r.model.id)
      .filter((o) => o.status === "live" && o.provider.status === "live" && offerEligible(ctx, lane, o))
      .filter((o) => (!only || only.has(o.providerId.toLowerCase())) && !ignore.has(o.providerId.toLowerCase()))
      .map((o) => servedDisclosure(ctx, o).class);
  };
}

/**
 * A route that pins the attested lane (or a disclosure ceiling) is refused when a model in its fallback list has no
 * provider that meets it now: every call would fail closed on that model, so saying so at save time beats finding out
 * on the first request. Reads the in-memory catalog only (call `ctx.catalog.ensureFresh()` first).
 */
export function assertRouteLane(ctx: Ctx, config: RouteConfig) {
  const off = modelsOffLane(config, classesOf(ctx, config.provider));
  if (!off.length) return;
  const { lane, max } = routeCeiling(config.provider);
  const wanted = lane === "attested" ? 'lane "attested"' : `disclosure "${max}"`;
  const needs = max === "none" ? "a provider with declared attested retention and a fresh TEE attestation" : "a provider with attested retention or a documented no-retention policy and no legal hold";
  const them = off.length === 1 ? "it" : "them";
  fail(
    409,
    `Not saved: ${off.join(", ")} cannot be served under ${wanted} right now, because ${off.length === 1 ? "it has" : "they have"} no live endpoint from ${needs}. Remove ${them} from the fallback list, or relax the setting. GET /api/v1/models?lane=attested lists the models available on the attested lane.`,
    "route_lane_unavailable",
    { lane, disclosure: max, unavailable_models: off },
  );
}

export function savedRoutesRoutes(app: Hono, ctx: Ctx) {
  const caller = async (c: Context, roles: Role[]) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, roles);
    return key;
  };
  const load = async (accountId: string, slug: string) => {
    if (!SLUG_RE.test(slug)) return null;
    const [row] = await ctx.db.select().from(savedRoutes).where(and(eq(savedRoutes.accountId, accountId), eq(savedRoutes.slug, slug)));
    return row ?? null;
  };

  app.get("/api/v1/routes", async (c) => {
    const key = await caller(c, READ);
    const rows = await ctx.db.select().from(savedRoutes).where(eq(savedRoutes.accountId, key.accountId)).orderBy(asc(savedRoutes.slug));
    return c.json({ data: rows.map(routeJson), limit: MAX_ROUTES_PER_ACCOUNT });
  });

  app.post("/api/v1/routes", async (c) => {
    const key = await caller(c, WRITE);
    const v = routeCreateSchema.parse(await readJson(c));
    await assertModels(ctx, v.config.models); // outside the transaction: the catalog reads through ctx.db
    assertRouteLane(ctx, normalizeConfig(v.config));
    const row = await ctx.db.transaction(async (tx) => {
      await lockAccountRoutes(tx, key.accountId);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(savedRoutes).where(eq(savedRoutes.accountId, key.accountId));
      if (n >= MAX_ROUTES_PER_ACCOUNT) fail(409, `An account can save at most ${MAX_ROUTES_PER_ACCOUNT} routes. Delete one first.`, "route_limit_reached", { limit: MAX_ROUTES_PER_ACCOUNT });
      const now = new Date();
      const [inserted] = await tx
        .insert(savedRoutes)
        .values({ id: uid("rt_"), accountId: key.accountId, slug: v.slug, name: v.name ?? v.slug, description: v.description ?? "", config: normalizeConfig(v.config), createdBy: key.keyHash, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning();
      if (!inserted) fail(409, `This account already has a route @route/${v.slug}.`, "route_exists");
      return inserted;
    });
    // Routes are account-wide, so every team of the account records the change (slug and lane, not the description).
    await auditAccount(ctx.db, key.accountId, await actorOf(ctx.db, key), "route.create", ROUTE_PREFIX + row.slug, { lane: (row.config as RouteConfig).provider?.lane ?? null });
    return c.json({ data: routeJson(row) }, 201);
  });

  app.get("/api/v1/routes/:slug", async (c) => {
    const key = await caller(c, READ);
    const row = await load(key.accountId, c.req.param("slug"));
    return c.json({ data: routeJson(row ?? notFound(c.req.param("slug"))) });
  });

  app.patch("/api/v1/routes/:slug", async (c) => {
    const key = await caller(c, WRITE);
    const slug = c.req.param("slug");
    if (!SLUG_RE.test(slug)) notFound(slug);
    const v = routePatchSchema.parse(await readJson(c));
    if (v.config?.models) await assertModels(ctx, v.config.models);
    // Only a change to the fallback list or the provider policy can change what the route needs from the lane.
    const laneCheck = v.config?.models !== undefined || v.config?.provider !== undefined;
    if (laneCheck) await ctx.catalog.ensureFresh(); // outside the transaction, like assertModels
    const row = await ctx.db.transaction(async (tx) => {
      await lockAccountRoutes(tx, key.accountId);
      const [current] = await tx.select().from(savedRoutes).where(and(eq(savedRoutes.accountId, key.accountId), eq(savedRoutes.slug, slug)));
      if (!current) notFound(slug);
      // The stored config is merged section by section, then validated as a whole again.
      const config = routeConfigSchema.parse(patchConfig(current.config as RouteConfig, v.config));
      if (laneCheck) assertRouteLane(ctx, config);
      if (v.slug && v.slug !== current.slug) {
        const [taken] = await tx.select({ id: savedRoutes.id }).from(savedRoutes).where(and(eq(savedRoutes.accountId, key.accountId), eq(savedRoutes.slug, v.slug)));
        if (taken) fail(409, `This account already has a route @route/${v.slug}.`, "route_exists");
      }
      const [updated] = await tx
        .update(savedRoutes)
        .set({
          ...(v.slug !== undefined ? { slug: v.slug } : {}),
          ...(v.name !== undefined ? { name: v.name } : {}),
          ...(v.description !== undefined ? { description: v.description } : {}),
          config,
          updatedAt: new Date(),
        })
        .where(eq(savedRoutes.id, current.id))
        .returning();
      return updated;
    });
    await auditAccount(ctx.db, key.accountId, await actorOf(ctx.db, key), "route.update", ROUTE_PREFIX + row.slug, {
      fields: Object.keys(v).sort(),
      ...(slug !== row.slug ? { previous: ROUTE_PREFIX + slug } : {}),
      lane: (row.config as RouteConfig).provider?.lane ?? null,
    });
    return c.json({ data: routeJson(row) });
  });

  app.delete("/api/v1/routes/:slug", async (c) => {
    const key = await caller(c, WRITE);
    const slug = c.req.param("slug");
    if (!SLUG_RE.test(slug)) notFound(slug);
    const gone = await ctx.db
      .delete(savedRoutes)
      .where(and(eq(savedRoutes.accountId, key.accountId), eq(savedRoutes.slug, slug)))
      .returning({ slug: savedRoutes.slug });
    if (!gone.length) notFound(slug);
    await auditAccount(ctx.db, key.accountId, await actorOf(ctx.db, key), "route.delete", ROUTE_PREFIX + slug, {});
    return c.json({ data: { slug, model: ROUTE_PREFIX + slug, deleted: true } });
  });
}
