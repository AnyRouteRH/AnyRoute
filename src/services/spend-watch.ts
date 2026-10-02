import { sendRuleWebhook } from "../webhooks/delivery.ts"; // V86: signed legacy alert transport.
import { isIP } from "node:net";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { generations, keys, spendAlerts } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { PICO_PER_USD, picoToUsd, type Pico } from "../lib/money.ts";
import { decrypt, log, uid } from "../lib/util.ts";
import { isPublicAddress, providerFetch } from "../providers/network.ts";

// Spend Watch: where an account's money goes, and alerts before it is gone.
// Reads billing metadata only (generations.cost/ts/key/model/provider and key budgets); never content.
// Every calendar boundary is UTC, like the ledger's budget periods.
//
// Account-wide spend is the spend of the account's API keys. generations has no account index, so
// every query goes through (key_hash, ts): the caller's key, or the account's keys as a subquery on
// keys_account_idx. Calls paid per call with a wallet signature (no key) are not part of it.

export const DAY_MS = 86_400_000;
export const MAX_RULES_PER_ACCOUNT = 20;
export const HISTORY_LIMIT = 20;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const WEBHOOK_TIMEOUT_MS = 5_000;
/** An attempt that has not recorded a result within this long is considered lost and may be retried. */
const LEASE_MS = 30_000;
/** Spend below this is never an anomaly, whatever the ratio. */
export const ANOMALY_MIN_PICO: Pico = PICO_PER_USD;
export const DEFAULT_ANOMALY_PCT = 300; // 3x the trailing daily average
const RULES_PAGE = 500;
const BREAKDOWN_LIMIT = 100;

export type AlertKind = "threshold" | "budget_pct" | "anomaly";
export type AlertWindow = "day" | "week" | "month";
export type SpendAlertRow = typeof spendAlerts.$inferSelect;
type KeyRow = typeof keys.$inferSelect;
type BudgetKey = Pick<KeyRow, "keyHash" | "name" | "label" | "budget" | "budgetReset" | "periodStart" | "spent" | "disabled">;

// ---------- UTC calendar ----------

