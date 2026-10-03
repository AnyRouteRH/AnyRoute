import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { keys } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { PICO_PER_USD } from "../lib/money.ts";
import { agentFeedback } from "./schema.ts";
import { knownReceiptKind, resolvePaidReceipt } from "./receipt-sources.ts";

// Paid feedback: no receipt, no feedback. Each entry is weighted by what the reviewer paid on its receipt, halved every
// PAID_FEEDBACK_HALF_LIFE_DAYS after the payment. The score is the weighted mean on 0..100.

const tag = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9 ._:-]+$/, "letters, digits, spaces and . _ : - only");
export const feedbackBody = z.strictObject({
  receipt_id: z.string().min(1).max(128),
  receipt_kind: z.string().min(3).max(64).optional(),
  score: z.number().int().min(0).max(100),
  tag1: tag.optional(),
  tag2: tag.optional(),
});
export type FeedbackRow = typeof agentFeedback.$inferSelect;

/** An entry's weight now: USD paid, halved every halfLifeDays since the payment (never grows for a future time). */
export function feedbackWeight(paidPico: bigint, paidAt: Date, now: Date, halfLifeDays: number) {
  const usd = Number(paidPico) / Number(PICO_PER_USD);
  const ageDays = Math.max(0, now.getTime() - paidAt.getTime()) / 86_400_000;
  return usd * Math.pow(0.5, ageDays / halfLifeDays);
}

export function reputationOf(rows: Pick<FeedbackRow, "score" | "paidPico" | "paidAt" | "receiptKind">[], now: Date, halfLifeDays: number) {
  let total = 0, weighted = 0;
  const byKind: Record<string, number> = {};
  for (const r of rows) {
    const w = feedbackWeight(r.paidPico, r.paidAt, now, halfLifeDays);
    total += w;
    weighted += w * r.score;
    byKind[r.receiptKind] = (byKind[r.receiptKind] ?? 0) + 1;
  }
  return { score: total > 0 ? Math.round((weighted / total) * 10) / 10 : null, feedback_count: rows.length, weight_usd: Math.round(total * 1e6) / 1e6, by_kind: byKind };
}

/** A coarse public band for an amount, so a single entry never reveals an exact payment. */
export function paidBand(paidPico: bigint) {
  const usd = Number(paidPico) / Number(PICO_PER_USD);
  if (usd < 0.01) return "under $0.01";
  if (usd < 0.1) return "$0.01 to $0.10";
  if (usd < 1) return "$0.10 to $1";
  if (usd < 10) return "$1 to $10";
  if (usd < 100) return "$10 to $100";
  return "$100 or more";
}

/**
 * Record one feedback entry. The reviewer's account must be the receipt's payer; the subject must be its payee or the
 * agent it served; nobody reviews an agent their own account controls; one entry per receipt.
 */
export async function submitFeedback(ctx: Ctx, reviewer: KeyRow, subject: { keyHash: string; accountId: string }, input: z.infer<typeof feedbackBody>) {
  if (input.receipt_kind && !knownReceiptKind(input.receipt_kind)) fail(422, "Unknown receipt kind.", "receipt_kind_unknown");
  if (reviewer.accountId === subject.accountId || reviewer.keyHash === subject.keyHash) fail(403, "An account cannot give feedback to an agent it controls.", "self_feedback");
  const receipt = await resolvePaidReceipt(ctx, input.receipt_id, input.receipt_kind);
  if (!receipt) fail(422, "Feedback needs a paid receipt this router recorded; none was found for that id.", "receipt_required");
  if (!receipt.payerAccountId) fail(422, "This receipt names no payer (unlinkable or blind payment), so it cannot back feedback.", "receipt_unlinkable");
  if (receipt.payerAccountId !== reviewer.accountId) fail(403, "Only the payer on a receipt can use it for feedback.", "not_receipt_payer");
  if (receipt.payee.accountIds.includes(reviewer.accountId)) fail(403, "An account cannot give feedback on a payment to itself.", "self_feedback");
  if (!receipt.payee.keyHashes.includes(subject.keyHash) && !receipt.payee.accountIds.includes(subject.accountId)) fail(403, "This receipt did not pay or serve this agent.", "receipt_subject_mismatch");
  if (receipt.paidPico <= 0n) fail(422, "Feedback needs a receipt with a payment above zero.", "receipt_unpaid");
  const id = uid("fb_");
  const [row] = await ctx.db.insert(agentFeedback).values({ id, subjectKeyHash: subject.keyHash, reviewerAccountId: reviewer.accountId, receiptKind: receipt.kind, receiptId: receipt.id, score: input.score, tag1: input.tag1 ?? null, tag2: input.tag2 ?? null, paidPico: receipt.paidPico, paidAt: receipt.at })
    .onConflictDoNothing().returning();
  if (!row) fail(409, "This receipt already backs a feedback entry.", "receipt_already_used");
  return row;
}

export async function activeFeedback(ctx: Ctx, subjectKeyHash: string) {
  return ctx.db.select().from(agentFeedback).where(and(eq(agentFeedback.subjectKeyHash, subjectKeyHash), isNull(agentFeedback.revokedAt))).orderBy(desc(agentFeedback.createdAt));
}

export async function revokeFeedback(ctx: Ctx, reviewer: KeyRow, subjectKeyHash: string, id: string) {
  const [row] = await ctx.db.update(agentFeedback).set({ revokedAt: new Date() })
    .where(and(eq(agentFeedback.id, id), eq(agentFeedback.subjectKeyHash, subjectKeyHash), eq(agentFeedback.reviewerAccountId, reviewer.accountId), isNull(agentFeedback.revokedAt))).returning();
  if (!row) fail(404, "Feedback not found.", "not_found");
  return row;
}

/** The subject key's account, for the self-feedback check. */
export async function subjectAccount(ctx: Ctx, keyHash: string) {
  const [k] = await ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, keyHash));
  return k?.accountId ?? null;
}
