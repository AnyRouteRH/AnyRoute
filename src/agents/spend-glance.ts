// C132: read-only summaries of existing charged ledger entries.
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { principal } from "../api/agents.ts";
import { generations, keys, ledger, models } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";

const DAY = 86_400_000;
export function spendDates(now: Date, days = 7) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * DAY).toISOString().slice(0, 10));
}
type SpendBucket = { day: string; amount: string; modelId: string | null; modelName: string | null };
export function summarizeSpend(dates: string[], buckets: SpendBucket[], lastRequest: Date | null) {
  const daily = new Map(dates.map(day => [day, 0n]));
  const byModel = new Map<string, { name: string; amount: bigint }>();
  let total = 0n;
  for (const bucket of buckets) {
    if (!daily.has(bucket.day)) continue;
    const amount = BigInt(bucket.amount);
    total += amount;
    daily.set(bucket.day, daily.get(bucket.day)! + amount);
    if (bucket.modelId) {
      const previous = byModel.get(bucket.modelId);
      byModel.set(bucket.modelId, { name: bucket.modelName || bucket.modelId, amount: (previous?.amount ?? 0n) + amount });
    }
  }
  // Stable tie-break; integer pico amounts decide the winner before JSON conversion.
  const top = [...byModel].sort(([a, x], [b, y]) => x.amount === y.amount ? (a < b ? -1 : a > b ? 1 : 0) : x.amount > y.amount ? -1 : 1)[0];
  return { daily: [...daily].map(([date, amount]) => ({ date, charged_usd: picoToUsd(amount) })), total_usd: picoToUsd(total),
    top_model: top ? { id: top[0], name: top[1].name, charged_usd: picoToUsd(top[1].amount) } : null,
    last_request_at: lastRequest?.toISOString() ?? null };
}

export async function readAgentSpend(ctx: Ctx, caller: KeyRow, now = new Date(), days = 7) {
  const dates = spendDates(now, days);
  const from = new Date(dates[0]! + "T00:00:00Z");
  // The same visible keys as the agents list; filter in SQL before reading spending or model metadata.
  const visible = and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!));
  const charged = sql`${ledger.amount} < 0 and ${ledger.kind} in ('usage', 'tool_call', 'data_tool')`;
  return ctx.db.transaction(async tx => {
    const agents = await tx.select({ keyHash: keys.keyHash }).from(keys).where(visible);
    const day = sql<string>`to_char(${ledger.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const buckets = await tx.select({ keyHash: ledger.keyHash, day, amount: sql<string>`sum(-${ledger.amount})::text`, modelId: generations.modelId, modelName: models.name })
      .from(ledger).innerJoin(keys, and(eq(keys.keyHash, ledger.keyHash), eq(keys.accountId, ledger.accountId)))
      .leftJoin(generations, and(eq(generations.id, ledger.generationId), eq(generations.keyHash, ledger.keyHash), eq(generations.accountId, ledger.accountId)))
      .leftJoin(models, eq(models.id, generations.modelId))
      .where(and(visible, charged, gte(ledger.createdAt, from), lte(ledger.createdAt, now)))
      .groupBy(ledger.keyHash, day, generations.modelId, models.name);
    // Free recorded model calls still count as calls. Paid tools without a generation use settlement time.
    const calls = await tx.select({ keyHash: generations.keyHash, at: sql<string>`max(${generations.ts})::text` }).from(generations)
      .innerJoin(keys, and(eq(keys.keyHash, generations.keyHash), eq(keys.accountId, generations.accountId)))
      .where(and(visible, lte(generations.ts, now))).groupBy(generations.keyHash);
    const charges = await tx.select({ keyHash: ledger.keyHash, at: sql<string>`max(${ledger.createdAt})::text` }).from(ledger)
      .innerJoin(keys, and(eq(keys.keyHash, ledger.keyHash), eq(keys.accountId, ledger.accountId)))
      .where(and(visible, charged, lte(ledger.createdAt, now))).groupBy(ledger.keyHash);
    const latest = new Map<string, Date>();
    for (const row of [...calls, ...charges]) if (row.keyHash && row.at) {
      const at = new Date(row.at);
      if (!latest.has(row.keyHash) || at > latest.get(row.keyHash)!) latest.set(row.keyHash, at);
    }
    const grouped = new Map<string, SpendBucket[]>();
    for (const bucket of buckets) if (bucket.keyHash) {
      const group = grouped.get(bucket.keyHash) ?? [];
      group.push(bucket); grouped.set(bucket.keyHash, group);
    }
    return { days, from: from.toISOString(), as_of: now.toISOString(), data: agents.map(agent => ({ key_hash: agent.keyHash,
      ...summarizeSpend(dates, grouped.get(agent.keyHash) ?? [], latest.get(agent.keyHash) ?? null) })) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function agentSpendRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/agents/spend", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c);
    // This glance always covers seven UTC dates; reject other ranges rather than silently changing the UI's meaning.
    const days = c.req.query("days");
    if (days !== undefined && days !== "7") fail(400, "Spend at a glance covers 7 UTC days. Use days=7.", "invalid_request");
    c.header("cache-control", "no-store");
    return c.json(await readAgentSpend(ctx, caller));
  });
}
