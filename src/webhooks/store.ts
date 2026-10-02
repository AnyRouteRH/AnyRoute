import { and, eq, isNull, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { accounts, spendAlerts, keys } from "../db/schema.ts";
import { decrypt, encrypt, uid } from "../lib/util.ts";
import { maskWebhookUrl } from "../services/spend-watch.ts";
import { newSigningSecret } from "./signature.ts";
import { webhookDestinations } from "./schema.ts";
export const WEBHOOK_EVENTS = ["spend.alert", "agent.alert", "approval.requested", "approval.decided", "deposit.credited", "agreement.funded", "agreement.disputed", "agreement.ruled", "host.status_changed"] as const;
export const MAX_DESTINATIONS = 20;
export type Destination = typeof webhookDestinations.$inferSelect;
export function destinationJson(ctx: Ctx, row: Destination) {
  let url = "https://…";
  try { url = maskWebhookUrl(decrypt(ctx.cfg.appSecret, row.urlEnc)); } catch { /* No credential in responses. */ }
  return { id: row.id, webhook_url: url, events: row.events, signing: row.revoked ? "revoked" : row.secretEnc ? "signed" : "unsigned", legacy_rule_id: row.ruleId, key_hash: row.keyHash, created_at: row.createdAt.toISOString() };
}
export async function insertDestination(ctx: Ctx, db: Db | Tx, v: { accountId: string; createdBy: string; keyHash?: string | null; ruleId?: string; urlEnc: string; events: string[] }, signed: boolean) {
  await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, v.accountId)).for("update");
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(webhookDestinations).where(and(eq(webhookDestinations.accountId, v.accountId), isNull(webhookDestinations.ruleId)));
  if (count >= MAX_DESTINATIONS && !v.ruleId) throw new Error("destination_limit");
  const secret = signed ? newSigningSecret() : null;
  const from = new Date().toISOString();
  const [row] = await db.insert(webhookDestinations).values({ id: uid("wh_"), ...v, keyHash: v.keyHash ?? null, secretEnc: secret ? encrypt(ctx.cfg.appSecret, secret) : null, events: v.events, scan: { from } }).onConflictDoNothing().returning();
  return { row, secret: row ? secret : null };
}
/** Imports old rules without manufacturing or exposing a signing key. */
export async function importLegacy(ctx: Ctx, accountId: string) {
  if (!ctx.cfg.webhookSigningEnabled) return;
  await ctx.db.transaction(async tx => {
    const rows = await tx.select().from(spendAlerts).where(eq(spendAlerts.accountId, accountId));
    const [owner] = await tx.select().from(keys).where(and(eq(keys.accountId, accountId), eq(keys.management, true))).limit(1);
    for (const row of rows) if (row.webhookUrlEnc && (row.createdBy || owner)) await insertDestination(ctx, tx, { accountId, createdBy: row.createdBy ?? owner.keyHash, keyHash: row.keyHash, ruleId: row.id, urlEnc: row.webhookUrlEnc, events: ["spend.alert", "agent.alert"] }, false);
  });
}
/** Called inside rule writes: a new or changed URL receives a fresh secret, returned once. */
export async function signingForRule(ctx: Ctx, tx: Db | Tx, rule: { id: string; accountId: string; createdBy: string; keyHash: string | null; webhookUrlEnc: string | null }, changed = true) {
  if (!ctx.cfg.webhookSigningEnabled) return {};
  if (!changed) { await tx.update(webhookDestinations).set({ keyHash: rule.keyHash }).where(eq(webhookDestinations.ruleId, rule.id)); return {}; }
  if (!rule.webhookUrlEnc) { await tx.delete(webhookDestinations).where(eq(webhookDestinations.ruleId, rule.id)); return {}; }
  const [existing] = await tx.select().from(webhookDestinations).where(eq(webhookDestinations.ruleId, rule.id));
  if (existing) {
    const secret = newSigningSecret();
    await tx.update(webhookDestinations).set({ urlEnc: rule.webhookUrlEnc, keyHash: rule.keyHash, secretEnc: encrypt(ctx.cfg.appSecret, secret), revoked: false }).where(eq(webhookDestinations.id, existing.id));
    return { signing_secret: secret, webhook_destination_id: existing.id };
  }
  const { row, secret } = await insertDestination(ctx, tx, { accountId: rule.accountId, createdBy: rule.createdBy, keyHash: rule.keyHash, ruleId: rule.id, urlEnc: rule.webhookUrlEnc, events: ["spend.alert", "agent.alert"] }, true);
  return { signing_secret: secret, webhook_destination_id: row?.id };
}
export const subscribed = (destination: Pick<Destination, "events" | "revoked">, event: string) => !destination.revoked && destination.events.includes(event);

