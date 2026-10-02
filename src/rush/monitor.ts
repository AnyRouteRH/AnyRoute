import { like } from "drizzle-orm";
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
type Runtime = { ctx: Ctx; holds: Map<string, number>; pending: Map<string, number> };
const runtimes = new WeakMap<HealthTracker, Runtime>();
export type BalanceSnapshot = { balance_usd: number | null; checked_at: number; status: "ok" | "unknown" | "unsupported" };

export function balanceLevel(balance: number, warn: number, critical: number) {
  return balance < critical ? "critical" : balance < warn ? "warning" : "ok";
}
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
export function parseBalance(value: unknown): number | null {
  const outer = value as { data?: unknown } | null;
  const v = (outer?.data ?? value) as { balance_usd?: unknown; amount_usd?: unknown; balance?: unknown; currency?: unknown } | null;
  const raw = v?.balance_usd ?? v?.amount_usd ?? (v?.currency === "USD" ? v.balance : undefined);
  if (!(typeof raw === "number" || typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw))) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
async function save(db: Db, key: string, value: unknown) {
  await db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}
export async function initializeUpstreamMonitor(ctx: Ctx) {
  if (!ctx.cfg.rush.enabled) return;
  const runtime: Runtime = { ctx, holds: new Map(), pending: new Map() };
  runtimes.set(ctx.health, runtime);
  const outage = ctx.health.outage.bind(ctx.health);
  ctx.health.outage = (model, provider) => (runtime.holds.get(provider) ?? 0) > Date.now() || outage(model, provider);
  await refreshUpstreamHealth(ctx.health, ctx.db);
}
/** Refreshes persisted holds on API replicas through the existing five-second health job. */
export async function refreshUpstreamHealth(health: HealthTracker, db: Db) {
  const runtime = runtimes.get(health);
  if (!runtime) return;
  for (const [provider, until] of runtime.pending) {
    await save(db, HOLD_PREFIX + provider, { until });
    if (runtime.pending.get(provider) === until) runtime.pending.delete(provider);
  }
  const rows = await db.select().from(kv).where(like(kv.key, HOLD_PREFIX + "%"));
  for (const row of rows) {
    const until = Number((row.value as { until?: unknown })?.until);
    if (Number.isFinite(until) && until > Date.now()) runtime.holds.set(row.key.slice(HOLD_PREFIX.length), until);
  }
  for (const [provider, until] of runtime.holds) if (until <= Date.now()) runtime.holds.delete(provider);
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
export function creditUnavailable(health: HealthTracker, provider: string) {
  return (runtimes.get(health)?.holds.get(provider) ?? 0) > Date.now();
}

export async function runUpstreamMonitor(ctx: Ctx, fetchImpl = providerFetch, now = Date.now()) {
  if (!ctx.cfg.rush.enabled) return { skipped: "disabled" };
  await ctx.catalog.ensureFresh();
  let checked = 0;
  for (const p of ctx.catalog.providers.values()) {
    if (p.status !== "live") continue;
    const endpoint = balanceEndpoint(p, ctx.cfg.rush.balanceUrl);
    let snapshot: BalanceSnapshot = { balance_usd: null, checked_at: now, status: endpoint ? "unknown" : "unsupported" };
    const headers = endpoint ? openProviderHeaders(ctx.cfg.appSecret, p.headers) : {};
    if (endpoint && (p.apiKeyEnc || Object.keys(headers).some(name => ["authorization", "api-key", "x-api-key"].includes(name.toLowerCase())))) {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { ...headers, "content-type": "application/json", ...(p.apiKeyEnc ? { authorization: `Bearer ${decrypt(ctx.cfg.appSecret, p.apiKeyEnc)}` } : {}) }, body: "{}",
        }, { production: ctx.cfg.production, tlsPin: p.tlsPin });
        if (response.ok) {
          const balance = parseBalance(await response.json());
          if (balance !== null) {
            snapshot = { ...snapshot, balance_usd: balance, status: "ok" };
            if (balance === 0) await save(ctx.db, HOLD_PREFIX + p.id, { until: now + CREDIT_HOLD_MS });
          }
        } else await response.body?.cancel();
      } catch { /* Unknown is explicit; response text and exception details are never retained. */ }
    }
    await save(ctx.db, BALANCE_PREFIX + p.id, snapshot);
    checked++;
  }
  await refreshUpstreamHealth(ctx.health, ctx.db);
  return { checked };
}
export function registerRushJobs(ctx: Ctx) {
  if (ctx.cfg.rush.enabled) ctx.jobs.register("upstream-monitor", MONITOR_INTERVAL_MS, () => runUpstreamMonitor(ctx), { atStart: true });
}
export async function upstreamAlertChecks(ctx: Ctx, now = Date.now()) {
  if (!ctx.cfg.rush.enabled) return {};
  const checks: Record<string, boolean> = {};
  const rows = await ctx.db.select().from(kv).where(like(kv.key, BALANCE_PREFIX + "%"));
  for (const row of rows) {
    const provider = row.key.slice(BALANCE_PREFIX.length);
    const name = `upstream_${sha256(provider).slice(0, 12)}`;
    const value = row.value as BalanceSnapshot;
    if (value.status === "unsupported") continue;
    const fresh = value.status === "ok" && value.balance_usd !== null && now - value.checked_at <= MONITOR_INTERVAL_MS * 3;
    checks[`${name}_balance`] = fresh;
    checks[`${name}_warn`] = !fresh || value.balance_usd! >= ctx.cfg.rush.warnUsd;
    checks[`${name}_critical`] = !fresh || value.balance_usd! >= ctx.cfg.rush.criticalUsd;
  }
  const holds = await ctx.db.select().from(kv).where(like(kv.key, HOLD_PREFIX + "%"));
  for (const row of holds) checks[`upstream_${sha256(row.key.slice(HOLD_PREFIX.length)).slice(0, 12)}_credits`] = Number((row.value as { until?: unknown }).until) <= now;
  return checks;
}
export async function upstreamAdminView(ctx: Ctx, now = Date.now()) {
  if (!ctx.cfg.rush.enabled) return { enabled: false, providers: [] };
  const rows = await ctx.db.select().from(kv).where(like(kv.key, "upstream-%"));
  return { enabled: true, warn_usd: ctx.cfg.rush.warnUsd, critical_usd: ctx.cfg.rush.criticalUsd, providers: [...ctx.catalog.providers.values()].filter(p => p.status === "live").map(p => {
    const value = rows.find(r => r.key === BALANCE_PREFIX + p.id)?.value as BalanceSnapshot | undefined;
    const until = Number((rows.find(r => r.key === HOLD_PREFIX + p.id)?.value as { until?: unknown })?.until) || 0;
    const fresh = value?.status === "ok" && now - value.checked_at <= MONITOR_INTERVAL_MS * 3;
    return { provider: p.id, balance_usd: fresh ? value.balance_usd : null, checked_at: value ? new Date(value.checked_at).toISOString() : null, status: fresh ? balanceLevel(value.balance_usd!, ctx.cfg.rush.warnUsd, ctx.cfg.rush.criticalUsd) : value?.status === "unsupported" ? "unsupported" : "unknown", unavailable_until: until > now ? new Date(until).toISOString() : null };
  }) };
}
