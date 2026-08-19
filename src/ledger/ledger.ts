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

export type SettleResult = { charged: Pico; uncovered: Pico; alreadySettled?: boolean };

/** Close a hold, charging `actual`. Idempotent: a closed hold returns its stored result. */
export async function settle(
  db: Db,
  holdId: string,
  actual: Pico,
  meta: { description?: string; generationId?: string | null; kind?: string; creditLine?: Pico } = {},
): Promise<SettleResult> {
  if (actual < 0n) fail(502, "Usage cost could not be verified.", "invalid_cost");
  return db.transaction(async (tx) => {
    const [h] = await tx.select().from(holds).where(eq(holds.id, holdId)).for("update");
    if (!h) fail(500, "Unknown hold.", "internal");
    if (h.status !== "held") {
      const res = (h.result ?? {}) as { charged?: string; uncovered?: string };
      return { charged: BigInt(res.charged ?? 0), uncovered: BigInt(res.uncovered ?? 0), alreadySettled: true };
    }
    const [acct] = await tx.select().from(accounts).where(eq(accounts.id, h.accountId)).for("update");
    let charged = actual;
    if (actual > h.amount) {
      // Spare balance outside this hold (plus any credit line) may cover the overage.
      const spare = acct.balance - acct.held + (meta.creditLine ?? 0n);
      const extra = actual - h.amount;
      charged = h.amount + (extra <= spare ? extra : spare > 0n ? spare : 0n);
    }
    const uncovered = actual - charged;
    if (uncovered > 0n) log.warn("usage exceeded reservation; uncovered amount absorbed by operator", { holdId, uncovered });
    await tx
      .update(holds)
      .set({ status: "settled", result: { charged: charged.toString(), uncovered: uncovered.toString() } })
      .where(eq(holds.id, holdId));
    if (charged > 0n) {
      await post(tx, {
        accountId: h.accountId,
        keyHash: h.keyHash,
        amount: -charged,
        kind: meta.kind ?? h.kind,
        ref: `settle:${holdId}`,
        description: meta.description ?? "Model usage",
        generationId: meta.generationId ?? null,
      });
      if (h.keyHash)
        await tx
          .update(keys)
          .set({ spent: sql`${keys.spent} + ${charged}`, spentTotal: sql`${keys.spentTotal} + ${charged}`, lastUsed: new Date() })
          .where(eq(keys.keyHash, h.keyHash));
    }
    return { charged, uncovered };
  });
}

export async function release(db: Db, holdId: string) {
  await db
    .update(holds)
    .set({ status: "released", result: { charged: "0", uncovered: "0" } })
    .where(and(eq(holds.id, holdId), eq(holds.status, "held")));
}

/** Release holds whose owners vanished (crash mid-request). Returns count. */
export async function expireHolds(db: Db) {
  const rows = await db
    .update(holds)
    .set({ status: "released", result: { charged: "0", uncovered: "0", expired: true } })
    .where(and(eq(holds.status, "held"), sql`${holds.expiresAt} < now()`))
    .returning({ id: holds.id });
  return rows.length;
}

/** Invariant check used by tests and the admin API. */
export async function verifyInvariants(db: Db) {
  const r = await db.execute(sql`
    SELECT a.id,
           a.balance AS balance,
           coalesce((SELECT sum(amount) FROM ledger l WHERE l.account_id = a.id), 0) AS ledger_sum,
           a.held AS held,
           coalesce((SELECT sum(amount) FROM holds h WHERE h.account_id = a.id AND h.status = 'held'), 0) AS held_sum
    FROM accounts a`);
  const rows = ((r as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as Array<Record<string, unknown>>;
  const bad = rows.filter((x) => BigInt(x.balance as string) !== BigInt(x.ledger_sum as string) || BigInt(x.held as string) !== BigInt(x.held_sum as string));
  return { ok: bad.length === 0, bad };
}
