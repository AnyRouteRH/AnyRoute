import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { blindNullifiers } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { picoToUsd, type Pico } from "../lib/money.ts";
import { ensureAccount } from "../ledger/ledger.ts";
import type { VerifiedToken } from "./issuer.ts";
import { parsePrivateToken } from "./token.ts";

// Redeeming a token on a request. Every blind redemption is charged to one pooled internal account, so the
// ledger, the generation row and the receipt carry no buyer: the receipt has the token's nullifier (a hash)
// and nothing that names an account.
//
//   present  verify the token (signature, epoch, challenge) without spending it
//   claim    insert its nullifier under the primary-key constraint; a second claim of the same token fails
//   confirm  after the request was served, mark the nullifier spent and record the generation
//   unclaim  if nothing was served, delete the reservation so the token is not lost

export const BLIND_POOL = "blind_pool";

export type BlindPass = VerifiedToken & { value: Pico };

export const tokenValue = (ctx: Ctx, denomination: number): Pico => BigInt(denomination) * ctx.cfg.blind.unitPricePico;

export const ensurePool = (ctx: Ctx) => ensureAccount(ctx.db, BLIND_POOL, "blind_pool");

/**
 * The verified token on an Authorization: PrivateToken header, or null when the feature is off or the header
 * uses another scheme. A PrivateToken credential that is malformed or does not verify is a 401.
 */
export async function presentBlindToken(ctx: Ctx, authorization: string | undefined | null): Promise<BlindPass | null> {
  if (!ctx.blind) return null;
  const bytes = parsePrivateToken(authorization);
  if (bytes === undefined) return null;
  if (bytes === null) throw new ApiError(401, "Malformed PrivateToken credential: expected `PrivateToken token=<base64url>`.", "invalid_token");
  const verified = await ctx.blind.verify(bytes);
  return { ...verified, value: tokenValue(ctx, verified.denomination) };
}

/** A request may cost at most the token's value: the hold is checked against it before the token is claimed. */
export function requireValue(ctx: Ctx, pass: BlindPass, hold: Pico) {
  if (hold <= pass.value) return;
  throw new ApiError(
    402,
    `This request may cost up to $${picoToUsd(hold)} but a ${pass.denomination}-unit token is worth $${picoToUsd(pass.value)}. Use a larger denomination or lower max_tokens.`,
    "token_value_too_low",
    { required_usd: picoToUsd(hold), token_value_usd: picoToUsd(pass.value), denomination: pass.denomination },
  );
}

/** Reserve the token. Exactly one concurrent caller wins; everyone else gets `token_spent`. */
export async function claimToken(ctx: Ctx, pass: BlindPass) {
  const rows = await ctx.db.insert(blindNullifiers).values({ nullifier: pass.nullifier, keyId: pass.keyId }).onConflictDoNothing().returning({ n: blindNullifiers.nullifier });
  if (!rows.length) throw new ApiError(401, "This token was already spent.", "token_spent");
}

export async function unclaimToken(ctx: Ctx, pass: BlindPass) {
  await ctx.db.delete(blindNullifiers).where(and(eq(blindNullifiers.nullifier, pass.nullifier), eq(blindNullifiers.status, "reserved")));
}

export async function confirmToken(ctx: Ctx, pass: BlindPass, generationId: string) {
  await ctx.db.update(blindNullifiers).set({ status: "spent", spentAt: new Date(), generationId }).where(eq(blindNullifiers.nullifier, pass.nullifier));
}

/** What a served response says about the token behind it. */
export const redemptionSummary = (pass: BlindPass, charged: Pico) => ({
  nullifier: pass.nullifier,
  token_key_id: pass.keyId,
  epoch: pass.epoch,
  denomination: pass.denomination,
  token_value_usd: picoToUsd(pass.value),
  unspent_value_forfeited_usd: picoToUsd(pass.value > charged ? pass.value - charged : 0n),
});