export const utcDay = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Monday 00:00 UTC, as the ledger's weekly budgets. */
export const utcWeekStart = (t: number) => utcDay(t) - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS;
export function utcMonthStart(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function utcNextMonthStart(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
export const daysInMonth = (t: number) => Math.round((utcNextMonthStart(t) - utcMonthStart(t)) / DAY_MS);

/** Start of the key's current budget period (null: the budget never resets). Mirrors the ledger. */
export function budgetPeriodStart(reset: string | null, t: number): number | null {
  if (reset === "daily") return utcDay(t);
  if (reset === "weekly") return utcWeekStart(t);
  if (reset === "monthly") return utcMonthStart(t);
  return null;
}
export function nextBudgetReset(reset: string | null, t: number): number | null {
  if (reset === "daily") return utcDay(t) + DAY_MS;
  if (reset === "weekly") return utcWeekStart(t) + 7 * DAY_MS;
  if (reset === "monthly") return utcNextMonthStart(t);
  return null;
}
/** The ledger zeroes `spent` lazily, on the key's next reservation. A key idle since an earlier
 *  period has therefore spent nothing in the current one, whatever the stored column says. */
export function currentSpent(k: Pick<KeyRow, "budgetReset" | "periodStart" | "spent">, t: number): Pico {
  const start = budgetPeriodStart(k.budgetReset, t);
  if (start != null && (!k.periodStart || k.periodStart.getTime() < start)) return 0n;
  return k.spent;
}
const resetWindow = (reset: string | null) => (reset === "daily" ? "day" : reset === "weekly" ? "week" : reset === "monthly" ? "month" : "lifetime");

// ---------- aggregation ----------

/** keyHash null: every key of the account (management scope); otherwise that one key. */
export type SpendScope = { accountId: string; keyHash: string | null };
type Daily = Map<string, { cost: Pico; requests: number }>;

const DAY_SQL = sql<string>`to_char(${generations.ts} at time zone 'UTC', 'YYYY-MM-DD')`;
const SUM_COST = sql<string>`coalesce(sum(${generations.cost}), 0)`;
const COUNT = sql<number>`count(*)::int`;

function scopeWhere(db: Db, s: SpendScope, from: number, to: number) {
  return and(
    eq(generations.accountId, s.accountId),
    s.keyHash ? eq(generations.keyHash, s.keyHash) : inArray(generations.keyHash, db.select({ k: keys.keyHash }).from(keys).where(eq(keys.accountId, s.accountId))),
    gte(generations.ts, new Date(from)),
    lt(generations.ts, new Date(to)),
  );
}

export async function dailySpend(db: Db, s: SpendScope, from: number, to: number): Promise<Daily> {
  const rows = await db.select({ day: DAY_SQL, cost: SUM_COST, n: COUNT }).from(generations).where(scopeWhere(db, s, from, to)).groupBy(DAY_SQL);
  return new Map(rows.map((r) => [r.day, { cost: BigInt(r.cost), requests: Number(r.n) }]));
}

/** Per-key daily cost for a few keys of one account (the keys alert rules watch). */
async function dailySpendForKeys(db: Db, accountId: string, keyHashes: string[], from: number, to: number) {
  const out = new Map<string, Daily>();
  if (!keyHashes.length) return out;
  const rows = await db
    .select({ key: generations.keyHash, day: DAY_SQL, cost: SUM_COST, n: COUNT })
    .from(generations)
    .where(and(eq(generations.accountId, accountId), inArray(generations.keyHash, keyHashes), gte(generations.ts, new Date(from)), lt(generations.ts, new Date(to))))
    .groupBy(generations.keyHash, DAY_SQL);
  for (const r of rows) {
    if (!r.key) continue;
    if (!out.has(r.key)) out.set(r.key, new Map());
    out.get(r.key)!.set(r.day, { cost: BigInt(r.cost), requests: Number(r.n) });
  }
  return out;
}

function sumDays(d: Daily | undefined, from: number, to: number) {
  let cost = 0n;
  let requests = 0;
  if (!d) return { cost, requests };
  for (let t = utcDay(from); t < to; t += DAY_MS) {
    const v = d.get(dayKey(t));
    if (v) {
      cost += v.cost;
      requests += v.requests;
    }
  }
  return { cost, requests };
}

export type Totals = { today: Pico; last7: Pico; week: Pico; monthToDate: Pico; projectedMonth: Pico; trailing7: Pico; dayOfMonth: number; daysInMonth: number };

/** Calendar totals at `now`. Projection: the month-to-date daily average over the days elapsed
 *  (today included) times the days in the month. Trailing: the 7 full days before today. */
export function totalsAt(d: Daily | undefined, now: number): Totals {
  const today0 = utcDay(now);
  const end = today0 + DAY_MS;
  const monthToDate = sumDays(d, utcMonthStart(now), end).cost;
  const dom = new Date(now).getUTCDate();
  const dim = daysInMonth(now);
  return {
    today: sumDays(d, today0, end).cost,
    last7: sumDays(d, today0 - 6 * DAY_MS, end).cost,
    week: sumDays(d, utcWeekStart(now), end).cost,
    monthToDate,
    projectedMonth: (monthToDate * BigInt(dim)) / BigInt(dom),
    trailing7: sumDays(d, today0 - 7 * DAY_MS, today0).cost,
    dayOfMonth: dom,
    daysInMonth: dim,
  };
}

/** today >= pct% of the trailing daily average (trailing7 / 7), and at least $1 today. Integer math. */
export function isAnomaly(today: Pico, trailing7: Pico, pct = DEFAULT_ANOMALY_PCT) {
  return today >= ANOMALY_MIN_PICO && today * 7n * 100n >= BigInt(pct) * trailing7;
}
const ratioOf = (today: Pico, trailing7: Pico) => (trailing7 > 0n ? Number((today * 7n * 1000n) / trailing7) / 1000 : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const pctOf = (spent: Pico, budget: Pico) => (budget > 0n ? round1(Number((spent * 10_000n) / budget) / 100) : null);

/** Keys lookup query window: everything the totals need (period, month, week and trailing week). */
function lookback(now: number, periodDays: number) {
  const today0 = utcDay(now);
  return Math.min(today0 - (periodDays - 1) * DAY_MS, utcMonthStart(now), utcWeekStart(now), today0 - 7 * DAY_MS);
}

export type GroupBy = "day" | "model" | "key" | "provider";

function budgetJson(k: BudgetKey, now: number) {
  const spent = currentSpent(k, now);
  const budget = k.budget ?? 0n;
  const next = nextBudgetReset(k.budgetReset, now);
  return {
    key_hash: k.keyHash,
    name: k.name,
    label: k.label,
    budget_usd: picoToUsd(budget),
    spent_usd: picoToUsd(spent),
    remaining_usd: picoToUsd(budget > spent ? budget - spent : 0n),
    pct: pctOf(spent, budget) ?? (spent > 0n ? 100 : 0),
    reset: k.budgetReset,
    resets_at: next ? new Date(next).toISOString() : null,
    disabled: k.disabled,
  };
}

/** GET /api/v1/spend. Bounded: at most max(period, month, trailing week) of days, through (key_hash, ts). */
export async function spendReport(db: Db, scope: SpendScope, opts: { periodDays: number; groupBy: GroupBy; now: number }) {
  const { periodDays, groupBy, now } = opts;
  const today0 = utcDay(now);
  const end = today0 + DAY_MS;
  const periodFrom = today0 - (periodDays - 1) * DAY_MS;
  const daily = await dailySpend(db, scope, lookback(now, periodDays), end);
  const t = totalsAt(daily, now);
  const series: { date: string; cost_usd: number; requests: number }[] = [];
  let periodCost = 0n;
  let periodRequests = 0;
  for (let d = periodFrom; d < end; d += DAY_MS) {
    const v = daily.get(dayKey(d)) ?? { cost: 0n, requests: 0 };
    periodCost += v.cost;
    periodRequests += v.requests;
    series.push({ date: dayKey(d), cost_usd: picoToUsd(v.cost), requests: v.requests });
  }

  const share = (cost: Pico) => (periodCost > 0n ? Number((cost * 10_000n) / periodCost) / 10_000 : 0);
  let breakdown: { id: string; name?: string | null; label?: string | null; cost_usd: number; requests: number; share: number }[];
  let truncated = false;
  if (groupBy === "day") {
    breakdown = series.map((s) => {
      const v = daily.get(s.date)?.cost ?? 0n;
      return { id: s.date, cost_usd: s.cost_usd, requests: s.requests, share: share(v) };
    });
  } else {
    const col = groupBy === "model" ? generations.modelId : groupBy === "provider" ? generations.providerId : generations.keyHash;
    const rows = await db
      .select({ id: col, cost: SUM_COST, n: COUNT })
      .from(generations)
      .where(scopeWhere(db, scope, periodFrom, end))
      .groupBy(col)
      .orderBy(sql`2 desc`, col)
      .limit(BREAKDOWN_LIMIT + 1);
    truncated = rows.length > BREAKDOWN_LIMIT;
    const kept = rows.slice(0, BREAKDOWN_LIMIT);
    const labels = new Map<string, { name: string; label: string }>();
    if (groupBy === "key") {
      const hashes = kept.map((r) => r.id).filter((h): h is string => !!h);
      if (hashes.length)
        for (const k of await db.select({ keyHash: keys.keyHash, name: keys.name, label: keys.label }).from(keys).where(and(eq(keys.accountId, scope.accountId), inArray(keys.keyHash, hashes))))
          labels.set(k.keyHash, k);
    }
    breakdown = kept.map((r) => ({
      id: r.id ?? "unknown",
      ...(groupBy === "key" ? { name: labels.get(r.id ?? "")?.name ?? null, label: labels.get(r.id ?? "")?.label ?? null } : {}),
      cost_usd: picoToUsd(BigInt(r.cost)),
      requests: Number(r.n),
      share: share(BigInt(r.cost)),
    }));
  }

  const budgetRows = await db
    .select({ keyHash: keys.keyHash, name: keys.name, label: keys.label, budget: keys.budget, budgetReset: keys.budgetReset, periodStart: keys.periodStart, spent: keys.spent, disabled: keys.disabled })
    .from(keys)
    .where(and(eq(keys.accountId, scope.accountId), isNotNull(keys.budget), ...(scope.keyHash ? [eq(keys.keyHash, scope.keyHash)] : [])))
    .limit(BREAKDOWN_LIMIT);
  const budgets = budgetRows.map((k) => budgetJson(k, now)).sort((a, b) => b.pct - a.pct || a.key_hash.localeCompare(b.key_hash));

  return {
    scope: scope.keyHash ? ("key" as const) : ("account" as const),
    key_hash: scope.keyHash,
    period: `${periodDays}d`,
    group_by: groupBy,
    as_of: new Date(now).toISOString(),
    timezone: "UTC",
    range: { from: dayKey(periodFrom), to: dayKey(today0) },
    totals: {
      today_usd: picoToUsd(t.today),
      last_7d_usd: picoToUsd(t.last7),
      month_to_date_usd: picoToUsd(t.monthToDate),
      projected_month_usd: picoToUsd(t.projectedMonth),
      period_usd: picoToUsd(periodCost),
      period_requests: periodRequests,
      day_of_month: t.dayOfMonth,
      days_in_month: t.daysInMonth,
    },
    anomaly: {
      flagged: isAnomaly(t.today, t.trailing7),
      today_usd: picoToUsd(t.today),
      trailing_daily_avg_usd: picoToUsd(t.trailing7 / 7n),
      ratio: ratioOf(t.today, t.trailing7),
      multiplier: DEFAULT_ANOMALY_PCT / 100,
      min_today_usd: picoToUsd(ANOMALY_MIN_PICO),
    },
    series,
    breakdown,
    breakdown_truncated: truncated,
    budgets,
  };
}

// ---------- webhook URLs ----------

const LOCAL_SUFFIX = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|private|home\.arpa|in-addr\.arpa|ip6\.arpa)$/;

/** Static check at save time (and again before every send): HTTPS, no credentials or fragment, and no
 *  literal or local-only destination. Hostnames are also resolved and pinned at send time, where any
 *  answer outside public unicast space is refused (providerFetch, production policy). */
export function webhookUrlProblem(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return "webhook_url must be at most 2048 characters.";
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "webhook_url must be an absolute https:// URL.";
  }
  if (u.protocol !== "https:") return "webhook_url must use https://.";
  if (u.username || u.password) return "webhook_url cannot contain credentials.";
  if (u.hash) return "webhook_url cannot contain a #fragment.";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(host)) return isPublicAddress(host) ? null : "webhook_url must point to a public internet address.";
  if (!host.includes(".") || LOCAL_SUFFIX.test(host)) return "webhook_url must point to a public internet host.";
  return null;
}

