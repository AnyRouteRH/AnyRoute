import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { accountLinks, linkKey } from "../telegram/linking.ts";
import { preferenceKey as securityKey } from "../security-alerts/records.ts";
export const NOTICE_TYPES = ["approvals", "agent_alerts", "deposits", "low_balance", "weekly_summary", "security_alerts", "quiet_agents", "price_notices", "project_budgets", "scheduled_results"] as const;
export type NoticeType = typeof NOTICE_TYPES[number];
export type Channels = { inbox: boolean; telegram: boolean };
const channels = z.strictObject({ inbox: z.boolean(), telegram: z.boolean() });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const preferenceBody = z.strictObject({ channels: z.strictObject(Object.fromEntries(NOTICE_TYPES.map(type => [type, channels])) as Record<NoticeType, typeof channels>), quiet_hours: z.strictObject({ from_utc: time, to_utc: time }).nullable() });
export type Preferences = z.infer<typeof preferenceBody>;
export const prefsKey = (account: string) => `notification-prefs:${account}`;
type Stored = { channels?: Partial<Record<NoticeType, Channels>>; quiet_hours?: Preferences["quiet_hours"] };
export async function readPreferences(db: Db | Tx, account: string): Promise<Preferences> {
  const [row] = await db.select().from(kv).where(eq(kv.key, prefsKey(account)));
  const saved = (row?.value ?? {}) as Stored;
  const [security] = await db.select().from(kv).where(eq(kv.key, securityKey(account)));
  const sec = (security?.value ?? {}) as { enabled?: boolean; inbox?: boolean; telegram?: boolean };
  const links = await accountLinks(db, account);
  let weekly = false;
  for (const link of links) {
    const [row] = await db.select().from(kv).where(eq(kv.key, linkKey(link.uid)));
    weekly ||= row?.weeklySummaryOptedIn === true;
  }
  const values = Object.fromEntries(NOTICE_TYPES.map(type => [type, { inbox: true, telegram: true, ...saved.channels?.[type] }])) as Record<NoticeType, Channels>;
  values.weekly_summary.telegram = weekly;
  values.weekly_summary.inbox = saved.channels?.weekly_summary?.inbox ?? false;
  values.security_alerts = { inbox: sec.inbox ?? sec.enabled !== false, telegram: sec.telegram ?? sec.enabled !== false };
  return { channels: values, quiet_hours: saved.quiet_hours ?? null };
}
export async function savePreferences(db: Db | Tx, account: string, value: Preferences) {
  // Reuse security's existing value and each link's existing summary column, never a second toggle.
  const security = value.channels.security_alerts;
  const secValue = { ...security, enabled: security.inbox || security.telegram };
  await db.insert(kv).values({ key: securityKey(account), value: secValue }).onConflictDoUpdate({ target: kv.key, set: { value: secValue, updatedAt: new Date() } });
  for (const link of await accountLinks(db, account)) await db.update(kv).set({ weeklySummaryOptedIn: value.channels.weekly_summary.telegram }).where(eq(kv.key, linkKey(link.uid)));
  const { security_alerts: _security, weekly_summary: summary, ...rest } = value.channels;
  const saved = { channels: { ...rest, weekly_summary: { inbox: summary.inbox } }, quiet_hours: value.quiet_hours };
  await db.insert(kv).values({ key: prefsKey(account), value: saved }).onConflictDoUpdate({ target: kv.key, set: { value: saved, updatedAt: new Date() } });
}
export async function channelEnabled(ctx: Ctx, account: string, type: NoticeType, channel: keyof Channels) {
  return (await readPreferences(ctx.db, account)).channels[type][channel];
}
export function quietUntil(quiet: Preferences["quiet_hours"], now = new Date()): Date | null {
  if (!quiet || quiet.from_utc === quiet.to_utc) return null;
  const minute = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const from = minute(quiet.from_utc), to = minute(quiet.to_utc), current = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (!(from < to ? current >= from && current < to : current >= from || current < to)) return null;
  const end = new Date(now); end.setUTCHours(Math.floor(to / 60), to % 60, 0, 0);
  if (end <= now) end.setUTCDate(end.getUTCDate() + 1);
  return end;
}
