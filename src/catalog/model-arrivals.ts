// C131: catalogue arrival dates, independent of upstream model release dates.
import { like } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { kv } from "../db/schema.ts";

export const ARRIVAL_PREFIX = "model-first-seen:";
export const ARRIVAL_SEED = "model-arrivals:seed";
export const DAY_SECONDS = 86_400;
export function addedWithin(addedAt: unknown, days: number, now = Date.now() / 1000): addedAt is number {
  return typeof addedAt === "number" && Number.isSafeInteger(addedAt) && addedAt > 0 && addedAt <= now && now - addedAt < days * DAY_SECONDS;
}

type Arrival = { first_seen: number; seeded: boolean };
/** One transaction serializes refreshes across replicas using the seed row's write lock.
 * Baseline records retain the first observation, but added_at is unknown (null) for them.
 * Removed/reintroduced IDs retain their original record; no prompt or account data is read. */
export async function recordModelArrivals(db: Db, ids: string[], now = Math.floor(Date.now() / 1000)) {
  return db.transaction(async tx => {
    const [seed] = await tx.insert(kv).values({ key: ARRIVAL_SEED, value: { initialized: false } })
      .onConflictDoUpdate({ target: kv.key, set: { updatedAt: new Date(now * 1000) } }).returning({ value: kv.value });
    const seeded = !(seed!.value as { initialized: boolean }).initialized;
    const existing = await tx.select({ key: kv.key, value: kv.value }).from(kv).where(like(kv.key, ARRIVAL_PREFIX + "%"));
    const known = new Map(existing.map(row => [row.key.slice(ARRIVAL_PREFIX.length), row.value as Arrival]));
    const missing = [...new Set(ids)].filter(id => !known.has(id));
    for (let i = 0; i < missing.length; i += 500) {
      const batch = missing.slice(i, i + 500);
      await tx.insert(kv).values(batch.map(id => ({ key: ARRIVAL_PREFIX + id, value: { first_seen: now, seeded } }))).onConflictDoNothing();
      for (const id of batch) known.set(id, { first_seen: now, seeded });
    }
    if (seeded) await tx.insert(kv).values({ key: ARRIVAL_SEED, value: { initialized: true, seeded_at: now } })
      .onConflictDoUpdate({ target: kv.key, set: { value: { initialized: true, seeded_at: now } } });
    return new Map(ids.map(id => {
      const row = known.get(id);
      return [id, row && !row.seeded && Number.isSafeInteger(row.first_seen) && row.first_seen > 0 ? row.first_seen : null];
    }));
  });
}
