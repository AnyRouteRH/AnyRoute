import type { Context } from "hono";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { characterUsage, characters } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import type { Pico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { modelLanes, servable } from "../api/models.ts";
import { CardError, buildCharacterMessages, cardHash, greetingsOf, normalizeCard, type CharacterCard, type ChatMessage } from "./card.ts";

// Character runtime: `model: "@character/<id>"` on /api/v1/chat/completions, and POST /api/v1/characters/:id/chat.
//
// The card becomes the system prompt (src/characters/card.ts buildCharacterMessages): system_prompt, lorebook entries matched
// in this request, description, personality, scenario, the memory the client sent, example dialogue, the greeting, the
// conversation, then post_history_instructions. Everything is assembled in memory for this one call and then goes through
// the normal chat path, so lanes, budgets, holds and receipts apply unchanged.
//
// A private card is stored only as ciphertext: the caller sends the decrypted card in `card`, and the router checks its hash
// against the stored card_hash before using it. Memory (`memory`) is whatever the client decrypted and chose to send; the
// router never stores it. Neither the card nor the memory is written anywhere by this call.
//
// The lane defaults to "attested" when the model has an attested provider right now; otherwise the call runs on the public
// lane and the response says so (X-Anyroute-Character-Note). A lane the caller asks for (provider.lane or X-Anyroute-Lane)
// is never changed.

export const CHARACTER_PREFIX = "@character/";
export const ID_RE = /^ch_[0-9a-f]{24}$/;

const extrasSchema = z
  .object({
    session_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "1-128 letters, digits, dots, colons, underscores or hyphens").optional(),
    greeting: z.number().int().min(0).max(1000).optional(),
    regenerate: z.boolean().optional(),
    user_name: z.string().trim().max(64).optional(),
    memory: z
      .strictObject({
        summary: z.string().max(16_000).optional(),
        facts: z.array(z.string().max(2_000)).max(200).optional(),
      })
      .optional(),
    card: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const EXTRA_FIELDS = ["session_id", "greeting", "regenerate", "user_name", "memory", "card"] as const;

export type CharacterMeta = { id: string; card_hash: string; visibility: string; attribute: boolean; lane: string; note: string | null; lore: (string | number)[]; greeting: number | null };

export async function loadCharacter(ctx: Ctx, id: string) {
  if (!ID_RE.test(id)) return null;
  const [row] = await ctx.db.select().from(characters).where(eq(characters.id, id));
  return row ?? null;
}

/** The decrypted card a caller sent for a private character, checked against the stored hash. */
export async function checkedPrivateCard(sent: unknown, expectedHash: string): Promise<CharacterCard> {
  let card: CharacterCard;
  try {
    card = normalizeCard(sent);
  } catch (e) {
    fail(400, `\`card\`: ${(e as Error).message}`, "invalid_card");
  }
  if ((await cardHash(card)) !== expectedHash) fail(409, "The card sent does not match this private character's card_hash. Send the card exactly as it was sealed.", "card_hash_mismatch");
  return card;
}

/**
 * Chat hook: when `model` is `@character/<id>` (or the route forces an id), assemble the character's messages into the body
 * in place and pick the lane. Returns null when the request names no character.
 */
export async function resolveCharacter(ctx: Ctx, c: Context, body: Record<string, unknown>, accountId: string | null, kind: string, forcedId?: string): Promise<CharacterMeta | null> {
  if (Array.isArray(body.models) && body.models.some((m) => typeof m === "string" && m.startsWith(CHARACTER_PREFIX)))
    fail(400, "`models` cannot contain `@character/` entries; pass a character as `model`.", "invalid_request");
  const proxied = typeof body.model === "string" && body.model.startsWith(CHARACTER_PREFIX);
  const id = forcedId ?? (proxied ? (body.model as string).slice(CHARACTER_PREFIX.length) : null);
  if (id === null) return null;
  if (kind !== "chat") fail(400, "A character can only be used on /api/v1/chat/completions.", "invalid_request");
  const extras = extrasSchema.parse(body);
  for (const k of EXTRA_FIELDS) delete body[k]; // never forwarded to a provider

  const row = await loadCharacter(ctx, id);
  const own = !!accountId && row?.accountId === accountId;
  if (!row || (row.visibility === "private" && !own)) fail(404, `No character ${CHARACTER_PREFIX}${id.slice(0, 40)}. Find public ones with GET /api/v1/characters.`, "character_not_found");
  let card: CharacterCard;
  if (row.visibility === "private") {
    if (!extras.card) fail(400, "This character is private: the router keeps only its ciphertext. Send the decrypted card in `card` (openCard in @anyroute/client/characters).", "card_required");
    card = await checkedPrivateCard(extras.card, row.cardHash);
  } else {
    if (extras.card) fail(400, "`card` is only sent for a private character; this one is stored on the router.", "invalid_request");
    card = row.card as CharacterCard;
  }

  // The model: `model` on the character route, `models[0]` in proxy mode, else the character's default.
  let llm: string | null = null;
  if (forcedId && !proxied && typeof body.model === "string" && body.model.trim()) llm = body.model.trim();
  else if (proxied && Array.isArray(body.models) && typeof body.models[0] === "string") {
    llm = body.models[0] as string;
    body.models = (body.models as string[]).slice(1);
  }
  llm ??= row.defaultModel;
  if (!llm) fail(400, `${CHARACTER_PREFIX}${row.id} has no default model: name one (\`model\` on /characters/:id/chat, or \`models: [<model>]\` with the proxy).`, "model_required");
  if (llm.startsWith("@")) fail(400, "A character's model must be a catalog model id, not a @route/, @preset/ or @character/.", "invalid_request");

  let built;
  try {
    built = buildCharacterMessages(card, (body.messages ?? []) as ChatMessage[], { userName: extras.user_name, greeting: extras.greeting, regenerate: extras.regenerate, memory: extras.memory });
  } catch (e) {
    if (e instanceof CardError) fail(409, `This character's card no longer loads: ${e.message}`, "invalid_card");
    throw e;
  }
  body.model = llm;
  body.messages = built.messages;

  // Lane: attested by default when the model can be served there now; a lane the caller chose is left alone.
  const provider = (body.provider && typeof body.provider === "object" ? body.provider : {}) as Record<string, unknown>;
  const asked = (typeof provider.lane === "string" ? provider.lane : null) ?? c.req.header("x-anyroute-lane") ?? null;
  let lane = asked ?? "public";
  let note: string | null = null;
  if (!asked) {
    await ctx.catalog.ensureFresh();
    const r = ctx.catalog.resolve(llm);
    if (r && modelLanes(ctx, servable(ctx, r.model)).includes("attested")) {
      body.provider = { ...provider, lane: "attested" };
      lane = "attested";
    } else note = `${llm.slice(0, 120)} has no attested provider right now, so this character chat runs on the public lane.`;
  }
  c.header("x-anyroute-character", row.id);
  c.header("x-anyroute-character-lane", lane);
  if (note) c.header("x-anyroute-character-note", note);
  if (extras.session_id) c.header("x-anyroute-character-session", extras.session_id);
  return { id: row.id, card_hash: row.cardHash, visibility: row.visibility, attribute: row.visibility === "public", lane, note, lore: built.lore, greeting: built.greeting };
}

/** Creator attribution for a public card: one more call and its cost for today (UTC). Never the request or who made it. */
export async function recordCharacterUse(ctx: Ctx, characterId: string, cost: Pico) {
  const period = new Date().toISOString().slice(0, 10);
  await ctx.db
    .insert(characterUsage)
    .values({ characterId, period, calls: 1, cost })
    .onConflictDoUpdate({ target: [characterUsage.characterId, characterUsage.period], set: { calls: sql`${characterUsage.calls} + 1`, cost: sql`${characterUsage.cost} + ${cost}` } })
    .catch((e) => log.error("recording character attribution failed", { error: (e as Error).message }));
}

export { greetingsOf };
