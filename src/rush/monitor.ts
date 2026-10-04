import { balanceState, latestBalance, parseUsdBalance, type BalanceSnapshot } from "./balance-state.ts";
import { invalidateCatalogJson } from "./cache.ts";
import { eq, like } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { kv } from "../db/schema.ts";
import type { Candidate, ProviderRow } from "../catalog/catalog.ts";
import type { HealthTracker } from "../services/health.ts";
import { decrypt, sha256 } from "../lib/util.ts";
import { providerFetch } from "../providers/network.ts";
import { openProviderHeaders } from "../providers/headers.ts";

export const MONITOR_INTERVAL_MS = 60_000;
export const CREDIT_HOLD_MS = 5 * 60_000;
const BALANCE_PREFIX = "upstream-balance:";
const HOLD_PREFIX = "upstream-credit-hold:";
type Runtime = { ctx: Ctx; holds: Map<string, number>; pending: Map<string, number>; exhausted: Set<string> };
const runtimes = new WeakMap<HealthTracker, Runtime>();
export type { BalanceSnapshot } from "./balance-state.ts";

export const balanceLevel = balanceState;
/** Only explicit credit exhaustion, never an ordinary auth or rate-limit failure. */
export function insufficientCredits(status: number, message: string) {
  return status >= 200 && status < 500 && /\b(?:insufficient[_ -](?:credits?|balance|funds)|(?:credits?|balance)[_ -]exhausted|out of credits|not enough credits)\b/i.test(message);
}
export function creditErrorText(error: unknown) {
  if (typeof error === "string") return error;
  const value = error as { code?: unknown; message?: unknown; error_code?: unknown } | null;
  return [value?.code, value?.error_code, value?.message].filter(v => typeof v === "string").join(" ");
}
export function upstreamMonitoring(health?: HealthTracker) { return !!health && runtimes.has(health); }
/** Only the configured balance URL's exact https origin receives the provider's account credential. No redirect. */
export function balanceEndpoint(p: Pick<ProviderRow, "baseUrl">, balanceUrl: string | undefined): string | null {
  if (!balanceUrl) return null;
  try {
    const u = new URL(p.baseUrl), b = new URL(balanceUrl);
    const clean = (x: URL) => x.protocol === "https:" && !x.port && !x.username && !x.password;
    return clean(u) && clean(b) && u.hostname === b.hostname ? b.toString() : null;
  } catch { return null; }
}
export const parseBalance = parseUsdBalance;
async function save(db: Db, key: string, value: unknown) {
  await db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}
