import { and, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { blindNullifiers } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { picoToUsd, type Pico } from "../lib/money.ts";
import { keyValue, type VerifiedToken } from "./issuer.ts";
import { decodeBase64 } from "./privacy-token.ts";

export type TokenSet = VerifiedToken[];

/** Extension: PrivateToken token=A, token=B. A single parameter keeps the original parser and reply. */
export async function presentSet(ctx: Ctx, header: string | null | undefined) {
  if (!ctx.blind || !header || !/^\s*PrivateToken\s/i.test(header)) return null;
  const params = header.replace(/^\s*PrivateToken\s+/i, "").split(",");
  if (params.filter((p) => /^\s*(?:PrivateToken\s+)?token\s*=/i.test(p)).length < 2) return null;
  if (!ctx.cfg.blind.multiTokenEnabled) throw new ApiError(501, "Token sets are not enabled on this router.", "token_sets_disabled");
  if (params.length > ctx.cfg.blind.maxTokensPerRequest) throw new ApiError(400, "Too many tokens in this request.", "too_many_tokens", { max_tokens_per_request: ctx.cfg.blind.maxTokensPerRequest });
  const tokens: TokenSet = [];
  for (const param of params) {
    const match = /^\s*token=(?:"([A-Za-z0-9_+/=-]+)"|([A-Za-z0-9_+/=-]+))\s*$/i.exec(param);
    const bytes = match && decodeBase64(match[1] ?? match[2]);
    if (!bytes) throw new ApiError(401, "Malformed token set: expected PrivateToken token=A, token=B.", "invalid_token", undefined, ctx.blind.challengeHeader);
    tokens.push(await ctx.blind.verify(bytes));
  }
  if (new Set(tokens.map((t) => t.nullifier)).size !== tokens.length) throw new ApiError(401, "A token may appear only once in a request.", "invalid_token", undefined, ctx.blind.challengeHeader);
  return { ...tokens[0], tokens, value: tokens.reduce((sum, t) => sum + keyValue(t.key), 0n) };
}

/** Sorted insertion avoids deadlocks for overlapping sets; any conflict rolls back every new reservation. */
export async function claimSet(ctx: Ctx, tokens: TokenSet) {
  await ctx.db.transaction(async (tx) => {
    const rows = await tx.insert(blindNullifiers).values([...tokens].sort((a, b) => a.nullifier.localeCompare(b.nullifier)).map((t) => ({ nullifier: t.nullifier, keyId: t.keyId }))).onConflictDoNothing().returning({ n: blindNullifiers.nullifier });
    if (rows.length !== tokens.length) throw new ApiError(401, "A token in this set was already spent.", "token_spent", undefined, ctx.blind?.challengeHeader);
  });
}

export async function releaseSet(ctx: Ctx, tokens: TokenSet) {
  await ctx.db.delete(blindNullifiers).where(and(inArray(blindNullifiers.nullifier, tokens.map((t) => t.nullifier)), eq(blindNullifiers.status, "reserved")));
}

export async function confirmSet(ctx: Ctx, tokens: TokenSet, generationId: string) {
  await ctx.db.update(blindNullifiers).set({ status: "spent", spentAt: new Date(), generationId }).where(inArray(blindNullifiers.nullifier, tokens.map((t) => t.nullifier)));
}

/** Payment facts only: no credential bytes, purchaser, address or client/session identifier. */
export function blindReceipt(pass: VerifiedToken & { tokens?: TokenSet }) {
  return pass.tokens ? { token_count: pass.tokens.length, nullifiers: pass.tokens.map((t) => t.nullifier), token_key_ids: pass.tokens.map((t) => t.keyId) } : { nullifier: pass.nullifier, token_key_id: pass.keyId };
}

export function setSummary(pass: VerifiedToken & { tokens?: TokenSet; value: Pico }, charged: Pico) {
  return { ...blindReceipt(pass), token_value_usd: picoToUsd(pass.value), unspent_value_forfeited_usd: picoToUsd(pass.value > charged ? pass.value - charged : 0n) };
}
