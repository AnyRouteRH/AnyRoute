import type { Context, Hono } from "hono";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { characterMemory } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { KEY_ID_RE, SCOPE_RE, SEALED_RE } from "../characters/card.ts";
import { requireKey, requireRole, type Role } from "./auth.ts";
import { readJson } from "./common.ts";

// Character memory: a ledger of blobs the client sealed (AES-256-GCM, arm1.<iv>.<ciphertext>) under a viewing key it
// derived itself and never sends. The router stores the ciphertext, an opaque scope (an HMAC of the character id under the
// client's key, so the router cannot tell which character a blob belongs to), the kind, the size and, only when the
// client opts in, an embedding vector for similarity search.
//
// The trade-off of opting in: an embedding is computed from the memory's text, so while it cannot be turned back into the
// text, it can reveal what the memory is about to whoever holds the database. It is off by default; without it the client
// ranks memories itself after opening them.
//
//   POST   /api/v1/memory             store a sealed blob
//   PUT    /api/v1/memory/:id         replace it (a rolling summary)
//   GET    /api/v1/memory?scope=      the ledger: ids, kinds, sizes, dates (no ciphertext); &with=sealed adds it
//   GET    /api/v1/memory/:id         one blob with its ciphertext
//   DELETE /api/v1/memory/:id         one blob; DELETE /api/v1/memory?scope=<scope> or ?all=1 many
//   POST   /api/v1/memory/search      nearest blobs to a query vector (opted-in embeddings only)

const READ: Role[] = ["owner", "admin", "member", "viewer"];
const WRITE: Role[] = ["owner", "admin", "member"];
export const MEMORY_LIMITS = { items: 5_000, sealedChars: 96 * 1024, dims: 4_096, searchK: 50 } as const;
const MEM_ID = /^mem_[0-9a-f]{24}$/;

const sealed = z.string().max(MEMORY_LIMITS.sealedChars).refine((s) => SEALED_RE.test(s), "must be a sealed value (arm1.<iv>.<ciphertext>, base64url); plaintext is refused");
const vector = z.array(z.number().finite()).min(1).max(MEMORY_LIMITS.dims);
const writeSchema = z
  .strictObject({
    scope: z.string().regex(SCOPE_RE, "32 lowercase hex characters (memoryScope in @anyroute/client/characters)"),
    kind: z.enum(["summary", "fact", "lorebook", "state"]),
    sealed,
    key_id: z.string().regex(KEY_ID_RE, "16 lowercase hex characters"),
    embedding: vector.optional(),
    embedding_opt_in: z.literal(true).optional(),
  })
  .superRefine((v, c) => {
    if (v.embedding && !v.embedding_opt_in) c.addIssue({ code: "custom", path: ["embedding"], message: "an embedding is stored only with embedding_opt_in: true (it can reveal what the memory is about)" });
  });
const updateSchema = z
  .strictObject({ sealed, key_id: z.string().regex(KEY_ID_RE), embedding: vector.nullable().optional(), embedding_opt_in: z.literal(true).optional() })
  .superRefine((v, c) => {
    if (v.embedding && !v.embedding_opt_in) c.addIssue({ code: "custom", path: ["embedding"], message: "an embedding is stored only with embedding_opt_in: true" });
  });