export async function initializeUpstreamMonitor(ctx: Ctx) {
  if (!ctx.cfg.rush.enabled) return;
  const runtime: Runtime = { ctx, holds: new Map(), pending: new Map(), exhausted: new Set() };
  runtimes.set(ctx.health, runtime);
  const outage = ctx.health.outage.bind(ctx.health);
  ctx.health.outage = (model, provider) => runtime.exhausted.has(provider) || (runtime.holds.get(provider) ?? 0) > Date.now() || outage(model, provider);
  await refreshUpstreamHealth(ctx.health, ctx.db);
}
/** Refreshes persisted balances and holds on API replicas through the existing five-second health job. */
export async function refreshUpstreamHealth(health: HealthTracker, db: Db) {
  const runtime = runtimes.get(health);
  if (!runtime) return;
  for (const [provider, until] of runtime.pending) {
    await save(db, HOLD_PREFIX + provider, { until });
    if (runtime.pending.get(provider) === until) runtime.pending.delete(provider);
  }
  const rows = await db.select().from(kv).where(like(kv.key, HOLD_PREFIX + "%"));
  // Finish both reads before changing in-memory availability; a failed read keeps the previous state.
  const balances = await db.select().from(kv).where(like(kv.key, BALANCE_PREFIX + "%"));
  for (const row of rows) {
    const until = Number((row.value as { until?: unknown })?.until);
    if (Number.isFinite(until) && until > Date.now()) runtime.holds.set(row.key.slice(HOLD_PREFIX.length), until);
  }
  for (const [provider, until] of runtime.holds) if (until <= Date.now()) runtime.holds.delete(provider);
  const exhausted = new Set(balances.filter(row => {
    const reading = latestBalance(row.value as BalanceSnapshot);
    return reading && reading.balance_usd <= runtime.ctx.cfg.rush.exhaustedUsd;
  }).map(row => row.key.slice(BALANCE_PREFIX.length)));
  if (exhausted.size !== runtime.exhausted.size || [...exhausted].some(id => !runtime.exhausted.has(id))) invalidateCatalogJson(runtime.ctx.catalog);
  runtime.exhausted = exhausted;
  for (const [provider, until] of runtime.holds) {
    const reading = latestBalance(balances.find(row => row.key === BALANCE_PREFIX + provider)?.value as BalanceSnapshot | undefined);
    if (reading && reading.balance_usd > runtime.ctx.cfg.rush.exhaustedUsd && reading.checked_at >= until - CREDIT_HOLD_MS && !rows.some(row => row.key === HOLD_PREFIX + provider)) runtime.holds.delete(provider);
  }
}
export async function creditFailure(health: HealthTracker | undefined, c: Candidate, apiKey: string | undefined, status: number, message: string) {
  const runtime = health && runtimes.get(health);
  if (!runtime || !(insufficientCredits(status, message) || status === 402 && balanceEndpoint(c.provider, runtime.ctx.cfg.rush.balanceUrl) !== null)) return false;
  // A caller's own key can fail without exhausting the router's upstream account.
  const headers = openProviderHeaders(runtime.ctx.cfg.appSecret, c.provider.headers);
  if (apiKey && c.provider.apiKeyEnc && apiKey === decrypt(runtime.ctx.cfg.appSecret, c.provider.apiKeyEnc) || !apiKey && Object.keys(headers).some(name => ["authorization", "api-key", "x-api-key"].includes(name.toLowerCase()))) {
    const until = Date.now() + CREDIT_HOLD_MS;
    runtime.holds.set(c.providerId, until);
    runtime.pending.set(c.providerId, until);
    try { await save(runtime.ctx.db, HOLD_PREFIX + c.providerId, { until }); runtime.pending.delete(c.providerId); } catch { /* health flush retries; the local hold already applies */ }
  }
  return true;
}
export function balanceExhausted(health: HealthTracker, provider: string) {
  return runtimes.get(health)?.exhausted.has(provider) ?? false;
}
export function creditUnavailable(health: HealthTracker, provider: string) {
  return balanceExhausted(health, provider) || (runtimes.get(health)?.holds.get(provider) ?? 0) > Date.now();
}