export function normalizeWebhookUrl(raw: string) {
  const problem = webhookUrlProblem(raw);
  if (problem) fail(400, problem, "invalid_webhook_url");
  return new URL(raw.trim()).toString();
}

/** What the API returns instead of the stored URL: scheme and host only; path and query may hold tokens. */
export function maskWebhookUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "https://…";
  }
}

// ---------- alert state (spend_alerts.state) ----------

export type DeliveryStatus = "none" | "pending" | "delivered" | "failed" | "blocked" | "cancelled";
export type Delivery = { status: DeliveryStatus; attempts: number; last_attempt_at: string | null; http_status: number | null; error: string | null; lease_until: number | null };
/** One firing. Money as pico strings; no URL, secret or content is ever recorded. */
export type Firing = { id: string; period: string; at: string; kind: AlertKind; window: string; value: string; threshold: string | null; pct: number | null; key_label: string | null; delivery: Delivery };
export type AlertState = { v: 1; history: Firing[] };

const DELIVERY_STATUSES: DeliveryStatus[] = ["none", "pending", "delivered", "failed", "blocked", "cancelled"];

export function parseAlertState(value: unknown): AlertState {
  const history: Firing[] = [];
  const raw = (value as { history?: unknown })?.history;
  if (Array.isArray(raw))
    for (const f of raw.slice(0, HISTORY_LIMIT)) {
      if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.period !== "string" || typeof f.at !== "string") continue;
      const d = (f.delivery ?? {}) as Partial<Delivery>;
      history.push({
        id: f.id,
        period: f.period,
        at: f.at,
        kind: f.kind,
        window: typeof f.window === "string" ? f.window : "day",
        value: /^\d+$/.test(String(f.value)) ? String(f.value) : "0",
        threshold: /^\d+$/.test(String(f.threshold)) ? String(f.threshold) : null,
        pct: typeof f.pct === "number" ? f.pct : null,
        key_label: typeof f.key_label === "string" ? f.key_label : null,
        delivery: {
          status: DELIVERY_STATUSES.includes(d.status as DeliveryStatus) ? (d.status as DeliveryStatus) : "none",
          attempts: Number.isInteger(d.attempts) ? Number(d.attempts) : 0,
          last_attempt_at: typeof d.last_attempt_at === "string" ? d.last_attempt_at : null,
          http_status: typeof d.http_status === "number" ? d.http_status : null,
          error: typeof d.error === "string" ? d.error : null,
          lease_until: typeof d.lease_until === "number" ? d.lease_until : null,
        },
      });
    }
  return { v: 1, history };
}

