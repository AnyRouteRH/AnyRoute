import type { Context, Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { characterUsage, characters } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { uid } from "../lib/util.ts";
import { CardError, SEALED_RE, b64ToBytes, canonicalCardJson, cardHash, greetingsOf, normalizeCard, pickSpeaker, readCardFromPng, toV2, toV3, writeCardToPng, type CharacterCard } from "../characters/card.ts";
import { CHARACTER_PREFIX, ID_RE, loadCharacter } from "../characters/registry.ts";
import { bearer, requireKey, requireRole, resolveKey, type Role } from "./auth.ts";
import { runChat } from "./chat.ts";
import { readJson } from "./common.ts";

// Character registry (Tavern Card v2/v3) and the character chat route. See src/characters/.
//
//   POST   /api/v1/characters                 import a card (JSON or PNG) or register a private (sealed) one
//   GET    /api/v1/characters?tag=&q=         discover public cards (no key); ?mine=1 lists your own, every visibility
//   GET    /api/v1/characters/:id             one card (a private one only to its owner, as ciphertext)
//   GET    /api/v1/characters/:id/export      the card as JSON or PNG, spec v2 or v3
//   PUT    /api/v1/characters/:id             replace the card, visibility or default model
//   DELETE /api/v1/characters/:id
//   GET    /api/v1/characters/:id/greetings   first_mes and the alternate greetings
//   GET    /api/v1/characters/:id/usage       creator attribution: calls and cost per day (owner only)
//   POST   /api/v1/characters/:id/chat        OpenAI chat body + session_id, greeting, regenerate, memory, card
//   POST   /api/v1/characters/group/next      whose turn it is in a group chat
//
// A public or unlisted card is creator-published text, stored as written. A private card is sealed on the client
// (sealCard in @anyroute/client/characters): the router stores the ciphertext and the hash of the plaintext, nothing else.

const READ: Role[] = ["owner", "admin", "member", "viewer"];
const WRITE: Role[] = ["owner", "admin", "member"];
export const MAX_CHARACTERS_PER_ACCOUNT = 200;
export const LIMITS = { cardBytes: 512 * 1024, pngBytes: 8 * 1024 * 1024, sealedBytes: 768 * 1024, tags: 50, tagChars: 64 } as const;
const HASH_RE = /^[0-9a-f]{64}$/;

const bodySchema = z.strictObject({
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  card: z.record(z.string(), z.unknown()).optional(),
  png: z.string().max(Math.ceil((LIMITS.pngBytes * 4) / 3) + 4, "the PNG must be at most 8 MB").optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  sealed_card: z.string().max(LIMITS.sealedBytes).optional(),
  card_hash: z.string().regex(HASH_RE, "64 lowercase hex characters").optional(),
});
type Body = z.infer<typeof bodySchema>;
type Row = typeof characters.$inferSelect;

function view(r: Row, viewer: string | null, full = true) {
  const card = r.card as CharacterCard | null;
  const owner = !!viewer && viewer === r.accountId;
  return {
    id: r.id,
    model: CHARACTER_PREFIX + r.id,
    visibility: r.visibility,
    name: r.name,
    tags: r.tags,
    creator: r.creator,
    spec: r.spec,
    card_hash: r.cardHash,
    default_model: r.defaultModel,
    ...(card
      ? { summary: { description: card.data.description.slice(0, 280), greetings: greetingsOf(card).length, lorebook_entries: card.data.character_book?.entries.length ?? 0 } }
      : {}),
    ...(full && card ? { card } : {}),
    ...(full && owner && r.sealedCard ? { sealed_card: r.sealedCard } : {}),
    owner,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

const notFound = (id: string): never => fail(404, `No character ${CHARACTER_PREFIX}${id.slice(0, 40)}.`, "character_not_found");

/** The card of a public or unlisted POST/PUT: from `card` (v1/v2/v3 JSON) or `png` (base64 with a chara/ccv3 chunk). */
function parseCard(v: Body): CharacterCard {
  if (v.card && v.png) fail(400, "Send the card as `card` (JSON) or `png` (base64), not both.", "invalid_request");
  let card: CharacterCard;
  try {
    if (v.png) {
      const bytes = b64ToBytes(v.png.replace(/^data:image\/png;base64,/, ""));
      if (bytes.length > LIMITS.pngBytes) fail(413, "The PNG must be at most 8 MB.", "payload_too_large");
      card = readCardFromPng(bytes);
    } else if (v.card) card = normalizeCard(v.card);
    else fail(400, "Send the card as `card` (Tavern Card v1, v2 or v3 JSON) or `png` (base64 PNG with a `chara` or `ccv3` chunk).", "invalid_request");
  } catch (e) {
    if (e instanceof CardError) fail(400, e.message, "invalid_card");
    throw e;
  }
  if (new TextEncoder().encode(canonicalCardJson(card)).length > LIMITS.cardBytes) fail(413, `A card must be at most ${LIMITS.cardBytes / 1024} KB as JSON.`, "payload_too_large");
  if (card.data.tags.length > LIMITS.tags) fail(400, `A card may carry at most ${LIMITS.tags} tags.`, "invalid_card");
  return card;
}

function checkSealed(v: Body) {
  if (v.card || v.png) fail(400, "A private card is encrypted on your device: send `sealed_card` and `card_hash` (sealCard in @anyroute/client/characters), never the card itself.", "plaintext_refused");
  if (!v.sealed_card || !v.card_hash) fail(400, "A private card needs `sealed_card` (arm1.<iv>.<ciphertext>) and `card_hash`.", "invalid_request");
  if (!SEALED_RE.test(v.sealed_card)) fail(400, "`sealed_card` is not a sealed value (arm1.<iv>.<ciphertext>, base64url).", "plaintext_refused");
}

async function checkModel(ctx: Ctx, model: string | null | undefined) {
  if (!model) return;
  if (model.startsWith("@")) fail(400, "`model` must be a catalog model id.", "invalid_request");
  await ctx.catalog.ensureFresh();
  if (!ctx.catalog.resolve(model)) fail(404, `Model ${model.slice(0, 120)} is not available. See GET /api/v1/models.`, "model_not_found");
}

/** The columns a card sets: plaintext fields for public/unlisted, only the ciphertext and hash for private. */
async function contentOf(v: Body, visibility: string) {
  if (visibility === "private") {
    checkSealed(v);
    return { name: null, tags: [] as string[], creator: null, spec: null, card: null, sealedCard: v.sealed_card!, cardHash: v.card_hash! };
  }
  if (v.sealed_card || v.card_hash) fail(400, "`sealed_card` and `card_hash` are only for private characters.", "invalid_request");
  const card = parseCard(v);
  return {
    name: card.data.name.slice(0, 200),
    tags: [...new Set(card.data.tags.map((t) => t.slice(0, LIMITS.tagChars).toLowerCase()))],
    creator: card.data.creator.slice(0, 200) || null,
    spec: card.spec,
    card,
    sealedCard: null,
    cardHash: await cardHash(card),
  };
}

export function characterRoutes(app: Hono, ctx: Ctx) {
  const caller = async (c: Context, roles: Role[]) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, roles);
    return key;
  };
  /** The caller's account when a valid key is sent, else null (public reads need none). */
  const viewer = async (c: Context) => {
    const secret = bearer(c.req.header("authorization"));
    return secret ? ((await resolveKey(ctx, secret))?.accountId ?? null) : null;
  };
  const owned = async (c: Context, roles: Role[]) => {
    const key = await caller(c, roles);
    const row = await loadCharacter(ctx, c.req.param("id") ?? "");
    if (!row || row.accountId !== key.accountId) notFound(c.req.param("id") ?? "");
    return { key, row: row! };
  };
  /** A card anyone with the id may read: public or unlisted. */
  const readable = async (c: Context) => {
    const id = c.req.param("id") ?? "";
    const row = await loadCharacter(ctx, id);
    if (!row || row.visibility === "private") notFound(id);
    return row!;
  };

  app.post("/api/v1/characters", async (c) => {
    const key = await caller(c, WRITE);
    const v = bodySchema.parse(await readJson(c));
    const visibility = v.visibility ?? "unlisted";
    const content = await contentOf(v, visibility);
    await checkModel(ctx, v.model);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(characters).where(eq(characters.accountId, key.accountId));
    if (n >= MAX_CHARACTERS_PER_ACCOUNT) fail(409, `An account can keep at most ${MAX_CHARACTERS_PER_ACCOUNT} characters. Delete one first.`, "character_limit_reached");
    const now = new Date();
    const [row] = await ctx.db
      .insert(characters)
      .values({ id: uid("ch_"), accountId: key.accountId, visibility, ...content, defaultModel: v.model ?? null, createdAt: now, updatedAt: now })
      .returning();
    return c.json({ data: view(row!, key.accountId) }, 201);
  });

  app.get("/api/v1/characters", async (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const offset = Math.max(0, Math.min(10_000, Number(c.req.query("offset") ?? 0) || 0));
    if (c.req.query("mine") === "1" || c.req.query("mine") === "true") {
      const key = await caller(c, READ);
      const rows = await ctx.db.select().from(characters).where(eq(characters.accountId, key.accountId)).orderBy(desc(characters.updatedAt)).limit(limit).offset(offset);
      return c.json({ data: rows.map((r) => view(r, key.accountId, false)), limit: MAX_CHARACTERS_PER_ACCOUNT });
    }
    const where = [eq(characters.visibility, "public")];
    const tag = c.req.query("tag")?.trim().toLowerCase().slice(0, LIMITS.tagChars);
    if (tag) where.push(sql`${characters.tags} @> ARRAY[${tag}]::text[]`);
    const q = c.req.query("q")?.trim().slice(0, 100);
    if (q) {
      const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
      where.push(sql`(${characters.name} ilike ${like} or ${characters.creator} ilike ${like})`);
    }
    const rows = await ctx.db.select().from(characters).where(and(...where)).orderBy(desc(characters.updatedAt)).limit(limit).offset(offset);
    const me = await viewer(c);
    return c.json({ data: rows.map((r) => view(r, me, false)) });
  });

  // Group chats: whose turn it is. Members are characters the caller can read; nothing is stored.
  app.post("/api/v1/characters/group/next", async (c) => {
    const v = z
      .strictObject({
        members: z.array(z.string().regex(ID_RE, "a character id (ch_...)")).min(1).max(16),
        mode: z.enum(["round_robin", "named"]).optional(),
        messages: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
        last_speaker: z.string().max(40).optional(),
      })
      .parse(await readJson(c));
    const me = await viewer(c);
    const members = [];
    for (const id of v.members) {
      const row = await loadCharacter(ctx, id);
      if (!row || (row.visibility === "private" && row.accountId !== me)) notFound(id);
      members.push({ id, name: row!.name ?? id });
    }
    const pick = pickSpeaker(members, (v.messages ?? []) as never, v.mode ?? "round_robin", v.last_speaker);
    return c.json({ data: { ...pick, name: members[pick.index]!.name, model: CHARACTER_PREFIX + pick.next } });
  });

  app.get("/api/v1/characters/:id", async (c) => {
    const id = c.req.param("id");
    const row = await loadCharacter(ctx, id);
    const me = await viewer(c);
    if (!row || (row.visibility === "private" && row.accountId !== me)) notFound(id);
    return c.json({ data: view(row!, me) });
  });

  app.get("/api/v1/characters/:id/export", async (c) => {
    const row = await readable(c);
    const format = c.req.query("format") ?? "json";
    const spec = c.req.query("spec") ?? (row.spec === "chara_card_v2" ? "v2" : "v3");
    if (!["json", "png"].includes(format) || !["v2", "v3"].includes(spec)) fail(400, "`format` is json or png; `spec` is v2 or v3.", "invalid_request");
    const card = row.card as CharacterCard;
    const file = (row.name ?? row.id).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || row.id;
    if (format === "png") {
      const png = writeCardToPng(card, null, spec as "v2" | "v3");
      return new Response(png as unknown as ArrayBuffer, { headers: { "content-type": "image/png", "content-disposition": `attachment; filename="${file}.png"`, "x-anyroute-card-hash": row.cardHash } });
    }
    c.header("content-disposition", `attachment; filename="${file}.json"`);
    return c.json(spec === "v2" ? toV2(card) : toV3(card));
  });

  app.put("/api/v1/characters/:id", async (c) => {
    const { key, row } = await owned(c, WRITE);
    const v = bodySchema.parse(await readJson(c));
    const visibility = v.visibility ?? row.visibility;
    const changesContent = !!(v.card || v.png || v.sealed_card || v.card_hash);
    // Moving between private and shared always replaces the content: a private card cannot become readable without the
    // caller sending the card, and a shared card's plaintext is dropped when it turns private.
    const crosses = (visibility === "private") !== (row.visibility === "private");
    if (crosses && !changesContent)
      fail(400, visibility === "private" ? "Making a character private replaces its card with `sealed_card` and `card_hash`." : "Making a private character shared needs the card itself in `card` or `png`.", "invalid_request");
    const content = changesContent ? await contentOf(v, visibility) : {};
    if (v.model !== undefined) await checkModel(ctx, v.model);
    const [updated] = await ctx.db
      .update(characters)
      .set({ visibility, ...content, ...(v.model !== undefined ? { defaultModel: v.model } : {}), updatedAt: new Date() })
      .where(eq(characters.id, row.id))
      .returning();
    return c.json({ data: view(updated!, key.accountId) });
  });

  app.delete("/api/v1/characters/:id", async (c) => {
    const { row } = await owned(c, WRITE);
    await ctx.db.delete(characters).where(eq(characters.id, row.id));
    await ctx.db.delete(characterUsage).where(eq(characterUsage.characterId, row.id));
    return c.json({ data: { id: row.id, deleted: true } });
  });

  app.get("/api/v1/characters/:id/greetings", async (c) => {
    const row = await readable(c);
    return c.json({ data: { id: row.id, greetings: greetingsOf(row.card as CharacterCard) } });
  });

  app.get("/api/v1/characters/:id/usage", async (c) => {
    const { row } = await owned(c, READ);
    const rows = await ctx.db.select().from(characterUsage).where(eq(characterUsage.characterId, row.id)).orderBy(desc(characterUsage.period)).limit(366);
    return c.json({
      data: rows.map((r) => ({ period: r.period, calls: r.calls, cost_usd: picoToUsd(r.cost) })),
      note: row.visibility === "public" ? "Calls and cost per UTC day. No request, answer or caller is recorded." : "Attribution is recorded for public characters only.",
    });
  });

  app.post("/api/v1/characters/:id/chat", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) notFound(id);
    return runChat(ctx, c, "chat", id);
  });
}