export async function runUpstreamMonitor(ctx: Ctx, fetchImpl = providerFetch, now = Date.now()) {
  if (!ctx.cfg.rush.enabled) return { skipped: "disabled" };
  await ctx.catalog.ensureFresh();
  const previous = await ctx.db.select().from(kv).where(like(kv.key, BALANCE_PREFIX + "%"));
  let checked = 0;
  for (const p of ctx.catalog.providers.values()) {
    if (p.status !== "live") continue;
    const endpoint = balanceEndpoint(p, ctx.cfg.rush.balanceUrl);
    let snapshot: BalanceSnapshot = { balance_usd: null, checked_at: now, status: endpoint ? "unknown" : "unsupported" };
    const last = latestBalance(previous.find(row => row.key === BALANCE_PREFIX + p.id)?.value as BalanceSnapshot | undefined);
    if (last) snapshot.last_reading = last;
    if (endpoint) {
      try {
        const headers = openProviderHeaders(ctx.cfg.appSecret, p.headers);
        if (p.apiKeyEnc || Object.keys(headers).some(name => ["authorization", "api-key", "x-api-key"].includes(name.toLowerCase()))) {
          const response = await fetchImpl(endpoint, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
            headers: { ...headers, "content-type": "application/json", ...(p.apiKeyEnc ? { authorization: `Bearer ${decrypt(ctx.cfg.appSecret, p.apiKeyEnc)}` } : {}) }, body: "{}",
          }, { production: ctx.cfg.production, tlsPin: p.tlsPin });
          if (response.ok) {
            const balance = parseBalance(await response.json());
            if (balance !== null) {
              snapshot = { balance_usd: balance, checked_at: now, status: "ok" };
              if (balance > ctx.cfg.rush.exhaustedUsd) {
                await ctx.db.delete(kv).where(eq(kv.key, HOLD_PREFIX + p.id));
                const runtime = runtimes.get(ctx.health);
                runtime?.holds.delete(p.id); runtime?.pending.delete(p.id);
              }
            }
          } else await response.body?.cancel();
        }
      } catch { /* Unknown is explicit; response text and exception details are never retained. */ }
    }
    await save(ctx.db, BALANCE_PREFIX + p.id, snapshot);
    checked++;
  }
  await refreshUpstreamHealth(ctx.health, ctx.db);
  return { checked };
}
export function registerRushJobs(ctx: Ctx, fetchImpl = providerFetch) {
  if (ctx.cfg.rush.enabled) ctx.jobs.register("upstream-monitor", MONITOR_INTERVAL_MS, () => runUpstreamMonitor(ctx, fetchImpl), { atStart: true });
}
export async function upstreamAlertChecks(ctx: Ctx, now = Date.now()) {
  if (!ctx.cfg.rush.enabled) return {};
  const checks: Record<string, boolean> = {};
  const rows = await ctx.db.select().from(kv).where(like(kv.key, BALANCE_PREFIX + "%"));
  for (const row of rows) {
    const provider = row.key.slice(BALANCE_PREFIX.length);
    const name = `upstream_${sha256(provider).slice(0, 12)}`;
    const value = row.value as BalanceSnapshot;
    if (value.status === "unsupported" && !latestBalance(value)) continue;
    const fresh = value.status === "ok" && value.balance_usd !== null && now - value.checked_at <= MONITOR_INTERVAL_MS * 3;
    checks[`${name}_balance`] = fresh;
    const reading = latestBalance(value);
    const level = reading ? balanceState(reading.balance_usd, ctx.cfg.rush.warnUsd, ctx.cfg.rush.criticalUsd, ctx.cfg.rush.exhaustedUsd) : "unknown";
    for (const state of ["warning", "critical", "exhausted"]) checks[`${name}_${state}`] = level !== state;
  }
  const holds = await ctx.db.select().from(kv).where(like(kv.key, HOLD_PREFIX + "%"));
  for (const row of holds) checks[`upstream_${sha256(row.key.slice(HOLD_PREFIX.length)).slice(0, 12)}_credits`] = Number((row.value as { until?: unknown }).until) <= now;
  return checks;
}
export async function upstreamAdminView(ctx: Ctx, now = Date.now()) {
  if (!ctx.cfg.rush.enabled) return { enabled: false, providers: [] };
  const rows = await ctx.db.select().from(kv).where(like(kv.key, "upstream-%"));
  return { enabled: true, warn_usd: ctx.cfg.rush.warnUsd, critical_usd: ctx.cfg.rush.criticalUsd, exhausted_usd: ctx.cfg.rush.exhaustedUsd, interval_ms: MONITOR_INTERVAL_MS, providers: [...ctx.catalog.providers.values()].filter(p => p.status === "live").map(p => {
    const value = rows.find(r => r.key === BALANCE_PREFIX + p.id)?.value as BalanceSnapshot | undefined;
    const until = Number((rows.find(r => r.key === HOLD_PREFIX + p.id)?.value as { until?: unknown })?.until) || 0;
    const reading = latestBalance(value);
    return { provider: p.id, balance_usd: reading?.balance_usd ?? null, checked_at: reading ? new Date(reading.checked_at).toISOString() : null, last_check_at: value ? new Date(value.checked_at).toISOString() : null, last_check_status: value?.status ?? "unknown", status: reading ? balanceState(reading.balance_usd, ctx.cfg.rush.warnUsd, ctx.cfg.rush.criticalUsd, ctx.cfg.rush.exhaustedUsd) : value?.status === "unsupported" ? "unsupported" : "unknown", unavailable_until: until > now ? new Date(until).toISOString() : null };
  }) };
}
