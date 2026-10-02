import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts, providers } from "../db/schema.ts";
import { uid } from "../lib/util.ts";
import { webhookDestinations } from "./schema.ts";
import { enqueue } from "./delivery.ts";
type Provider = typeof providers.$inferSelect;
/** Called in the transaction that records a host status, never from attestation internals. */
export async function recordHostStatus(ctx: Ctx, tx: Db | Tx, before: Provider | undefined, after: Provider | undefined) {
  if (!ctx.cfg.webhookSigningEnabled || !after?.networkHost || before?.status === after.status) return;
  const rows = await tx.select({ d: webhookDestinations }).from(webhookDestinations).innerJoin(accounts, eq(accounts.id, webhookDestinations.accountId)).where(and(eq(webhookDestinations.revoked, false), sql`${webhookDestinations.keyHash} is null`, sql`lower(${accounts.wallet}) = lower(${after.operator})`));
  const event = { id: uid("hostevent_"), event: "host.status_changed", reference: after.id, at: after.updatedAt, status: after.status };
  for (const { d } of rows) await enqueue(ctx, d, event, tx);
}
/** Preserve the original writer when disabled; when enabled status and outbox commit together. */
export async function withHostStatus<T>(ctx: Ctx, id: string, write: (db: Db | Tx) => Promise<T>): Promise<T> {
  if (!ctx.cfg.webhookSigningEnabled) return write(ctx.db);
  return ctx.db.transaction(async tx => {
    const [before] = await tx.select().from(providers).where(eq(providers.id, id)).for("update");
    const result = await write(tx);
    const [after] = await tx.select().from(providers).where(eq(providers.id, id));
    await recordHostStatus(ctx, tx, before, after);
    return result;
  });
}