export function firingJson(ruleId: string, f: Firing) {
  return {
    id: f.id,
    alert_id: ruleId,
    period: f.period,
    at: f.at,
    kind: f.kind,
    window: f.window,
    value_usd: picoToUsd(BigInt(f.value)),
    threshold_usd: f.threshold == null ? null : picoToUsd(BigInt(f.threshold)),
    pct: f.pct,
    key_label: f.key_label,
    delivery: { status: f.delivery.status, attempts: f.delivery.attempts, max_attempts: MAX_DELIVERY_ATTEMPTS, last_attempt_at: f.delivery.last_attempt_at, http_status: f.delivery.http_status, error: f.delivery.error },
  };
}

/** The webhook body: the documented fields only. No secret, URL, key hash or content. */
export function webhookPayload(ruleId: string, f: Firing) {
  return {
    alert_id: ruleId,
    kind: f.kind,
    window: f.window,
    value_usd: picoToUsd(BigInt(f.value)),
    ...(f.threshold != null ? { threshold_usd: picoToUsd(BigInt(f.threshold)) } : {}),
    ...(f.pct != null ? { pct: f.pct } : {}),
    ...(f.key_label ? { key_label: f.key_label } : {}),
    period: f.period,
    at: f.at,
  };
}

/** Pending deliveries of a rule become `cancelled` (webhook removed or rule disabled). */
export function cancelPending(state: AlertState) {
  for (const f of state.history) if (f.delivery.status === "pending") Object.assign(f.delivery, { status: "cancelled", lease_until: null });
  return state;
}

