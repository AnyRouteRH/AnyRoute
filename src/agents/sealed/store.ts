import { and, eq, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Ctx } from "../../context.ts";
import { keys, kv } from "../../db/schema.ts";
import type { SealedRegistration } from "./bindings.ts";
import { verifySealed, sealedIO, type SealedIO, type SealedResult } from "./verify.ts";
const prefix = "sealed-agent:";
export const SEALED_MAX_AGE_MS = 30 * 60_000;
export type SealedRecord = SealedRegistration & { revision: string; result: SealedResult; checked_at: string | null };
export function sealedStatus(record: SealedRecord | null, now = Date.now()) {
  const checked = Date.parse(record?.checked_at ?? "");
  if (!record) return null;
  const attested = record.result.attested && Number.isFinite(checked) && checked <= now && now - checked < SEALED_MAX_AGE_MS;
  return { attested, agent_image_digest: record.agent_image_digest, compose_hash: record.compose_hash, checked_at: record.checked_at,
    expires_at: Number.isFinite(checked) ? new Date(checked + SEALED_MAX_AGE_MS).toISOString() : null,
    ...(attested && record.result.attested ? { verified_by: record.result.verified_by } : { reason: record.result.attested ? "stale" : record.result.reason }) };
}
export async function getSealed(ctx: Ctx, hash: string) {
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, prefix + hash));
  const record = (row?.value ?? null) as SealedRecord | null;
  if (!record) return null;
  const [key] = await ctx.db.select().from(keys).where(eq(keys.keyHash, hash));
  return key && !key.disabled && !key.management && (!key.expiresAt || key.expiresAt.getTime() > Date.now()) ? record : { ...record, result: { attested: false, reason: "key_unavailable" } } as SealedRecord;
}
export async function registerSealed(ctx: Ctx, hash: string, registration: SealedRegistration, io = sealedIO(ctx)) {
  const record: SealedRecord = { ...registration, revision: randomUUID(), result: { attested: false, reason: "pending" }, checked_at: null };
  await ctx.db.insert(kv).values({ key: prefix + hash, value: record }).onConflictDoUpdate({ target: kv.key, set: { value: record, updatedAt: new Date() } });
  return recheckSealed(ctx, hash, record, io);
}
export async function recheckSealed(ctx: Ctx, hash: string, record: SealedRecord, io: SealedIO = sealedIO(ctx)) {
  // Clear old success while checking; CAS prevents a late check from restoring a removed/replaced registration.
  const pending: SealedRecord = { ...record, result: { attested: false, reason: "pending" } };
  const claimed = await ctx.db.update(kv).set({ value: pending, updatedAt: new Date() }).where(and(eq(kv.key, prefix + hash), eq(kv.value, record))).returning();
  if (!claimed.length) return null;
  const [key] = await ctx.db.select().from(keys).where(eq(keys.keyHash, hash));
  const result: SealedResult = key && !key.disabled && !key.management && (!key.expiresAt || key.expiresAt.getTime() > Date.now()) ? await verifySealed(hash, record, io) : { attested: false, reason: "key_unavailable" };
  const updated: SealedRecord = { ...pending, result, checked_at: new Date().toISOString() };
  await ctx.db.update(kv).set({ value: updated, updatedAt: new Date() }).where(and(eq(kv.key, prefix + hash), eq(kv.value, pending)));
  return sealedStatus(await getSealed(ctx, hash));
}
export async function removeSealed(ctx: Ctx, hash: string) { await ctx.db.delete(kv).where(eq(kv.key, prefix + hash)); }
export async function runSealedAttestor(ctx: Ctx, io?: SealedIO) {
  if (!ctx.cfg.agentSealedEnabled) return;
  const rows = await ctx.db.select().from(kv).where(like(kv.key, prefix + "%"));
  for (const row of rows) await recheckSealed(ctx, row.key.slice(prefix.length), row.value as SealedRecord, io);
}
