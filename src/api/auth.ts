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

export async function requireKey(ctx: Ctx, authorization: string | undefined | null) {
  const secret = bearer(authorization);
  if (!secret) fail(401, "Provide an API key as `Authorization: Bearer sk-ar-v1-...`.", "missing_key");
  const key = await resolveKey(ctx, secret);
  if (!key) fail(401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDG to its key hash first.", "invalid_key");
  return key;
}

export async function roleOf(ctx: Ctx, key: KeyRow): Promise<Role> {
  if (key.management) return "owner";
  if (!key.teamId) return "member";
  const [m] = await ctx.db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, key.teamId), eq(teamMembers.keyHash, key.keyHash)));
  return (m?.role as Role) ?? "member";
}

export async function requireRole(ctx: Ctx, key: KeyRow, allowed: Role[]) {
  const role = await roleOf(ctx, key);
  if (!allowed.includes(role)) fail(403, `This key's role (${role}) cannot do that.`, "forbidden");
  return role;
}

// Wallet authentication for per-call payers spending their change balance:
//   X-Wallet-Auth: <address>:<unixSeconds>:<signature>
// where signature = personal_sign("anyroute:<unixSeconds>:<sha256(request body)>").
// Replay protection keys on what the signature authorizes (address, timestamp, body) — not on the
// signature bytes, which can be re-encoded (v 27/28 vs 0/1, high-s) to recover the same address.
// Shared across replicas through Redis when configured (SET NX), else per process.
const seen = new Map<string, number>();
async function firstUse(ctx: Ctx, id: string) {
  const redis = (ctx.cache as unknown as { redis?: import("ioredis").Redis }).redis;
  if (redis) return (await redis.set(`walletauth:${id}`, "1", "PX", 600_000, "NX")) === "OK";
  if (seen.has(id)) return false;
  seen.set(id, Date.now());
  if (seen.size > 50_000) for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);
  return true;
}
export async function walletAuth(ctx: Ctx, header: string, bodySha: string) {
  const [address, ts, sig] = header.split(":");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "") || !/^\d+$/.test(ts ?? "") || !/^0x[0-9a-fA-F]+$/.test(sig ?? ""))
    fail(401, "X-Wallet-Auth must be <address>:<unixSeconds>:<signature>.", "invalid_wallet_auth");
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (age > 300) fail(401, "X-Wallet-Auth timestamp is outside the 5-minute window.", "invalid_wallet_auth");
  const recovered = await recoverMessageAddress({ message: `anyroute:${ts}:${bodySha}`, signature: sig as Hex }).catch(() => null);
  if (!recovered || recovered.toLowerCase() !== address!.toLowerCase()) fail(401, "X-Wallet-Auth signature does not match the address.", "invalid_wallet_auth");
  if (!(await firstUse(ctx, sha256(`${address!.toLowerCase()}|${ts}|${bodySha}`)))) fail(401, "X-Wallet-Auth signature was already used.", "invalid_wallet_auth");
  const accountId = walletAccountId(address!);
  const [acct] = await ctx.db.select().from(accounts).where(eq(accounts.id, accountId));
  return { accountId, wallet: address!.toLowerCase(), exists: !!acct };
}
