import { cleanProfile } from "../hardening/profile-text.ts";
import type { Hono } from "hono";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { agentProfiles } from "../agents/profile-schema.ts";
import { directoryQuery, newProfileSlug, profileBody, profileCard, profileCertificates, profileSlug } from "../agents/profiles.ts";
import { fail } from "../lib/errors.ts";
import { readJson } from "./common.ts";
import { ownedKey, principal } from "./agents.ts";

export function agentProfilesRoutes(app: Hono, ctx: Ctx) {
  const guard = () => { if (!ctx.cfg.agentProfilesEnabled) fail(404, "Not found.", "not_found"); };
  const live = and(eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`);
  app.get("/api/v1/agents/profiles", async c => {
    guard(); c.header("cache-control", "no-store");
    const { tag, cursor, limit } = directoryQuery.parse(c.req.query());
    const rows = await ctx.db.select({ profile: agentProfiles }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash))
      .where(and(live, cursor ? gt(agentProfiles.slug, cursor) : undefined, tag ? sql`${agentProfiles.settings}->'capabilities' @> ${JSON.stringify([tag])}::jsonb` : undefined)).orderBy(agentProfiles.slug).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({ data: await Promise.all(page.map(r => profileCard(ctx, r.profile))), next_cursor: rows.length > limit ? page.at(-1)!.profile.slug : null });
  });
  app.get("/api/v1/agents/profiles/:slug", async c => {
    guard(); c.header("cache-control", "no-store");
    const slug = c.req.param("slug");
    if (!profileSlug.safeParse(slug).success) fail(404, "Profile not found.", "not_found");
    const [row] = await ctx.db.select({ profile: agentProfiles }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash)).where(and(eq(agentProfiles.slug, slug), live));
    if (!row) fail(404, "Profile not found.", "not_found");
    return c.json(await profileCard(ctx, row.profile));
  });
  app.get("/api/v1/agents/:key_hash/profile", async c => {
    guard(); c.header("cache-control", "no-store");
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    const [row] = await ctx.db.select().from(agentProfiles).where(eq(agentProfiles.keyHash, key.keyHash));
    return c.json({ data: row ? { ...cleanProfile(row.settings), id: row.slug, certificate_claims: row.certificates[0]?.payload.claims ?? [] } : null });
  });
  app.put("/api/v1/agents/:key_hash/profile", async c => {
    guard(); c.header("cache-control", "no-store");
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    if (key.disabled || (key.expiresAt && key.expiresAt <= new Date())) fail(409, "Only active keys can publish a profile.", "invalid_request");
    const { certificate_claims, ...settings } = profileBody.parse(await readJson(c));
    const certificates = await profileCertificates(ctx, key, certificate_claims);
    const [row] = await ctx.db.insert(agentProfiles).values({ slug: newProfileSlug(), keyHash: key.keyHash, settings, certificates })
      .onConflictDoUpdate({ target: agentProfiles.keyHash, set: { settings, certificates } }).returning();
    return c.json({ data: { id: row.slug, url: `${ctx.cfg.publicUrl}/agents/profile/?id=${row.slug}` } });
  });
  app.delete("/api/v1/agents/:key_hash/profile", async c => {
    guard(); c.header("cache-control", "no-store");
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    await ctx.db.delete(agentProfiles).where(eq(agentProfiles.keyHash, key.keyHash));
    return c.json({ data: { deleted: true } });
  });
}
