import { and, eq, or, isNull } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { keys } from "../db/schema.ts";
import type { ApprovalRow } from "../agents/approvals.ts";
import { webhookDestinations } from "./schema.ts";
import { enqueue } from "./delivery.ts";
const contexts = new WeakMap<Db, Ctx>();
export const configureWebhookEvents = (ctx: Ctx) => contexts.set(ctx.db, ctx);
/** The approval writer passes its transaction; a notice cannot survive a rolled-back decision. */
export async function recordApprovalWebhook(db: Db, tx: Tx, row: ApprovalRow, decided = false) {
  const ctx = contexts.get(db);
  if (!ctx?.cfg.webhookSigningEnabled) return;
  const [key] = await tx.select().from(keys).where(eq(keys.keyHash, row.keyHash));
  if (!key) return;
  const destinations = await tx.select().from(webhookDestinations).where(and(eq(webhookDestinations.accountId, key.accountId), eq(webhookDestinations.revoked, false), or(isNull(webhookDestinations.keyHash), eq(webhookDestinations.keyHash, row.keyHash))));
  const event = { id: `approval:${row.id}:${decided ? row.status : "requested"}`, event: decided ? "approval.decided" : "approval.requested", reference: row.id, at: decided ? row.decidedAt! : row.requestedAt, status: decided ? row.status : "pending" };
  for (const d of destinations) await enqueue(ctx, d, event, tx);
}
