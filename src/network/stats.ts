import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { generations, offers, providers } from "../db/schema.ts";
import { latestAttempts, summarizeAttestation } from "../api/provider-attestation.ts";
import { PUBLIC_LANE_ROWS } from "../services/private-stats.ts";
import { hostAdmission } from "./dashboard.ts";
import { fail } from "../lib/errors.ts";

export const NETWORK_STATS_CACHE_MS = 30_000;
export const NETWORK_TOKEN_BUCKET = 100_000n;

/** Ranges, never a misleading exact total. Coarsening is not differential privacy. */
export function tokenBucket(total: string, rows: number) {
  if (!rows) return null;
  const lower = BigInt(total) / NETWORK_TOKEN_BUCKET * NETWORK_TOKEN_BUCKET;
  return { lower: lower.toString(), upper_exclusive: (lower + NETWORK_TOKEN_BUCKET).toString() };
}

/** Single flight per router, with no stale-on-error fallback or persistent cache. */
export function statsCache<T>(read: () => Promise<T>, clock = Date.now, ttlMs = NETWORK_STATS_CACHE_MS) {
  let cached: { data: T; expires: number } | undefined;
  let pending: Promise<{ data: T; expires: number }> | undefined;
  return async () => {
    const now = clock();
    if (cached && now < cached.expires) return cached;
    if (!pending) {
      pending = read().then(data => (cached = { data, expires: now + ttlMs })).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

async function routeData<T>(app: Hono, path: string, optional: boolean): Promise<T | null>;
async function routeData<T>(app: Hono, path: string): Promise<T>;
async function routeData<T>(app: Hono, path: string, optional = false): Promise<T | null> {
  const response = await app.request(path);
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error("Network aggregate source unavailable.");
  return response.json() as Promise<T>;
}

export async function readNetworkStats(app: Hono, ctx: Ctx) {
  const at = new Date();
  // Only public host evidence is selected; endpoint credentials, wallets and contact are not read.
  const hosts = await ctx.db.select({ id: providers.id, networkHost: providers.networkHost, status: providers.status,
    networkReasons: providers.networkReasons, networkModels: providers.networkModels, attested: providers.attested,
    attestationHash: providers.attestationHash, attestedAt: providers.attestedAt, teeKind: providers.teeKind,
  }).from(providers).where(eq(providers.networkHost, true));
  const attempts = await latestAttempts(ctx, hosts.map(p => p.id));
  const admitted: string[] = [];
  for (const p of hosts) {
    if ((await hostAdmission(ctx, p, summarizeAttestation(ctx, p, attempts.get(p.id))))?.status === "approved") admitted.push(p.id);
  }
  const eligible = admitted.length ? await ctx.db.select({ providerId: offers.providerId, modelId: offers.modelId, providerModelId: offers.providerModelId }).from(offers)
    .where(and(inArray(offers.providerId, admitted), inArray(offers.status, ["shadow", "live"]))) : [];
  const models = [...new Set(eligible.filter(o => hosts.find(p => p.id === o.providerId)?.networkModels.includes(o.providerModelId)).map(o => o.modelId))].sort();
  // Existing private-lane DP releases have no host dimension and only 48 hours of history.
  // Never reconstruct a private host subtotal from billing rows or attribute router-wide DP counts to hosts.
  const [tokens] = await ctx.db.select({
    d7: sql<string>`coalesce(sum(${generations.tokensIn}::bigint + ${generations.tokensOut}::bigint) filter (where ${generations.ts} > ${new Date(at.getTime() - 7 * 86_400_000).toISOString()}), 0)::text`,
    d30: sql<string>`coalesce(sum(${generations.tokensIn}::bigint + ${generations.tokensOut}::bigint), 0)::text`,
    rows7: sql<number>`count(*) filter (where ${generations.ts} > ${new Date(at.getTime() - 7 * 86_400_000).toISOString()})::int`,
    rows30: sql<number>`count(*)::int`,
  }).from(generations).innerJoin(providers, eq(providers.id, generations.providerId))
    .where(and(eq(providers.networkHost, true), PUBLIC_LANE_ROWS, sql`${generations.mode} <> 'cache'`,
      sql`${generations.ts} > ${new Date(at.getTime() - 30 * 86_400_000).toISOString()} and ${generations.ts} <= ${at.toISOString()}`));
  const bonds = ctx.cfg.hostBonds.enabled ? (await routeData<{ data: { total_units: string; active_units: string; asset: string; decimals: number; fresh: boolean; indexed_block: string | null } }>(app, "/api/v1/network/bonds")).data : null;
  const interest = await routeData<{ total: number; by_role: Record<string, number>; by_region: Record<string, number>; readiness_mentions: number }>(app, "/api/v1/network/waitlist/stats");
  const policy = ctx.cfg.networkPolicyEnabled ? await routeData<{ data: { policy: { version: number } } }>(app, "/api/v1/network/policy", true) : null;
  return {
    as_of: at.toISOString(), cache_seconds: NETWORK_STATS_CACHE_MS / 1000,
    hosts: { total: hosts.length, probation: hosts.filter(p => p.status === "probation").length,
      live: hosts.filter(p => p.status === "live").length, rejected: hosts.filter(p => p.status === "rejected").length },
    attested_hosts: admitted.length,
    capacity: { model_count: models.length, models, definition: "Distinct eligible models on admitted hosts with fresh successful attestation; not GPU capacity or throughput." },
    tokens: { public_lane: { days_7: tokenBucket(tokens.d7, tokens.rows7), days_30: tokenBucket(tokens.d30, tokens.rows30), bucket_size: NETWORK_TOKEN_BUCKET.toString() },
      private_lanes: null, dp_stats_url: "/api/v1/stats",
      definition: "Input plus output tokens on network hosts, excluding cache hits, from retained public-lane records only. Ranges use 100,000-token buckets, not differential privacy. Private-lane DP counters cover the router, not network hosts, and cannot supply 7/30-day host totals." },
    bonds: bonds ? { total_units: bonds.total_units, active_units: bonds.active_units, asset: bonds.asset, decimals: bonds.decimals,
      fresh: bonds.fresh, indexed_block: bonds.indexed_block } : null,
    interest: { total: interest.total, by_role: interest.by_role, by_region: interest.by_region, readiness_mentions: interest.readiness_mentions },
    policy_version: policy?.data.policy.version ?? null,
  };
}

export function networkStatsRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.networkStatsEnabled) return;
  const get = statsCache(() => readNetworkStats(app, ctx));
  app.get("/api/v1/network/stats", async c => {
    try {
      const result = await get();
      // HTTP freshness cannot extend the in-process deadline beyond 30 seconds.
      c.header("Cache-Control", `public, max-age=${Math.max(0, Math.floor((result.expires - Date.now()) / 1000))}, must-revalidate`);
      return c.json({ data: result.data });
    } catch {
      c.header("Cache-Control", "no-store");
      fail(503, "Network statistics unavailable.", "unavailable");
    }
  });
}
