import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ApiError } from "../src/lib/errors.ts";
import { loadConfig } from "../src/config.ts";
import { attestations, generations, offers, providers } from "../src/db/schema.ts";
import { hostBondCursor, hostBondProjection } from "../src/network/bond-schema.ts";
import { bondScope } from "../src/network/bond-state.ts";
import { saveHostDisclosure } from "../src/network/admission-state.ts";
import { publishHostPolicy } from "../src/network/publication.ts";
import { networkStatsRoutes, readNetworkStats, statsCache, tokenBucket } from "../src/network/stats.ts";
import { networkWaitlist } from "../src/network/schema.ts";
import { DpStats } from "../src/lib/dpstats.ts";
import { setPrivateLaneStats } from "../src/services/private-stats.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

test("stats defaults off and real production loader accepts it on without weakening guards", () => {
  expect(loadConfig({}).networkStatsEnabled).toBe(false);
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", NETWORK_STATS_ENABLED: "true", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) });
  expect(cfg.production).toBe(true);
  expect(cfg.networkStatsEnabled).toBe(true);
});

test("coarse token ranges handle empty records, bucket boundaries and large totals without precision loss", () => {
  expect(tokenBucket("0", 0)).toBeNull();
  expect(tokenBucket("0", 1)).toEqual({ lower: "0", upper_exclusive: "100000" });
  expect(tokenBucket("99999", 1)).toEqual(tokenBucket("1", 1));
  expect(tokenBucket("100000", 1)).toEqual({ lower: "100000", upper_exclusive: "200000" });
  expect(tokenBucket("9007199254740993123", 1)).toEqual({ lower: "9007199254740900000", upper_exclusive: "9007199254741000000" });
});

test("cache shares concurrent reads, expires at 30 seconds and retries errors without serving stale data", async () => {
  let now = 0, reads = 0, failed = false;
  const get = statsCache(async () => { reads++; if (failed) throw Error("fixture failure"); return reads; }, () => now);
  const results = await Promise.all([get(), get(), get()]);
  expect(reads).toBe(1); expect(results.every(r => r.data === 1)).toBe(true);
  now = 29_999; expect((await get()).data).toBe(1);
  now = 30_000; failed = true; await expect(get()).rejects.toThrow("fixture failure");
  failed = false; expect((await get()).data).toBe(3);
});

