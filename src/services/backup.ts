import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";

/** Written by scripts/backup-offsite.ts after an encrypted dump is uploaded and re-read from storage. */
export const BACKUP_KV_KEY = "backup:last";

export type BackupRecord = {
  completed_at: string;
  size_bytes: number;
  sha256: string;
  object_key: string;
  pg_dump_major?: number;
  server_major?: number;
  recipients?: number;
};

/** True only for a verified, non-empty backup inside the freshness window (clock skew tolerated up to 5 minutes). */
export function backupRecordFresh(value: unknown, maxAgeHours: number, now = Date.now()) {
  const record = value as Partial<BackupRecord> | null | undefined;
  if (!record || typeof record !== "object") return false;
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return false;
  if (typeof record.size_bytes !== "number" || !(record.size_bytes > 0)) return false;
  if (typeof record.object_key !== "string" || !record.object_key) return false;
  const completed = typeof record.completed_at === "string" ? Date.parse(record.completed_at) : NaN;
  if (!Number.isFinite(completed)) return false;
  const age = now - completed;
  return age >= -300_000 && age <= maxAgeHours * 3_600_000;
}

export async function backupFresh(ctx: Ctx, now = Date.now()) {
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, BACKUP_KV_KEY));
  return backupRecordFresh(row?.value, ctx.cfg.backup.maxAgeHours, now);
}