// ---------- rule evaluation ----------

export type Facts = { now: number; account: Daily; byKey: Map<string, Daily>; keys: Map<string, BudgetKey> };
export type Plan = { period: string; window: string; value: Pico; threshold: Pico | null; pct: number | null; keyLabel: string | null };

/** The effective window a rule reports: threshold windows, the anomaly day, or the key's budget period. */
export function ruleWindow(rule: Pick<SpendAlertRow, "kind" | "window">, key?: Pick<KeyRow, "budgetReset"> | null) {
  if (rule.kind === "threshold") return rule.window;
  if (rule.kind === "anomaly") return "day";
  return resetWindow(key?.budgetReset ?? null);
}

/** Pure: whether a rule's condition holds at facts.now, and the period that firing belongs to. */
export function evaluateRule(rule: Pick<SpendAlertRow, "kind" | "window" | "keyHash" | "thresholdUsd" | "pct">, facts: Facts): Plan | null {
  const now = facts.now;
  const today0 = utcDay(now);
  const end = today0 + DAY_MS;
  const key = rule.keyHash ? facts.keys.get(rule.keyHash) : null;
  if (rule.keyHash && !key) return null; // the key left the account's view; nothing to watch
  const keyLabel = key?.label ?? null;
  const series = rule.keyHash ? facts.byKey.get(rule.keyHash) : facts.account;
  if (rule.kind === "threshold") {
    if (rule.thresholdUsd == null || rule.thresholdUsd <= 0n) return null;
    const from = rule.window === "month" ? utcMonthStart(now) : rule.window === "week" ? utcWeekStart(now) : today0;
    const value = sumDays(series, from, end).cost;
    if (value < rule.thresholdUsd) return null;
    const period = rule.window === "month" ? `month:${dayKey(from).slice(0, 7)}` : `${rule.window === "week" ? "week" : "day"}:${dayKey(from)}`;
    return { period, window: rule.window, value, threshold: rule.thresholdUsd, pct: null, keyLabel };
  }
  if (rule.kind === "budget_pct") {
    if (!key || key.budget == null || key.budget <= 0n || !rule.pct) return null;
    const spent = currentSpent(key, now);
    if (spent * 100n < key.budget * BigInt(rule.pct)) return null;
    const start = budgetPeriodStart(key.budgetReset, now);
    return {
      period: start == null ? "budget:lifetime" : `budget:${resetWindow(key.budgetReset)}:${dayKey(start)}`,
      window: resetWindow(key.budgetReset),
      value: spent,
      threshold: (key.budget * BigInt(rule.pct)) / 100n,
      pct: pctOf(spent, key.budget),
      keyLabel,
    };
  }
  if (rule.kind === "anomaly") {
    const pct = rule.pct ?? DEFAULT_ANOMALY_PCT;
    const today = sumDays(series, today0, end).cost;
    const trailing7 = sumDays(series, today0 - 7 * DAY_MS, today0).cost;
    if (!isAnomaly(today, trailing7, pct)) return null;
    const ratio = ratioOf(today, trailing7);
    return { period: `day:${dayKey(today0)}`, window: "day", value: today, threshold: (trailing7 * BigInt(pct)) / 700n, pct: ratio == null ? null : Math.round(ratio * 100), keyLabel };
  }
  return null;
}

