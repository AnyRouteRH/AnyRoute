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
