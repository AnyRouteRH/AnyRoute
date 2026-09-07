import { and, eq, sql } from "drizzle-orm";
import { recoverMessageAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { accounts, chainEvents, keys, teamMembers } from "../db/schema.ts";
import { deriveKey, KEY_RE } from "../chain/keys.ts";
import { fail } from "../lib/errors.ts";
import { ensureAccount } from "../ledger/ledger.ts";
import { sha256 } from "../lib/util.ts";
import { processEvents } from "../chain/indexer.ts";

export type KeyRow = typeof keys.$inferSelect;
export type Role = "owner" | "admin" | "member" | "viewer";

export const accountIdFor = (chainKeyHash: string) => `k_${chainKeyHash.slice(2, 34)}`;
export const walletAccountId = (address: string) => `w_${address.toLowerCase().slice(2)}`;

export function bearer(header: string | undefined | null) {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}

/** Register a root key (its own account). Idempotent. Claims any deposits already made to it. */
export async function registerRootKey(ctx: Ctx, secret: string, name = "") {
  const d = deriveKey(secret);
  const accountId = accountIdFor(d.chainKeyHash);
  await ctx.db.transaction(async (tx) => {
    await ensureAccount(tx, accountId, "key");
    await tx
      .insert(keys)
      .values({
        keyHash: d.keyHash,
        chainKeyHash: d.chainKeyHash,
        keyAddress: d.keyAddress,
        accountId,
        name,
        label: d.label,
        management: true,
        rpm: ctx.cfg.limits.defaultRpm || null,
        tpm: ctx.cfg.limits.defaultTpm || null,
      })
      .onConflictDoNothing();
  });
  await processEvents(ctx, { chainKeyHash: d.chainKeyHash });
  const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, d.keyHash));
  return row;
}

/** Look up a presented API key. Unknown but well-formed keys that already have on-chain deposits
 *  are registered on the spot: deposit first, call immediately, no account needed. */
export async function resolveKey(ctx: Ctx, secret: string): Promise<KeyRow | null> {
  if (!KEY_RE.test(secret)) return null;
  const keyHash = sha256(secret);
  const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  if (row) {
    if (row.disabled) fail(401, "This API key is disabled.", "key_disabled");
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) fail(401, "This API key has expired.", "key_expired");
    return row;
  }
  const d = deriveKey(secret);
  const pending = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(chainEvents)
    .where(and(eq(chainEvents.processed, false), sql`${chainEvents.args}->>'keyHash' = ${d.chainKeyHash}`));
  if (!pending[0]?.n) return null;
  return registerRootKey(ctx, secret);
}