async function accountFacts(db: Db, accountId: string, rules: SpendAlertRow[], now: number): Promise<Facts> {
  const end = utcDay(now) + DAY_MS;
  const from = lookback(now, 1);
  const keyHashes = [...new Set(rules.map((r) => r.keyHash).filter((k): k is string => !!k))];
  const [account, byKey, keyRows] = await Promise.all([
    rules.some((r) => !r.keyHash) ? dailySpend(db, { accountId, keyHash: null }, from, end) : Promise.resolve(new Map() as Daily),
    dailySpendForKeys(db, accountId, keyHashes, from, end),
    keyHashes.length
      ? db
          .select({ keyHash: keys.keyHash, name: keys.name, label: keys.label, budget: keys.budget, budgetReset: keys.budgetReset, periodStart: keys.periodStart, spent: keys.spent, disabled: keys.disabled })
          .from(keys)
          .where(and(eq(keys.accountId, accountId), inArray(keys.keyHash, keyHashes)))
      : Promise.resolve([] as BudgetKey[]),
  ]);
  return { now, account, byKey, keys: new Map(keyRows.map((k) => [k.keyHash, k])) };
}

const configOf = (r: Pick<SpendAlertRow, "kind" | "window" | "keyHash" | "thresholdUsd" | "pct">) => `${r.kind}|${r.window}|${r.keyHash ?? ""}|${r.thresholdUsd ?? ""}|${r.pct ?? ""}`;

/**
 * Record a firing for `plan.period` unless one is already recorded. Replica-safe twice over: the row is
 * locked for the read-modify-write, and the UPDATE itself only applies while last_period still differs,
 * so a replica holding a stale copy of the rule can never fire the same period again.
 */
