import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { roleOf, type KeyRow } from "../api/auth.ts";
/** Shared call/balance visibility; agent administration adds its own team boundary. */
export async function activityAccess(ctx: Ctx, key: KeyRow) {
  const role = await roleOf(ctx, key);
  const result = await ctx.db.execute(sql`select id from agent_sessions where key_hash = ${key.keyHash} limit 1`);
  const session = ((result as { rows?: unknown[] }).rows ?? result as unknown[]).length > 0;
  return { session, whole: !session && (key.management || role === "owner" || role === "admin") };
}