type Row = typeof characterMemory.$inferSelect;
const ledger = (r: Row, withSealed = false) => ({
  id: r.id,
  scope: r.scope,
  kind: r.kind,
  key_id: r.keyId,
  bytes: r.bytes,
  has_embedding: !!r.embedding?.length,
  dims: r.embedding?.length ?? 0,
  ...(withSealed ? { sealed: r.sealed } : {}),
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function memoryRoutes(app: Hono, ctx: Ctx) {
  const caller = async (c: Context, roles: Role[]) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, roles);
    return key;
  };
  const mine = async (c: Context, roles: Role[]) => {
    const key = await caller(c, roles);
    const id = c.req.param("id") ?? "";
    const [row] = MEM_ID.test(id) ? await ctx.db.select().from(characterMemory).where(and(eq(characterMemory.id, id), eq(characterMemory.accountId, key.accountId))) : [];
    if (!row) fail(404, "No such memory in this account.", "memory_not_found");
    return { key, row };
  };

  app.post("/api/v1/memory", async (c) => {
    const key = await caller(c, WRITE);
    const v = writeSchema.parse(await readJson(c));
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(characterMemory).where(eq(characterMemory.accountId, key.accountId));
    if (n >= MEMORY_LIMITS.items) fail(409, `An account can keep at most ${MEMORY_LIMITS.items} memories. Delete some first.`, "memory_limit_reached");
    const now = new Date();
    const [row] = await ctx.db
      .insert(characterMemory)
      .values({ id: uid("mem_"), accountId: key.accountId, scope: v.scope, kind: v.kind, sealed: v.sealed, keyId: v.key_id, bytes: v.sealed.length, embedding: v.embedding ?? null, createdAt: now, updatedAt: now })
      .returning();
    return c.json({ data: ledger(row!) }, 201);
  });

  app.put("/api/v1/memory/:id", async (c) => {
    const { row } = await mine(c, WRITE);
    const v = updateSchema.parse(await readJson(c));
    const [updated] = await ctx.db
      .update(characterMemory)
      .set({ sealed: v.sealed, keyId: v.key_id, bytes: v.sealed.length, ...(v.embedding !== undefined ? { embedding: v.embedding } : {}), updatedAt: new Date() })
      .where(eq(characterMemory.id, row.id))
      .returning();
    return c.json({ data: ledger(updated!) });
  });

  app.get("/api/v1/memory", async (c) => {
    const key = await caller(c, READ);
    const scope = c.req.query("scope");
    if (scope !== undefined && !SCOPE_RE.test(scope)) fail(400, "`scope` is 32 lowercase hex characters.", "invalid_request");
    const where = [eq(characterMemory.accountId, key.accountId), ...(scope ? [eq(characterMemory.scope, scope)] : [])];
    const rows = await ctx.db.select().from(characterMemory).where(and(...where)).orderBy(asc(characterMemory.scope), asc(characterMemory.createdAt)).limit(MEMORY_LIMITS.items);
    const withSealed = c.req.query("with") === "sealed";
    return c.json({ data: rows.map((r) => ledger(r, withSealed)), total_bytes: rows.reduce((n, r) => n + r.bytes, 0), limit: MEMORY_LIMITS.items });
  });

  app.get("/api/v1/memory/:id", async (c) => {
    const { row } = await mine(c, READ);
    return c.json({ data: ledger(row, true) });
  });

  app.delete("/api/v1/memory/:id", async (c) => {
    const { row } = await mine(c, WRITE);
    await ctx.db.delete(characterMemory).where(eq(characterMemory.id, row.id));
    return c.json({ data: { id: row.id, deleted: true } });
  });

  app.delete("/api/v1/memory", async (c) => {
    const key = await caller(c, WRITE);
    const scope = c.req.query("scope");
    const all = c.req.query("all") === "1";
    if (!all && (!scope || !SCOPE_RE.test(scope))) fail(400, "Name the memories to delete: `?scope=<32 hex>` or `?all=1`.", "invalid_request");
    const gone = await ctx.db
      .delete(characterMemory)
      .where(and(eq(characterMemory.accountId, key.accountId), ...(all ? [] : [eq(characterMemory.scope, scope!)])))
      .returning({ id: characterMemory.id });
    return c.json({ data: { deleted: gone.length } });
  });

  app.post("/api/v1/memory/search", async (c) => {
    const key = await caller(c, READ);
    const v = z.strictObject({ scope: z.string().regex(SCOPE_RE), embedding: vector, k: z.number().int().min(1).max(MEMORY_LIMITS.searchK).optional() }).parse(await readJson(c));
    const rows = await ctx.db
      .select()
      .from(characterMemory)
      .where(and(eq(characterMemory.accountId, key.accountId), eq(characterMemory.scope, v.scope), isNotNull(characterMemory.embedding)));
    const scored = rows
      .filter((r) => r.embedding!.length === v.embedding.length)
      .map((r) => ({ id: r.id, kind: r.kind, score: cosine(v.embedding, r.embedding!), sealed: r.sealed }))
      .sort((a, b) => b.score - a.score)
      .slice(0, v.k ?? 8);
    return c.json({ data: scored });
  });
}