describe("network stats from stored fixtures", () => {
  let h: Harness;
  const ids = ["probation", "live", "rejected", "stale", "failed", "development", "no-admission", "disabled-model"];
  beforeAll(async () => {
    h = await startRouter({ env: { NETWORK_STATS_ENABLED: "true", NETWORK_POLICY_ENABLED: "true", TLOG_ENABLED: "true", NETWORK_BONDS_ENABLED: "true", HOST_BOND_ADDRESS: "0x" + "1".repeat(40) }, providers: ids.map(id => ({ id, name: id, models: [MODELS.qwen] })) });
  });
  afterAll(async () => h?.close());

  test("public empty state, optional sources and default-off registration", async () => {
    const result = await h.request("/api/v1/network/stats");
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toMatch(/public, max-age=\d+, must-revalidate/);
    const { data } = await result.json();
    expect(data.hosts).toEqual({ total: 0, probation: 0, live: 0, rejected: 0 });
    expect(data.attested_hosts).toBe(0); expect(data.capacity.models).toEqual([]);
    expect(data.tokens.public_lane.days_7).toBeNull(); expect(data.tokens.private_lanes).toBeNull();
    expect(data.bonds.fresh).toBe(false); expect(data.policy_version).toBeNull(); expect(data.interest.total).toBe(0);
    const off = new Hono(); networkStatsRoutes(off, { ...h.ctx, cfg: { ...h.ctx.cfg, networkStatsEnabled: false } });
    expect((await off.request("/api/v1/network/stats")).status).toBe(404);
  });

  test("status counts, honest fresh admission, distinct model capacity, waitlist, policy and indexed bonds", async () => {
    for (const id of ids) {
      await h.ctx.db.update(providers).set({ networkHost: true, networkModels: [MODELS.qwen.id], status: id === "probation" ? "probation" : id === "rejected" ? "rejected" : "live", networkReasons: id === "rejected" ? ["off-policy"] : [], attested: true, attestationHash: "ab".repeat(32), attestedAt: new Date(), teeKind: "tdx" }).where(eq(providers.id, id));
      await h.ctx.db.insert(attestations).values({ providerId: id, ok: id !== "failed", teeKind: "tdx", detail: id === "development" ? { simulated: true } : {} });
      if (id !== "no-admission") await saveHostDisclosure(h.ctx, id, 1);
    }
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 4) }).where(eq(providers.id, "stale"));
    await h.ctx.db.update(offers).set({ status: "disabled" }).where(eq(offers.providerId, "disabled-model"));
    await h.ctx.db.insert(networkWaitlist).values([{ id: "interest-a", role: "host_cpu", hardware: "CPU", readiness: "TDX", region: "europe", paidIn: "usdg", deleteCodeHash: "a".repeat(64) }, { id: "interest-b", role: "developer", hardware: "", readiness: "", region: "asia", paidIn: "any", deleteCodeHash: "b".repeat(64) }]);
    const digest = "sha256:" + "1".repeat(64);
    await publishHostPolicy(h.ctx, { version: 1, issued_at: "2026-01-01T00:00:00.000Z", tee_kinds: ["tdx"], sidecar: { image_digests: [digest], source_hashes: [digest] }, engines: [{ name: "engine", image_digest: digest }], models: [{ id: MODELS.qwen.id, model_digest: digest, min_gpu_cc: false }], rules: { require_gpu_cc_for: [], allow_dev: false } });
    const scope = bondScope(h.ctx.cfg);
    await h.ctx.db.insert(hostBondCursor).values({ scope, block: 123n, checkpoints: [], checkedAt: new Date() });
    await h.ctx.db.insert(hostBondProjection).values([{ scope, kind: "host", id: "a", data: { bond: "10000000000", unbond: "3000000000" } }, { scope, kind: "host", id: "b", data: { bond: "5000000000", unbond: "0" } }, { scope: "another-chain", kind: "host", id: "c", data: { bond: "99000000000", unbond: "0" } }]);
    const data = await readNetworkStats(h.app, h.ctx);
    expect(data.hosts).toEqual({ total: 8, probation: 1, live: 6, rejected: 1 });
    expect(data.attested_hosts).toBe(3);
    expect(data.capacity).toMatchObject({ model_count: 1, models: [MODELS.qwen.slug] });
    expect(data.bonds).toMatchObject({ total_units: "15000000000", active_units: "12000000000", fresh: true, indexed_block: "123" });
    expect(data.interest).toMatchObject({ total: 2, readiness_mentions: 1, by_role: { host_cpu: 1, developer: 1 }, by_region: { europe: 1, asia: 1 } });
    expect(data.policy_version).toBe(1);
    // The endpoint's previous empty snapshot is reused rather than querying again.
    expect((await (await h.request("/api/v1/network/stats")).json()).data.hosts.total).toBe(0);
    h.ctx.cfg.hostBonds.enabled = false; h.ctx.cfg.networkPolicyEnabled = false;
    const disabled = await readNetworkStats(h.app, h.ctx);
    expect(disabled.bonds).toBeNull(); expect(disabled.policy_version).toBeNull();
  });

  test("7/30-day coarse public ranges exclude private rows, other lanes, cache, old and future records", async () => {
    const now = Date.now();
    const row = (id: string, days: number, tokens: number, extra = {}) => ({ id, ts: new Date(now - days * 86_400_000), modelId: MODELS.qwen.id, providerId: "live", tokensIn: tokens, tokensOut: 10, mode: "prepaid", ...extra });
    await h.ctx.db.insert(generations).values([row("recent", 1, 123450), row("older", 15, 200000), row("old", 31, 999999), row("future", -1, 999999), row("cache", 1, 999999, { mode: "cache" }), row("private", 1, 999999, { private: true }), row("attested", 1, 999999, { receipt: { lane: "attested" } }), row("unlinkable", 1, 999999, { receipt: { lane: "unlinkable" } })]);
    const before = (await readNetworkStats(h.app, h.ctx)).tokens;
    expect(before.public_lane.days_7).toEqual({ lower: "100000", upper_exclusive: "200000" });
    expect(before.public_lane.days_30).toEqual({ lower: "300000", upper_exclusive: "400000" });
    expect(before.private_lanes).toBeNull(); expect(before.dp_stats_url).toBe("/api/v1/stats");
    const dp = new DpStats({ requestKinds: ["attested", "unlinkable"], blockReasons: [] }); for (let i = 0; i < 100; i++) dp.observe({ kind: "attested", tokens: 1_000_000 });
    setPrivateLaneStats(h.ctx, dp);
    expect((await readNetworkStats(h.app, h.ctx)).tokens).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("123460");
  });

  test("failed sources return 503 without exception content or stale-cache headers", async () => {
    const broken = new Hono();
    broken.onError((error, c) => error instanceof ApiError ? c.json(error.toJSON(), error.status as 503) : c.json({}, 500));
    networkStatsRoutes(broken, h.ctx);
    const result = await broken.request("/api/v1/network/stats");
    expect(result.status).toBe(503); expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.text()).not.toContain("Aggregate source");
  });
});
