import type { Context, Hono } from "hono";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { presetVersions } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import {
  LIMITS,
  MAX_PRESETS_PER_ACCOUNT,
  MAX_VERSIONS_PER_PRESET,
  PRESET_PREFIX,
  diffJson,
  findPresetVersion,
  lockAccountPresets,
  normalizePreset,
  parseVersionRef,
  presetDocSchema,
  presetHash,
  rollbackSchema,
  type PresetDoc,
} from "../routing/presets.ts";
import { SLUG_RE, type RouteConfig } from "../routing/saved-routes.ts";
import { requireKey, requireRole, type Role } from "./auth.ts";
import { readJson } from "./common.ts";
import { assertModels, assertRouteLane } from "./saved-routes.ts";

// Presets: versioned config-as-code for `model: "@preset/<name>[@<version>]"` (src/routing/presets.ts).
// Any role on the account can read them; owners and admins write, like saved routes.

type Row = typeof presetVersions.$inferSelect;
const READ: Role[] = ["owner", "admin", "member", "viewer"];
const WRITE: Role[] = ["owner", "admin"];

const versionJson = (r: Row) => ({
  version: r.version,
  hash: r.hash,
  model: `${PRESET_PREFIX}${r.name}@${r.version}`,
  source: r.source,
  ...(r.restoredFrom != null ? { restored_from: r.restoredFrom } : {}),
  created_at: r.createdAt.toISOString(),
});

export function presetJson(latest: Row, first?: Row) {
  const config = latest.config as PresetDoc;
  return {
    name: latest.name,
    model: PRESET_PREFIX + latest.name,
    description: config.description ?? "",
    version: latest.version,
    hash: latest.hash,
    config,
    created_at: (first ?? latest).createdAt.toISOString(),
    updated_at: latest.createdAt.toISOString(),
  };
}

function notFound(name: string): never {
  fail(404, `No preset @preset/${name.slice(0, 60)} in this account.`, "preset_not_found");
}

/** The catalog and lane checks a saved route gets, on the preset's routing part. */
async function assertRoutable(ctx: Ctx, doc: PresetDoc) {
  await assertModels(ctx, doc.models); // outside the transaction: the catalog reads through ctx.db
  assertRouteLane(ctx, { models: doc.models, provider: doc.provider } as RouteConfig);
}

