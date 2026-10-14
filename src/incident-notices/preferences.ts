import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { kv } from "../db/schema.ts";
export type IncidentSubscription = { inbox: string | null; telegram: string | null };
export const subscriptionKey = (account: string) => `incident-notices:subscription:${account}`;
/** Preserve each channel's start across unrelated settings saves; re-enabling starts a new subscription. */
export async function saveIncidentSubscription(db: Db | Tx, account: string, channels: { inbox: boolean; telegram: boolean }, now = new Date()) {
  const key = subscriptionKey(account);
  const [saved] = await db.select().from(kv).where(eq(kv.key, key)).for("update");
  const previous = saved?.value as IncidentSubscription | undefined;
  const value: IncidentSubscription = {
    inbox: channels.inbox ? previous?.inbox ?? now.toISOString() : null,
    telegram: channels.telegram ? previous?.telegram ?? now.toISOString() : null,
  };
  await db.insert(kv).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
}
