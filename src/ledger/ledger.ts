import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { accounts, holds, keys, ledger } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { type Pico, picoToUsd } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";

// Money invariants (enforced here and by DB triggers, see drizzle/0001_invariants.sql):
// - The ledger is append-only; ledger.ref is UNIQUE, which makes every credit idempotent.
// - accounts.balance == SUM(ledger.amount); accounts.held == SUM(open holds).
// - Paid work is reserve -> settle | release, exactly once. A caller is charged its actual
//   usage; anything above the hold is charged only from spare balance, never into debt
//   (beyond an explicit pay-with credit line), and the remainder is logged as uncovered.

export type Balance = { balance: Pico; held: Pico; available: Pico };

export async function ensureAccount(db: Db | Tx, id: string, kind = "key", wallet?: string | null) {
  await db
    .insert(accounts)
    .values({ id, kind, wallet: wallet ?? null })
    .onConflictDoNothing();
  return id;
}

export async function balanceOf(db: Db | Tx, accountId: string): Promise<Balance> {
  const [row] = await db.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, accountId));
  if (!row) return { balance: 0n, held: 0n, available: 0n };
  return { balance: row.balance, held: row.held, available: row.balance - row.held };
}

/** Append a ledger row. Returns false when `ref` was already recorded (idempotent). */
export async function post(
  db: Db | Tx,
  e: { accountId: string; amount: Pico; kind: string; ref: string; keyHash?: string | null; description?: string; generationId?: string | null },
): Promise<boolean> {
  const inserted = await db
    .insert(ledger)
    .values({
      id: uid("l_"),
      accountId: e.accountId,
      keyHash: e.keyHash ?? null,
      amount: e.amount,
      kind: e.kind,
      ref: e.ref,
      description: e.description ?? "",
      generationId: e.generationId ?? null,
    })
    .onConflictDoNothing({ target: ledger.ref })
    .returning({ id: ledger.id });
  return inserted.length > 0;
}

export async function creditAccount(
  db: Db,
  e: { accountId: string; amount: Pico; kind: string; ref: string; keyHash?: string | null; description?: string },
) {
  if (e.amount <= 0n) fail(400, "Credit amount must be positive.");
  return db.transaction(async (tx) => {
    await ensureAccount(tx, e.accountId);
    return post(tx, e);
  });
}

function periodStart(reset: string | null, at: Date): Date | null {
  if (!reset) return null;
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (reset === "weekly") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (reset === "monthly") d.setUTCDate(1);
  return d;
}

export type ReserveInput = {
  id: string;
  accountId: string;
  keyHash?: string | null;
  amount: Pico;
  kind?: string;
  ttlMs?: number;
  /** Allow the available balance to go negative by up to this much (pay-with sessions). */
  creditLine?: Pico;
};

export async function reserve(db: Db, r: ReserveInput): Promise<Pico> {
  if (r.amount < 0n) fail(400, "Invalid reservation.");
  return db.transaction(async (tx) => {
    const [acct] = await tx.select().from(accounts).where(eq(accounts.id, r.accountId)).for("update");
    if (!acct) fail(402, "This key has no balance. Deposit USDG to its key hash or pay per call.", "insufficient_credits");
    const available = acct.balance - acct.held + (r.creditLine ?? 0n);
    if (available < r.amount)
      fail(
        402,
        `Insufficient balance: this request may cost up to $${picoToUsd(r.amount)} and $${picoToUsd(
          acct.balance - acct.held < 0n ? 0n : acct.balance - acct.held,
        )} is available. Deposit USDG, lower max_tokens, or pay per call.`,
        "insufficient_credits",
        { required_usd: picoToUsd(r.amount), available_usd: picoToUsd(acct.balance - acct.held) },
      );
    if (r.keyHash) {
      const [k] = await tx.select().from(keys).where(eq(keys.keyHash, r.keyHash)).for("update");
      if (!k || k.disabled) fail(401, "This key is disabled.", "key_disabled");
      if (k.budget != null) {
        const start = periodStart(k.budgetReset, new Date());
        let spent = k.spent;
        if (start && (!k.periodStart || k.periodStart < start)) {
          spent = 0n;
          await tx.update(keys).set({ spent: 0n, periodStart: start }).where(eq(keys.keyHash, k.keyHash));
        }
        const [{ inflight }] = await tx
          .select({ inflight: sql<string>`coalesce(sum(${holds.amount}), 0)` })
          .from(holds)
          .where(and(eq(holds.keyHash, k.keyHash), eq(holds.status, "held")));
        if (spent + BigInt(inflight) + r.amount > k.budget)
          fail(
            402,
            `This key would exceed its budget of $${picoToUsd(k.budget)}${k.budgetReset ? ` per ${k.budgetReset.replace(/ly$/, "")}` : ""}.`,
            "key_budget_exceeded",
            { budget_usd: picoToUsd(k.budget), spent_usd: picoToUsd(spent) },
          );
      }
    }
    const existing = await tx.select({ id: holds.id }).from(holds).where(eq(holds.id, r.id));
    if (existing.length) fail(409, "This request id was already submitted.", "duplicate_request");
    await tx.insert(holds).values({
      id: r.id,
      accountId: r.accountId,
      keyHash: r.keyHash ?? null,
      amount: r.amount,
      kind: r.kind ?? "usage",
      expiresAt: new Date(Date.now() + (r.ttlMs ?? 15 * 60_000)),
    });
    return r.amount;
  });
}