export function presetsRoutes(app: Hono, ctx: Ctx) {
  const caller = async (c: Context, roles: Role[]) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, roles);
    return key;
  };
  const nameOf = (c: Context) => {
    const name = c.req.param("name") ?? "";
    if (!SLUG_RE.test(name)) notFound(name);
    return name;
  };
  const firstOf = async (accountId: string, name: string) =>
    (await ctx.db.select().from(presetVersions).where(and(eq(presetVersions.accountId, accountId), eq(presetVersions.name, name), eq(presetVersions.version, 1))))[0];

  /** Append a version with `doc` unless it equals the latest one. Returns [latest, created]. */
  const append = async (accountId: string, keyHash: string, name: string, doc: PresetDoc, source: "put" | "rollback", restoredFrom: number | null, mustExist: boolean) =>
    ctx.db.transaction(async (tx) => {
      await lockAccountPresets(tx, accountId);
      const latest = await findPresetVersion(tx, accountId, name);
      if (!latest && mustExist) notFound(name);
      const hash = presetHash(doc);
      if (latest && latest.hash === hash) return [latest, false] as const;
      if (!latest) {
        const [{ n }] = await tx.select({ n: sql<number>`count(distinct ${presetVersions.name})::int` }).from(presetVersions).where(eq(presetVersions.accountId, accountId));
        if (n >= MAX_PRESETS_PER_ACCOUNT) fail(409, `An account can save at most ${MAX_PRESETS_PER_ACCOUNT} presets. Delete one first.`, "preset_limit_reached", { limit: MAX_PRESETS_PER_ACCOUNT });
      } else if (latest.version >= MAX_VERSIONS_PER_PRESET)
        fail(409, `@preset/${name} has ${MAX_VERSIONS_PER_PRESET} versions, the most a preset keeps. Save it under a new name, or delete it and start again.`, "preset_version_limit", { limit: MAX_VERSIONS_PER_PRESET });
      const [row] = await tx
        .insert(presetVersions)
        .values({ id: uid("pv_"), accountId, name, version: (latest?.version ?? 0) + 1, hash, config: normalizePreset(doc), source, restoredFrom, createdBy: keyHash, createdAt: new Date() })
        .returning();
      return [row!, true] as const;
    });

  app.get("/api/v1/presets", async (c) => {
    const key = await caller(c, READ);
    const rows = await ctx.db.select().from(presetVersions).where(eq(presetVersions.accountId, key.accountId)).orderBy(asc(presetVersions.name), asc(presetVersions.version));
    const byName = new Map<string, Row[]>();
    for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    const data = [...byName.values()].map((v) => ({ ...presetJson(v.at(-1)!, v[0]), versions: v.length }));
    return c.json({ data, limit: MAX_PRESETS_PER_ACCOUNT, limits: { versions_per_preset: MAX_VERSIONS_PER_PRESET, system_prompt_chars: LIMITS.systemPromptChars, tools: LIMITS.tools, preset_bytes: LIMITS.presetBytes } });
  });

  // GET /api/v1/presets/:name[?version=<n|hash>]: the latest version, or the one asked for.
  app.get("/api/v1/presets/:name", async (c) => {
    const key = await caller(c, READ);
    const name = nameOf(c);
    const ref = c.req.query("version") ?? null;
    if (ref !== null && !parseVersionRef(ref)) fail(400, "`version` is a number (3 or v3) or a hash prefix of at least 7 hex characters.", "invalid_request");
    const row = await findPresetVersion(ctx.db, key.accountId, name, ref);
    if (!row) {
      if (ref !== null && (await findPresetVersion(ctx.db, key.accountId, name))) fail(404, `@preset/${name} has no version ${ref.slice(0, 64)}.`, "preset_version_not_found");
      notFound(name);
    }
    const latest = ref === null ? row : await findPresetVersion(ctx.db, key.accountId, name);
    return c.json({ data: { ...presetJson(row, await firstOf(key.accountId, name)), latest_version: latest!.version } });
  });

  // PUT creates the preset or appends a version. The body is the whole preset document; an unchanged one adds nothing.
  app.put("/api/v1/presets/:name", async (c) => {
    const key = await caller(c, WRITE);
    const name = nameOf(c);
    const doc = presetDocSchema.parse(await readJson(c));
    await assertRoutable(ctx, normalizePreset(doc));
    const [row, created] = await append(key.accountId, key.keyHash, name, doc, "put", null, false);
    return c.json({ data: { ...presetJson(row, await firstOf(key.accountId, name)), changed: created } }, created && row.version === 1 ? 201 : 200);
  });

  app.delete("/api/v1/presets/:name", async (c) => {
    const key = await caller(c, WRITE);
    const name = nameOf(c);
    const gone = await ctx.db
      .delete(presetVersions)
      .where(and(eq(presetVersions.accountId, key.accountId), eq(presetVersions.name, name)))
      .returning({ version: presetVersions.version });
    if (!gone.length) notFound(name);
    return c.json({ data: { name, model: PRESET_PREFIX + name, deleted: true, versions: gone.length } });
  });

  app.get("/api/v1/presets/:name/versions", async (c) => {
    const key = await caller(c, READ);
    const name = nameOf(c);
    const rows = await ctx.db.select().from(presetVersions).where(and(eq(presetVersions.accountId, key.accountId), eq(presetVersions.name, name))).orderBy(desc(presetVersions.version));
    if (!rows.length) notFound(name);
    return c.json({ data: rows.map(versionJson), latest: rows[0]!.version, limit: MAX_VERSIONS_PER_PRESET });
  });

  // GET /api/v1/presets/:name/diff?from=<v>&to=<v>: `to` defaults to the latest version, `from` to the one before `to`.
  app.get("/api/v1/presets/:name/diff", async (c) => {
    const key = await caller(c, READ);
    const name = nameOf(c);
    const pick = async (param: "from" | "to", fallback: number | null) => {
      const raw = c.req.query(param) ?? (fallback === null ? null : String(fallback));
      if (raw !== null && !parseVersionRef(raw)) fail(400, `\`${param}\` is a version number (3 or v3) or a hash prefix of at least 7 hex characters.`, "invalid_request");
      const row = await findPresetVersion(ctx.db, key.accountId, name, raw);
      if (!row) {
        if (await findPresetVersion(ctx.db, key.accountId, name)) fail(404, `@preset/${name} has no version ${String(raw).slice(0, 64)}.`, "preset_version_not_found");
        notFound(name);
      }
      return row;
    };
    const to = await pick("to", null);
    const from = c.req.query("from") !== undefined ? await pick("from", null) : to.version > 1 ? await pick("from", to.version - 1) : to;
    const changes = diffJson(from.config, to.config);
    return c.json({ data: { name, from: versionJson(from), to: versionJson(to), identical: from.hash === to.hash, changes } });
  });

  // POST /api/v1/presets/:name/rollback { version }: append a new version with that version's content.
  app.post("/api/v1/presets/:name/rollback", async (c) => {
    const key = await caller(c, WRITE);
    const name = nameOf(c);
    const v = rollbackSchema.parse(await readJson(c));
    if (!parseVersionRef(v.version)) fail(400, "`version` is a number (3 or v3) or a hash prefix of at least 7 hex characters.", "invalid_request");
    const target = await findPresetVersion(ctx.db, key.accountId, name, v.version);
    if (!target) {
      if (await findPresetVersion(ctx.db, key.accountId, name)) fail(404, `@preset/${name} has no version ${String(v.version).slice(0, 64)}.`, "preset_version_not_found");
      notFound(name);
    }
    const doc = presetDocSchema.safeParse(target.config);
    if (!doc.success) fail(409, `Version ${target.version} of @preset/${name} no longer validates, so it cannot be restored.`, "preset_invalid");
    // The models and lane are checked again: a rollback must not bring back a version the catalog can no longer serve.
    await assertRoutable(ctx, doc.data);
    const [row, created] = await append(key.accountId, key.keyHash, name, doc.data, "rollback", target.version, true);
    return c.json({ data: { ...presetJson(row, await firstOf(key.accountId, name)), changed: created, restored_from: target.version } });
  });
}