export async function claimFiring(db: Db, rule: SpendAlertRow, plan: Plan, now: number): Promise<Firing | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(spendAlerts).where(eq(spendAlerts.id, rule.id)).for("update");
    // Edited or disabled since it was evaluated: the next tick re-evaluates the current config.
    if (!row || !row.enabled || row.lastPeriod === plan.period || configOf(row) !== configOf(rule)) return null;
    const firing: Firing = {
      id: uid("sf_"),
      period: plan.period,
      at: new Date(now).toISOString(),
      kind: row.kind as AlertKind,
      window: plan.window,
      value: plan.value.toString(),
      threshold: plan.threshold?.toString() ?? null,
      pct: plan.pct,
      key_label: plan.keyLabel,
      delivery: { status: row.webhookUrlEnc ? "pending" : "none", attempts: 0, last_attempt_at: null, http_status: null, error: null, lease_until: null },
    };
    const state = parseAlertState(row.state);
    state.history = [firing, ...state.history].slice(0, HISTORY_LIMIT);
    const done = await tx
      .update(spendAlerts)
      .set({ lastPeriod: plan.period, lastFiredAt: new Date(now), state })
      .where(and(eq(spendAlerts.id, rule.id), eq(spendAlerts.enabled, true), or(isNull(spendAlerts.lastPeriod), ne(spendAlerts.lastPeriod, plan.period))))
      .returning({ id: spendAlerts.id });
    return done.length ? firing : null;
  });
}

// ---------- delivery ----------

export type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
export type SpendWatchOptions = {
  now?: () => number;
  headers?: Record<string, string>; // V86: signature and event identity.
  /** DNS for webhook egress (tests). The answers still pass the public-address check. */
  resolve?: Resolve;
  /** Replaces the network transport entirely (tests only; the URL is still checked first). */
  send?: (url: string, init: RequestInit) => Promise<Response>;
};
type SendResult = { ok: boolean; status: number | null; error: string | null; blocked: boolean };

/** POST the payload through the provider egress guard: HTTPS only, public addresses only, DNS pinned,
 *  no redirects, 5 s. Never logs or returns the URL, the response body or exception text. */
export async function sendWebhook(url: string, body: unknown, opts: Pick<SpendWatchOptions, "resolve" | "send" | "headers"> = {}): Promise<SendResult> {
  if (webhookUrlProblem(url)) return { ok: false, status: null, error: "destination_blocked", blocked: true };
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Anyroute-SpendWatch/1", ...opts.headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  };
  try {
    const res = opts.send ? await opts.send(url, init) : await providerFetch(url, init, { production: true, resolve: opts.resolve });
    await res.body?.cancel().catch(() => undefined);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `http_${res.status}`, blocked: false };
  } catch (e) {
    const name = (e as Error)?.name;
    const message = String((e as Error)?.message ?? "");
    if (/non-public address|must use HTTPS|redirects are disabled/.test(message)) return { ok: false, status: null, error: "destination_blocked", blocked: true };
    return { ok: false, status: null, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", blocked: false };
  }
}

/** Pending and not leased by an attempt in flight (a lease left by a stopped replica lapses). */
const due = (f: Firing, now: number) => f.delivery.status === "pending" && (f.delivery.lease_until ?? 0) <= now;

/**
 * Deliver a rule's due firings: claim the attempts under a SKIP LOCKED row lock (another replica working
 * on the rule is skipped, and the lease keeps the attempt exclusive after the lock is released), send
 * outside any transaction, then record each result. At most MAX_DELIVERY_ATTEMPTS per firing, one per tick.
 */
