import type { Context, Hono } from "hono";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { skills } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { usdToPico } from "../lib/money.ts";
import { safeEqual } from "../lib/util.ts";
import { bearer, requireKey, requireRole, type Role } from "./auth.ts";
import { readJson } from "./common.ts";
import { requireOperator } from "./lane.ts";
import { LEVELS } from "../skills/scanner.ts";
import { assertServable, detailJson, hasInstall, installCount, installJson, installSkill, normalizeArchive, normalizeGit, storeSkill, summaryJson, type SkillRow } from "../skills/service.ts";

// Secured Skills Hub (src/skills/):
//   GET   /api/v1/skills                  public registry: ?q= search, ?level=trusted,caution filter, ?include_revoked=true
//   GET   /api/v1/skills/:id              manifest, file list, content hash, scan report, price, chain fields
//   GET   /api/v1/skills/:id/download     the canonical tar.gz; only SKILLS_DOWNLOAD_LEVELS (trusted, caution) and not revoked,
//                                         otherwise 403 with the report; a paid skill needs the author's key or an install
//   POST  /api/v1/skills/import           owner/admin key: { git: { url, ref?, path? } } or { archive: <base64> }, or a raw
//                                         .tar.gz/.tar/.zip body; optional price_usd; scanned on import, stored once per hash
//   PATCH /api/v1/skills/:id              the publishing account: { price_usd }
//   POST  /api/v1/skills/:id/install      debit the installer, credit the author 90% and the network fee 10%, signed receipt;
//                                         idempotent per (skill, account); free skills record the install only
//   POST  /api/v1/skills/:id/revoke       operator token: { reason }
// Scanned, not guaranteed: the scan is static analysis of known patterns.

const WRITE: Role[] = ["owner", "admin"];
const INSTALL: Role[] = ["owner", "admin", "member"];
const price = z.number().min(0).max(10_000).transform((v) => usdToPico(v, "floor") / 1_000_000n);
const importSchema = z
  .object({
    git: z.object({ url: z.string().min(1).max(512), ref: z.string().max(128).optional(), path: z.string().max(255).optional() }).strict().optional(),
    archive: z.string().max(12 * 1024 * 1024).optional(),
    path: z.string().max(255).optional(),
    price_usd: price.optional(),
  })
  .strict()
  .refine((b) => !!b.git !== !!b.archive, "Send exactly one of git or archive.");
const patchSchema = z.object({ price_usd: price }).strict();
const revokeSchema = z.object({ reason: z.string().trim().min(3).max(280) }).strict();

const isOperator = (ctx: Ctx, c: Context) => {
  const token = c.req.header("x-admin-token") ?? bearer(c.req.header("authorization"));
  return !!ctx.cfg.adminToken && !!token && safeEqual(token, ctx.cfg.adminToken);
};

