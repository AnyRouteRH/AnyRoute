// K187: retain ids and clocks only; every projection comes from the authorized inbox reader.
import { and, eq, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import type { Db, Tx } from "../db/client.ts";
import { kv } from "../db/schema.ts";
import { sha256 } from "../lib/util.ts";
import { fail } from "../lib/errors.ts";
export type Snooze = { account: string; scope: string; principal: string; id: string; at: string; until: string; created: string; claimed: boolean };
export type SnoozeItem = { id: string; at: string; kind: string; unread: boolean; expires_at?: string; snoozed_until?: string; reminder_at?: string };
export const snoozePrefix = (account: string, scope: string) => `inbox-snooze:${account}:${scope}:`;
export const snoozeKey = (account: string, scope: string, id: string) => snoozePrefix(account, scope) + sha256(id);
export const lockSnoozes = (db: Db | Tx, account: string) => db.execute(sql`select pg_advisory_xact_lock(hashtext(${'inbox-snooze:' + account}))`);
export async function readSnoozes(ctx: Ctx, key: KeyRow, scope: string) {
  const rows = await ctx.db.select().from(kv).where(like(kv.key, snoozePrefix(key.accountId, scope) + "%")).orderBy(kv.key).limit(100);
  return rows.map(row => row.value as Snooze).filter(row => Date.parse(row.until) >= Date.now() - 30 * 86_400_000);
}
export function snoozeReadSince(since: string | undefined, records: Snooze[]) {
  if (!since || !records.length) return since;
  return new Date(Math.min(Date.parse(since), ...records.map(row => Date.parse(row.at) - 1))).toISOString();
}
export function projectSnoozes<T extends SnoozeItem>(items: T[], records: Snooze[], since: string | undefined, asOf: string, sleeping: boolean, wakeEnabled = true) {
  if (!records.length && !sleeping) return;
  const instant = (value: string) => BigInt(Date.parse(value)) * 1000n + BigInt((value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
  const byId = new Map(records.map(row => [row.id, row]));
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!, record = byId.get(item.id), waits = !!record && record.until > asOf;
    if (sleeping ? !waits : waits) { items.splice(i, 1); continue; }
    if (record && !waits && wakeEnabled) {
      item.reminder_at = record.until;
      // A new clock makes a read approval unread again in every browser until marked read.
      if (instant(record.until) > instant(item.at)) item.at = record.until;
      item.unread = !since || instant(item.at) > instant(since);
    }
    if (!sleeping && since && instant(item.at) <= instant(since) && item.kind !== "approval") { items.splice(i, 1); continue; }
    if (waits) { item.snoozed_until = record!.until; item.unread = false; }
  }
}
export async function saveSnooze(ctx: Ctx, key: KeyRow, scope: string, item: SnoozeItem, until: string) {
  const now = Date.now(), requested = Date.parse(until);
  if (requested <= now || requested > now + 30 * 86_400_000) fail(400, "Choose a future time within 30 days.", "invalid_request");
  const capped = !!item.expires_at && requested > Date.parse(item.expires_at);
  const effective = capped ? item.expires_at! : until;
  if (Date.parse(effective) <= now) fail(400, "This request has expired.", "invalid_request");
  const value: Snooze = { account: key.accountId, scope, principal: key.keyHash, id: item.id, at: item.at, until: effective, created: new Date(now).toISOString(), claimed: false };
  await ctx.db.transaction(async tx => {
    await lockSnoozes(tx, key.accountId);
    // Old clocks can be removed without changing source retention.
    await tx.delete(kv).where(and(like(kv.key, snoozePrefix(key.accountId, scope) + "%"), sql`${kv.value}->>'until' < ${new Date(now - 30 * 86_400_000).toISOString()}`));
    const records = await readSnoozes({ ...ctx, db: tx as unknown as Db }, key, scope);
    if (records.length >= 100 && !records.some(row => row.id === item.id)) fail(400, "Up to 100 notices can be snoozed at once.", "invalid_request");
    const name = snoozeKey(key.accountId, scope, item.id);
    await tx.insert(kv).values({ key: name, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  });
  return { id: item.id, until: effective, capped, ...(capped ? { message: "Snoozed until this approval expires. Its expiry has not changed." } : {}) };
}
