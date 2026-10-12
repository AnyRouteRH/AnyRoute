// G158: atomic, opt-in rotation. All reads in a transaction use its connection.
import { hasChainFunding } from "./funding.ts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import type { KeyRow } from "../api/auth.ts";
import { accounts, agentSessions, chainEvents, keys, kv, paywithSessions, spendAlerts, teamMembers } from "../db/schema.ts";
import { agentPolicies } from "../agents/schema.ts";
import { policyVersions } from "../agents/policy-versions-schema.ts";
import { approversKey } from "../agents/approvers.ts";
import { QUIET_PREFIX } from "../agents/quiet-alerts.ts";
import { lockAccount } from "../agents/store.ts";
import { deriveKey, generateApiKey } from "../chain/keys.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { keyActor, recordSecurity } from "../security-alerts/records.ts";
import { assertFitsOrgBudget } from "../teams/org.ts";

export const GRACE_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 } as const;
export type Grace = keyof typeof GRACE_MS;
export type Rotation = { from: string | null; to: string | null; at: string; grace_ends_at: string; history_key_hash: string };
export const rotationKey = (hash: string) => `key-rotation:${hash}`;
export async function readRotation(db: Db | Tx, hash: string): Promise<Rotation | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, rotationKey(hash)));
  return (row?.value as Rotation | undefined) ?? null;
}
export function graceDeadline(expiresAt: Date | null, grace: Grace, now = new Date()) {
  const end = new Date(now.getTime() + GRACE_MS[grace]);
  return expiresAt && expiresAt < end ? expiresAt : end;
}
// A racing expiry edit cannot extend a retired secret's effective deadline.
export async function rotatedExpiry(db: Db, hash: string, expiresAt: Date | null) {
  const rotation = await readRotation(db, hash);
  const end = rotation?.to ? new Date(rotation.grace_ends_at) : null;
  return end && (!expiresAt || end < expiresAt) ? end : expiresAt;
}
// Keep the retired secret's deadline even if its owner later edits expiry.
export async function assertRotationExpiry(db: Db, hash: string, expiresAt: Date | null | undefined) {
  if (expiresAt === undefined) return;
  const rotation = await readRotation(db, hash);
  if (rotation?.to && (!expiresAt || expiresAt > new Date(rotation.grace_ends_at))) fail(409, "A rotated key cannot work beyond its grace period. Use the replacement key.", "key_rotated");
}