export function skillsRoutes(app: Hono, ctx: Ctx) {
  const find = async (c: Context): Promise<SkillRow> => {
    const id = c.req.param("id") ?? "";
    if (!/^sk_[0-9a-f]{24}$/.test(id)) fail(404, "No such skill.", "skill_not_found");
    const [row] = await ctx.db.select().from(skills).where(eq(skills.id, id));
    if (!row) fail(404, "No such skill.", "skill_not_found");
    return row;
  };

  app.get("/api/v1/skills", async (c) => {
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(c.req.query("limit") ?? 50)) || 50));
    const offset = Math.max(0, Math.trunc(Number(c.req.query("offset") ?? 0)) || 0);
    const levels = (c.req.query("level") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (levels.some((l) => !(LEVELS as readonly string[]).includes(l))) fail(400, "`level` is a comma-separated list of trusted, caution and dangerous.", "invalid_request");
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    const where = and(
      c.req.query("include_revoked") === "true" ? undefined : isNull(skills.revokedAt),
      levels.length ? inArray(skills.level, levels) : undefined,
      q ? or(sql`${skills.name} ILIKE ${like}`, sql`${skills.description} ILIKE ${like}`, sql`${skills.author} ILIKE ${like}`, sql`${skills.slug} ILIKE ${like}`) : undefined,
    );
    const rows = await ctx.db.select().from(skills).where(where).orderBy(asc(sql`CASE ${skills.level} WHEN 'trusted' THEN 0 WHEN 'caution' THEN 1 ELSE 2 END`), desc(skills.createdAt)).limit(limit).offset(offset);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(skills).where(where);
    c.header("Cache-Control", "public, max-age=15");
    return c.json({ data: rows.map(summaryJson), total: n, limit, offset, download_levels: ctx.cfg.skills.downloadLevels, note: "Scanned, not guaranteed." });
  });

  app.get("/api/v1/skills/:id", async (c) => {
    const row = await find(c);
    return c.json({ data: { ...detailJson(ctx, row), installs: await installCount(ctx, row.id) } });
  });

  app.get("/api/v1/skills/:id/download", async (c) => {
    const row = await find(c);
    const operator = isOperator(ctx, c);
    if (!operator) {
      assertServable(ctx, row);
      if (row.priceUsdg > 0n) {
        const auth = c.req.header("authorization");
        if (!auth) fail(402, "This is a paid skill. Install it first (POST /api/v1/skills/:id/install), then download it with the same key.", "skill_payment_required", { price_usd: detailJson(ctx, row).price_usd });
        const key = await requireKey(ctx, auth);
        if (key.accountId !== row.accountId && !(await hasInstall(ctx, row.id, key.accountId)))
          fail(402, "This is a paid skill. Install it first (POST /api/v1/skills/:id/install), then download it with the same key.", "skill_payment_required", { price_usd: detailJson(ctx, row).price_usd });
      }
    }
    const body = Buffer.from(row.archive, "base64");
    c.header("Content-Type", "application/gzip");
    c.header("Content-Disposition", `attachment; filename="${row.slug}-${row.version.replace(/[^0-9A-Za-z.+_-]/g, "")}.tar.gz"`);
    c.header("X-Skill-Content-Hash", row.contentHash);
    c.header("X-Skill-Level", row.level);
    c.header("Cache-Control", "no-store");
    return c.body(body);
  });

  app.post("/api/v1/skills/import", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, WRITE);
    const r = await ctx.limiter.take(`skills-import:${key.keyHash}`, 1, 60, 3_600_000);
    if (!r.ok) fail(429, "Too many skill imports from this key. Try again within the hour.", "rate_limited");
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    let normalized;
    let source;
    let priceUsdg = 0n;
    if (type.includes("application/json")) {
      const body = importSchema.parse(await readJson(c));
      priceUsdg = body.price_usd ?? 0n;
      if (body.git) {
        const n = await normalizeGit(ctx, body.git.url, body.git.ref, body.git.path ?? body.path);
        normalized = n;
        source = { kind: "git" as const, repo: body.git.url, ref: body.git.ref ?? "HEAD", commit: n.commit, ...(body.git.path ?? body.path ? { path: body.git.path ?? body.path } : {}) };
      } else {
        const bytes = Buffer.from(body.archive!, "base64");
        normalized = await normalizeArchive(ctx, new Uint8Array(bytes), body.path);
        source = { kind: "upload" as const, ...(body.path ? { path: body.path } : {}) };
      }
    } else if (/application\/(gzip|x-gzip|x-tar|tar|zip|x-zip-compressed|octet-stream)/.test(type)) {
      const cap = ctx.cfg.skills.maxBytes + (ctx.cfg.skills.maxFiles + 4) * 1024;
      if (Number(c.req.header("content-length") ?? 0) > cap) fail(413, `The archive is larger than ${ctx.cfg.skills.maxBytes} bytes.`, "payload_too_large");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length > cap) fail(413, `The archive is larger than ${ctx.cfg.skills.maxBytes} bytes.`, "payload_too_large");
      const q = c.req.query("price_usd");
      if (q !== undefined) priceUsdg = price.parse(Number(q));
      const path = c.req.query("path");
      normalized = await normalizeArchive(ctx, bytes, path);
      source = { kind: "upload" as const, ...(path ? { path } : {}) };
    } else fail(415, "Send JSON ({ git } or { archive }) or an archive body (application/gzip, application/x-tar or application/zip).", "unsupported_media_type");
    const { row, created } = await storeSkill(ctx, normalized, { source, accountId: key.accountId, keyHash: key.keyHash, priceUsdg });
    return c.json({ data: detailJson(ctx, row), created }, created ? 201 : 200);
  });

  app.patch("/api/v1/skills/:id", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, WRITE);
    const row = await find(c);
    if (!row.accountId || row.accountId !== key.accountId) fail(403, "Only the account that published this skill can change it.", "forbidden");
    const body = patchSchema.parse(await readJson(c));
    const [updated] = await ctx.db.update(skills).set({ priceUsdg: body.price_usd, updatedAt: new Date() }).where(eq(skills.id, row.id)).returning();
    return c.json({ data: detailJson(ctx, updated!) });
  });

  app.post("/api/v1/skills/:id/install", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, INSTALL);
    const row = await find(c);
    const { install, created } = await installSkill(ctx, row, { accountId: key.accountId, keyHash: key.keyHash });
    return c.json({ data: { ...installJson(install), download_url: `/api/v1/skills/${row.id}/download` }, created }, created ? 201 : 200);
  });

  app.post("/api/v1/skills/:id/revoke", async (c) => {
    requireOperator(ctx, c);
    const row = await find(c);
    const { reason } = revokeSchema.parse(await readJson(c));
    const [updated] = await ctx.db.update(skills).set({ revokedAt: row.revokedAt ?? new Date(), revokedReason: reason, updatedAt: new Date() }).where(eq(skills.id, row.id)).returning();
    return c.json({ data: detailJson(ctx, updated!) });
  });
}

