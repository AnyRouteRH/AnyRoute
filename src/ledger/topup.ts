import { and, eq, gt, gte, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { accounts, holds, keys, keyTopups, teams } from "../db/schema.ts";
import { type Pico, usdToPico } from "../lib/money.ts";
import { uid } from "../lib/util.ts";

// Auto top-up: "when this key has less than $below of budget left, add $add from the account's credits, at most
// $max_per_week per week". A key's budget (keys.budget, the API's `limit`) is a spending allowance on the account's own
// balance, so no money moves: a top-up only raises that allowance, and only while the account's available credits
// cover the key's whole remaining allowance after it.
//
// When it runs: after a debit (ledger.settle) leaves the key with less than `below` left, and when the key's budget
// would refuse a request (ledger.reserve) while it has less than `below` left, so a key stalled at its limit resumes
// once the account or the week allows. Both run inside the reserve/settle transaction, which holds the account row
// lock and the key row lock, so concurrent requests on one account are serialized and each sees the previous top-up:
// one crossing makes at most one top-up. Each top-up is recorded once per hold or request (key_topups.ref is unique).
//
// Weeks are UTC calendar weeks, Monday 00:00 to Sunday 24:00, the same as a weekly key budget reset. Rulebook caps
// (per request, hour, day, week) are separate and still apply before any reservation, top-up or not.

export const TOPUP_MAX = { below_usd: 1_000, add_usd: 1_000, max_per_week_usd: 5_000 } as const;
const usd = (max: number) => z.number().min(0.01).max(max);
export const topupInput = z
  .strictObject({ below_usd: usd(TOPUP_MAX.below_usd), add_usd: usd(TOPUP_MAX.add_usd), max_per_week_usd: usd(TOPUP_MAX.max_per_week_usd) })
  .refine((r) => r.add_usd <= r.max_per_week_usd, { message: "add_usd cannot be more than max_per_week_usd.", path: ["add_usd"] });
export type TopupInput = z.infer<typeof topupInput>;
export type TopupRule = { below: Pico; add: Pico; maxPerWeek: Pico };

/** The stored rule (keys.topup) in pico-USD, or null when unset or unreadable. */
export function topupRule(stored: unknown): TopupRule | null {
  const r = topupInput.safeParse(stored);
  return r.success ? { below: usdToPico(r.data.below_usd), add: usdToPico(r.data.add_usd), maxPerWeek: usdToPico(r.data.max_per_week_usd) } : null;
}

/** The rule as the API returns it, or null. */
export function topupJson(stored: unknown): TopupInput | null {
  const r = topupInput.safeParse(stored);
  return r.success ? r.data : null;
}

/** UTC Monday 00:00 of the week holding `at`. */
export function topupWeekStart(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

/** Top-ups added to this key since this UTC week began. */
export async function topupsThisWeek(db: Db | Tx, keyHash: string, now = new Date()): Promise<Pico> {
  const [r] = await db
    .select({ n: sql<string>`coalesce(sum(${keyTopups.amount}), 0)` })
    .from(keyTopups)
    .where(and(eq(keyTopups.keyHash, keyHash), eq(keyTopups.outcome, "added"), gte(keyTopups.createdAt, topupWeekStart(now))));
  return BigInt(r?.n ?? 0);
}

export type TopupKey = { keyHash: string; accountId: string; budget: Pico | null; budgetReset: string | null; spent: Pico; topup: unknown; disabled: boolean; expiresAt: Date | null; teamId: string | null };
export type TopupOutcome = "added" | "skipped_balance" | "skipped_weekly" | "skipped_org_budget";
export type TopupResult = { outcome: TopupOutcome; limitAfter: Pico; recorded: boolean };

/**
 * Apply the key's rule once, inside the caller's reserve/settle transaction, which must hold the key's row lock (and
 * the account's). `k` is the key as locked, after any debit. Returns null when the rule does not apply.
 * A skipped top-up is recorded once per key, reason, limit and week, so the inbox explains a stall without repeating.
 */
export async function applyTopup(tx: Tx, k: TopupKey, ref: string, now = new Date()): Promise<TopupResult | null> {
  const rule = topupRule(k.topup);
  // A rule needs a total budget that does not reset; the keys API refuses other combinations.
  if (!rule || k.budget == null || k.budgetReset || k.disabled || (k.expiresAt && k.expiresAt <= now)) return null;
  if (k.budget - k.spent >= rule.below) return null;
  const weekStart = topupWeekStart(now);
  const week = await topupsThisWeek(tx, k.keyHash, now);
  const after = k.budget + rule.add;
  const [acct] = await tx.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, k.accountId)).for("update");
  const available = acct ? acct.balance - acct.held : 0n;
  const [{ inflight }] = await tx
    .select({ inflight: sql<string>`coalesce(sum(${holds.amount}), 0)` })
    .from(holds)
    .where(and(eq(holds.keyHash, k.keyHash), eq(holds.status, "held")));
  let outcome: TopupOutcome = "added";
  if (week + rule.add > rule.maxPerWeek) outcome = "skipped_weekly";
  // Never above what the account holds: the key's free allowance after the top-up must fit in the account's free credits.
  else if (after - k.spent - BigInt(inflight) > available) outcome = "skipped_balance";
  else if (k.teamId && (await overOrgBudget(tx, k.teamId, k.keyHash, after, now))) outcome = "skipped_org_budget";
  const added = outcome === "added";
  const inserted = await tx
    .insert(keyTopups)
    .values({
      id: uid("kt_"),
      ref: added ? ref : `skip:${k.keyHash}:${outcome}:${k.budget}:${weekStart.toISOString()}`,
      keyHash: k.keyHash,
      accountId: k.accountId,
      outcome,
      amount: rule.add,
      limitBefore: k.budget,
      limitAfter: added ? after : k.budget,
      spent: k.spent,
      available,
      weekStart,
      weekTotal: added ? week + rule.add : week,
      maxPerWeek: rule.maxPerWeek,
      createdAt: now,
    })
    .onConflictDoNothing({ target: keyTopups.ref })
    .returning({ id: keyTopups.id });
  const recorded = inserted.length > 0;
  if (added && recorded) await tx.update(keys).set({ budget: after }).where(eq(keys.keyHash, k.keyHash));
  return { outcome, limitAfter: added && recorded ? after : k.budget, recorded };
}

/** Whether `limit` for this key would exceed its team's org budget, counted as src/teams/org.ts allocated() does. */
async function overOrgBudget(tx: Tx, teamId: string, keyHash: string, limit: Pico, now: Date) {
  const [team] = await tx.select({ budget: teams.budget }).from(teams).where(eq(teams.id, teamId));
  if (team?.budget == null) return false;
  const [r] = await tx
    .select({ n: sql<string>`coalesce(sum(${keys.budget}), 0)` })
    .from(keys)
    .where(and(eq(keys.teamId, teamId), eq(keys.disabled, false), or(isNull(keys.expiresAt), gt(keys.expiresAt, now)), ne(keys.keyHash, keyHash)));
  return BigInt(r?.n ?? 0) + limit > team.budget;
}
