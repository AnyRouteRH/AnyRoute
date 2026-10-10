import type { Hono } from "hono";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { accounts, keys, kv } from "../db/schema.ts";
import { principal } from "../api/agents.ts";
import { keyPagination } from "../provisioning/keys.ts";
import { fail } from "../lib/errors.ts";

// E147: wallet-issued root management keys are browser sign-ins, including older rows.
// Provisioned sub-keys and agent/team sessions are never included.
export function browserSessionRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/account/browser-sessions", async c => {
    c.header("Cache-Control", "no-store");
    const caller = await principal(ctx, c);
    if (!caller.management || caller.scope === "inference") fail(403, "Use an account management key to read signed-in browsers.", "forbidden");
    const { offset, limit } = keyPagination({ offset: "0", ...c.req.query() });
    const rows = await ctx.db.select({ key: keys, details: kv.value }).from(keys)
      .innerJoin(accounts, eq(accounts.id, keys.accountId))
      .leftJoin(kv, sql`${kv.key} = 'browser-session:' || ${keys.keyHash}`)
      .where(and(eq(keys.accountId, caller.accountId), eq(accounts.kind, "wallet"),
        eq(keys.management, true), isNull(keys.parentHash), isNull(keys.teamId),
        or(isNull(keys.scope), ne(keys.scope, "inference")), eq(keys.disabled, false),
        or(isNull(keys.expiresAt), sql`${keys.expiresAt} > now()`)))
      .orderBy(desc(keys.createdAt), desc(keys.keyHash)).offset(offset).limit(limit + 1);
    return c.json({ data: rows.slice(0, limit).map(({ key, details }) => ({
      hash: key.keyHash,
      browser_label: (details as { label?: string } | null)?.label ?? "Browser details unavailable",
      created_at: key.createdAt.toISOString(), last_used: key.lastUsed?.toISOString() ?? null,
      current: key.keyHash === caller.keyHash,
    })), has_more: rows.length > limit });
  });
}