export async function rotateKey(ctx: Ctx, caller: KeyRow, hash: string, grace: Grace) {
  return ctx.db.transaction(async tx => {
    await lockAccount(tx, caller.accountId);
    const [old] = await tx.select().from(keys).where(and(eq(keys.keyHash, hash), eq(keys.accountId, caller.accountId))).for("update");
    if (!old) fail(404, "Key not found.", "not_found");
    if (!caller.management && (!caller.teamId || old.teamId !== caller.teamId)) fail(403, "This key cannot manage that key.", "forbidden");
    // Same owner/admin guard and ownership boundary as PATCH; never grant a non-owner more rights.
    const [activeCaller] = await tx.select().from(keys).where(eq(keys.keyHash, caller.keyHash));
    const [member] = await tx.select().from(teamMembers).where(and(eq(teamMembers.keyHash, caller.keyHash), eq(teamMembers.teamId, caller.teamId ?? "")));
    if (!activeCaller || activeCaller.disabled || activeCaller.expiresAt && activeCaller.expiresAt <= new Date() || activeCaller.scope || !(activeCaller.management || member?.role === "admin" || member?.role === "owner")) fail(403, "Use a management key or a team owner or admin key to rotate a key.", "forbidden");
    if (!activeCaller.management && hash !== caller.keyHash) fail(403, "Only a management key can rotate another key.", "forbidden");
    const now = new Date();
    if (old.disabled || old.expiresAt && old.expiresAt <= now) fail(409, "Disabled or expired keys cannot be rotated.", "key_inactive");
    if ((await readRotation(tx, hash))?.to) fail(409, "This key has already been rotated. Use the replacement key.", "key_rotated");
    const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.keyHash, hash));
    const [callerSession] = await tx.select().from(agentSessions).where(eq(agentSessions.keyHash, caller.keyHash));
    if (session || callerSession) fail(409, "Agent-session keys cannot be rotated or rotate keys. Manage the session instead.", "session_key");
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, old.accountId));
    const [event] = await tx.select().from(chainEvents).where(sql`${chainEvents.args}->>'keyHash' = ${old.chainKeyHash}`).limit(1);
    const [paywith] = await tx.select().from(paywithSessions).where(eq(paywithSessions.keyHash, old.chainKeyHash));
    if (!account || !old.parentHash && account.kind === "key" || event || paywith) fail(409, "Keys funded on chain or made for deposit-first use cannot be rotated. Create an account-backed key instead; the existing key keeps its funds.", "chain_funded_key");
    if (await hasChainFunding(ctx, old.chainKeyHash)) fail(409, "Keys funded on chain cannot be rotated. The existing key keeps its funds.", "chain_funded_key");
    if (old.teamId) await assertFitsOrgBudget(tx, old.teamId, old.budget);
    const secret = generateApiKey(), derived = deriveKey(secret);
    // Copy settings exhaustively, including this budget period's spend so a limit carries over; lifetime spend,
    // last-used time and identity belong to the old key.
    const { keyHash: _hash, chainKeyHash: _chain, keyAddress: _address, label: _label, createdAt: _created, lastUsed: _used, spentTotal: _total, ...settings } = old;
    const [row] = await tx.insert(keys).values({ ...settings, keyHash: derived.keyHash, chainKeyHash: derived.chainKeyHash, keyAddress: derived.keyAddress, label: derived.label }).returning();
    const memberships = await tx.select().from(teamMembers).where(eq(teamMembers.keyHash, hash));
    if (memberships.length) await tx.insert(teamMembers).values(memberships.map(m => ({ ...m, keyHash: row.keyHash, createdAt: now })));
    const [policy] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash));
    if (policy) await tx.insert(agentPolicies).values({ ...policy, keyHash: row.keyHash });
    const versions = await tx.select().from(policyVersions).where(eq(policyVersions.keyHash, hash)).orderBy(asc(policyVersions.id));
    // Revisions stay on the old key as well; metadata links to their original history.
    if (versions.length) await tx.insert(policyVersions).values(versions.map(({ id: _id, ...v }) => ({ ...v, keyHash: row.keyHash })));
    const prefs = await tx.select().from(kv).where(inArray(kv.key, [approversKey(hash), QUIET_PREFIX + hash]));
    for (const pref of prefs) {
      const quiet = pref.key.startsWith(QUIET_PREFIX);
      const value = quiet ? { hours: (pref.value as { hours: number | null }).hours, enabled_at: now.toISOString(), notified_for: null, notices: [] } : pref.value;
      await tx.insert(kv).values({ key: quiet ? QUIET_PREFIX + row.keyHash : approversKey(row.keyHash), value });
    }
    const alerts = await tx.select().from(spendAlerts).where(eq(spendAlerts.keyHash, hash));
    if (alerts.length) await tx.insert(spendAlerts).values(alerts.map(({ id: _id, state: _state, lastFiredAt: _fired, lastPeriod: _period, ...a }) => ({ ...a, id: uid("sa_"), keyHash: row.keyHash, state: { v: 1, history: [] }, createdAt: now })));
    const previous = await readRotation(tx, hash);
    const end = graceDeadline(old.expiresAt, grace, now);
    const base = { at: now.toISOString(), grace_ends_at: end.toISOString(), history_key_hash: hash };
    const oldRotation: Rotation = { ...base, from: previous?.from ?? null, to: row.keyHash };
    const newRotation: Rotation = { ...base, from: hash, to: null };
    await tx.insert(kv).values({ key: rotationKey(hash), value: oldRotation }).onConflictDoUpdate({ target: kv.key, set: { value: oldRotation, updatedAt: now } });
    await tx.insert(kv).values({ key: rotationKey(row.keyHash), value: newRotation });
    await tx.update(keys).set({ expiresAt: end }).where(eq(keys.keyHash, hash));
    await recordSecurity(ctx, tx, old.accountId, old.teamId, `Key rotated for ${keyActor(old.name).slice(3)} ${keyActor(caller.name)}`, `rotation:${hash}`);
    return { row, secret, rotation: newRotation };
  });
}