async function deliverDue(ctx: Ctx, ruleId: string, now: number, opts: SpendWatchOptions) {
  const claim = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(spendAlerts).where(eq(spendAlerts.id, ruleId)).for("update", { skipLocked: true });
    if (!row?.enabled || !row.webhookUrlEnc) return null;
    const state = parseAlertState(row.state);
    const open = state.history.filter((f) => due(f, now));
    if (!open.length) return null;
    // A replica that stopped after claiming the last attempt never recorded its result: that firing is spent.
    const exhausted = open.filter((f) => f.delivery.attempts >= MAX_DELIVERY_ATTEMPTS);
    for (const f of exhausted) Object.assign(f.delivery, { status: "failed", lease_until: null, error: f.delivery.error ?? "no_result" });
    const picked = open.filter((f) => f.delivery.attempts < MAX_DELIVERY_ATTEMPTS).slice(0, MAX_DELIVERY_ATTEMPTS);
    for (const f of picked) Object.assign(f.delivery, { attempts: f.delivery.attempts + 1, lease_until: now + LEASE_MS, last_attempt_at: new Date(now).toISOString() });
    await tx.update(spendAlerts).set({ state }).where(eq(spendAlerts.id, ruleId));
    return { enc: row.webhookUrlEnc, exhausted: exhausted.length, firings: picked.map((f) => ({ ...f, delivery: { ...f.delivery } })) };
  });
  if (!claim) return { delivered: 0, failed: 0 };
  if (!claim.firings.length) return { delivered: 0, failed: claim.exhausted };

  let url: string | null = null;
  try {
    url = decrypt(ctx.cfg.appSecret, claim.enc);
  } catch {
    url = null; // APP_SECRET changed since the rule was saved: the URL must be entered again
  }
  const results = new Map<string, SendResult>();
  for (const f of claim.firings)
    results.set(f.id, url ? await sendRuleWebhook(ctx, ruleId, url, { id: f.id, event: "spend.alert", reference: ruleId, at: new Date(f.at) }, webhookPayload(ruleId, f), opts) : { ok: false, status: null, error: "undecryptable", blocked: true });

  let delivered = 0;
  let failed = claim.exhausted;
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(spendAlerts).where(eq(spendAlerts.id, ruleId)).for("update");
    if (!row) return; // deleted meanwhile
    const state = parseAlertState(row.state);
    for (const f of state.history) {
      const r = results.get(f.id);
      if (!r || f.delivery.status !== "pending") continue; // cancelled meanwhile
      const status: DeliveryStatus = r.ok ? "delivered" : r.blocked || f.delivery.attempts >= MAX_DELIVERY_ATTEMPTS ? (r.blocked ? "blocked" : "failed") : "pending";
      Object.assign(f.delivery, { status, http_status: r.status, error: r.error, lease_until: null });
      if (status === "delivered") delivered++;
      else if (status !== "pending") failed++;
    }
    await tx.update(spendAlerts).set({ state }).where(eq(spendAlerts.id, ruleId));
  });
  return { delivered, failed };
}

// ---------- the job ----------

/** Worker job `spend-watch` (every minute): evaluate enabled rules, fire at most once per rule per
 *  period, deliver webhooks with retries. Safe to run on several replicas at once. */
export async function runSpendWatch(ctx: Ctx, opts: SpendWatchOptions = {}) {
  const now = opts.now?.() ?? Date.now();
  let rules = 0;
  let fired = 0;
  let delivered = 0;
  let failed = 0;
  let after: { accountId: string; id: string } | null = null;
  for (;;) {
    const page: SpendAlertRow[] = await ctx.db
      .select()
      .from(spendAlerts)
      .where(and(eq(spendAlerts.enabled, true), after ? sql`(${spendAlerts.accountId}, ${spendAlerts.id}) > (${after.accountId}, ${after.id})` : undefined))
      .orderBy(asc(spendAlerts.accountId), asc(spendAlerts.id))
      .limit(RULES_PAGE);
    if (!page.length) break;
    rules += page.length;
    after = { accountId: page[page.length - 1].accountId, id: page[page.length - 1].id };
    const byAccount = new Map<string, SpendAlertRow[]>();
    for (const r of page) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
    for (const [accountId, list] of byAccount) {
      try {
        const facts = await accountFacts(ctx.db, accountId, list, now);
        for (const rule of list) {
          const plan = evaluateRule(rule, facts);
          let hasDue = parseAlertState(rule.state).history.some((f) => due(f, now));
          if (plan && plan.period !== rule.lastPeriod) {
            const firing = await claimFiring(ctx.db, rule, plan, now);
            if (firing) {
              fired++;
              hasDue ||= firing.delivery.status === "pending";
              log.info("spend alert fired", { alert: rule.id, kind: rule.kind, period: plan.period });
            }
          }
          if (hasDue && rule.webhookUrlEnc) {
            const r = await deliverDue(ctx, rule.id, now, opts);
            delivered += r.delivered;
            failed += r.failed;
          }
        }
      } catch (e) {
        log.error("spend watch failed for an account", { error: (e as Error).message });
      }
    }
    if (page.length < RULES_PAGE) break;
  }
  return { rules, fired, delivered, failed };
}
