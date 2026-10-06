import { refreshUpstreamHealth } from "../rush/monitor.ts"; // ON3
import { sql } from "drizzle-orm";
import { refreshNetworkRouting } from "../network/routing.ts";
import type { Db } from "../db/client.ts";
import { health } from "../db/schema.ts";
import type { HealthView, Percentiles } from "../router/select.ts";
import { log, percentile } from "../lib/util.ts";

export type HealthEvent = {
  modelId: string;
  providerId: string;
  ok: boolean;
  latencyMs?: number | null; // time to first token (or full response for non-stream)
  tps?: number | null;
  empty200?: boolean;
  statusCode?: number | null;
  errorKind?: string | null; // http_5xx | timeout | connection | empty200 | rate_limited | rejected | unreadable
  source?: "traffic" | "probe" | "canary";
  caller?: string | null; // hashed account id: empty-200s only count when several callers see them
  at?: number;
};

// Client-caused rejections (4xx) never count against a provider.
const counts = (e: HealthEvent) => e.ok || e.errorKind !== "rejected";
const hardFailure = (e: HealthEvent) => !e.ok && e.errorKind !== "rejected";
const countsForUptime = (e: HealthEvent) => e.ok || (e.errorKind !== "rejected" && e.errorKind !== "rate_limited");

export class HealthTracker implements HealthView {
  private recent = new Map<string, HealthEvent[]>();
  private uptimeMap = new Map<string, { ok: number; total: number }>();
  private qualityMap = new Map<string, number>();
  private pending: HealthEvent[] = [];
  private unflushed = new Map<string, { ok: number; total: number }>();

  constructor(private outageWindowMs = 30_000, private historyMs = 60 * 60_000, private maxEvents = 2_000) {}

  private k = (m: string, p: string) => `${m}\u0000${p}`;

  record(e: HealthEvent) {
    const ev = { ...e, at: e.at ?? Date.now() };
    const key = this.k(e.modelId, e.providerId);
    const list = this.recent.get(key) ?? [];
    list.push(ev);
    const cutoff = Date.now() - this.historyMs;
    while (list.length && (list[0].at! < cutoff || list.length > this.maxEvents)) list.shift();
    this.recent.set(key, list);
    this.pending.push(ev);
    this.bump(ev, 1);
  }

  private bump(e: HealthEvent, sign: 1 | -1) {
    if (!countsForUptime(e)) return;
    const key = this.k(e.modelId, e.providerId);
    const u = this.unflushed.get(key) ?? { ok: 0, total: 0 };
    u.total += sign;
    if (e.ok) u.ok += sign;
    this.unflushed.set(key, u);
  }

  /** Outage: in the last 30s, >= 2 hard failures and at least as many failures as successes,
   *  or the most recent probe failed with no success since. */
  outage(modelId: string, providerId: string) {
    const list = this.recent.get(this.k(modelId, providerId));
    if (!list?.length) return false;
    const since = Date.now() - this.outageWindowMs;
    let fails = 0;
    let oks = 0;
    let empties = 0;
    const emptyCallers = new Set<string>();
    for (let i = list.length - 1; i >= 0 && list[i].at! >= since; i--) {
      const e = list[i];
      if (!counts(e)) continue;
      if (e.ok) oks++;
      else if (e.errorKind === "empty200") {
        // A single caller can provoke empty answers; only count them once two callers (or a probe) see them.
        empties++;
        emptyCallers.add(e.caller ?? `src:${e.source}`);
      } else fails++;
    }
    if (emptyCallers.size >= 2) fails += empties;
    if (fails >= 2 && fails >= oks) return true;
    const last = [...list].reverse().find(counts);
    return !!last && last.at! >= since && hardFailure(last) && last.source === "probe";
  }

  lastFailureKind(modelId: string, providerId: string) { // B121: distinguish availability from rate/policy outages without retaining new data.
    return this.recent.get(this.k(modelId, providerId))?.findLast(e => !e.ok && (e.at ?? 0) >= Date.now() - this.outageWindowMs)?.errorKind;
  }

  uptime30d(modelId: string, providerId: string) {
    const key = this.k(modelId, providerId);
    const agg = this.uptimeMap.get(key) ?? { ok: 0, total: 0 };
    const extra = this.unflushed.get(key) ?? { ok: 0, total: 0 }; // recorded but not yet aggregated
    const ok = agg.ok + extra.ok;
    const total = agg.total + extra.total;
    // Laplace-style prior: a new provider starts at ~0.95-1.0 rather than 0 or 1.
    return (ok + 19) / (total + 20);
  }

  /** Measured 30-day success rate (no prior), or null without observations. For display, not routing. */
  observedUptime(modelId: string, providerId: string): { rate: number; events: number } | null {
    const key = this.k(modelId, providerId);
    const agg = this.uptimeMap.get(key) ?? { ok: 0, total: 0 };
    const extra = this.unflushed.get(key) ?? { ok: 0, total: 0 };
    const total = agg.total + extra.total;
    return total ? { rate: (agg.ok + extra.ok) / total, events: total } : null;
  }

  quality(modelId: string, providerId: string) {
    const q = this.qualityMap.get(this.k(modelId, providerId));
    return q == null ? 1 : Math.min(1, Math.max(0.5, q));
  }

  setQuality(modelId: string, providerId: string, q: number) {
    this.qualityMap.set(this.k(modelId, providerId), Math.min(1, Math.max(0.5, q)));
  }

  stats(modelId: string, providerId: string): { latency: Percentiles; throughput: Percentiles } | null {
    const list = (this.recent.get(this.k(modelId, providerId)) ?? []).filter((e) => e.ok);
    if (list.length < 3) return null;
    const lat = list.map((e) => e.latencyMs).filter((x): x is number => x != null).sort((a, b) => a - b);
    const tps = list.map((e) => e.tps).filter((x): x is number => x != null).sort((a, b) => a - b);
    // For throughput, "p90" means the rate 90% of requests reach or exceed, so read from the low end.
    const low = (p: number) => percentile(tps, 100 - p) ?? undefined;
    return {
      latency: { p50: percentile(lat, 50) ?? undefined, p75: percentile(lat, 75) ?? undefined, p90: percentile(lat, 90) ?? undefined, p99: percentile(lat, 99) ?? undefined },
      throughput: { p50: low(50), p75: low(75), p90: low(90), p99: low(99) },
    };
  }

  snapshot(modelId: string, providerId: string) {
    return {
      outage: this.outage(modelId, providerId),
      uptime30d: this.uptime30d(modelId, providerId),
      quality: this.quality(modelId, providerId),
      stats: this.stats(modelId, providerId),
    };
  }

  /** Persist buffered events. */
  async flush(db: Db) {
    await refreshUpstreamHealth(this, db); // ON3
    if (!this.pending.length) { await refreshNetworkRouting(this, db).catch(() => undefined); return 0; }
    const batch = this.pending.splice(0, this.pending.length);
    try {
      for (let i = 0; i < batch.length; i += 500) {
        await db.insert(health).values(
          batch.slice(i, i + 500).map((e) => ({
            modelId: e.modelId,
            providerId: e.providerId,
            ts: new Date(e.at!),
            ok: e.ok,
            latencyMs: e.latencyMs == null ? null : Math.round(e.latencyMs),
            tps: e.tps ?? null,
            empty200: !!e.empty200,
            statusCode: e.statusCode ?? null,
            errorKind: e.errorKind ?? null,
            source: e.source ?? "traffic",
            caller: e.caller ?? null,
          })),
        );
      }
    } catch (err) {
      log.error("health flush failed", { error: (err as Error).message });
      this.pending.unshift(...batch);
      throw err;
    }
    await this.refreshAggregates(db);
    for (const e of batch) this.bump(e, -1);
    return batch.length;
  }

  /** Recompute 30-day uptime and latest canary quality per model x provider. */
  async refreshAggregates(db: Db) {
    await refreshNetworkRouting(this, db).catch(() => undefined);
    const up = await db.execute(sql`
      SELECT model_id, provider_id,
             count(*) FILTER (WHERE ok) AS ok,
             count(*) AS total
      FROM health
      WHERE ts > now() - interval '30 days'
        AND (ok OR (error_kind IS DISTINCT FROM 'rejected' AND error_kind IS DISTINCT FROM 'rate_limited'))
      GROUP BY model_id, provider_id`);
    const rows = ((up as { rows?: unknown[] }).rows ?? up) as Array<{ model_id: string; provider_id: string; ok: number | string; total: number | string }>;
    const map = new Map<string, { ok: number; total: number }>();
    for (const r of rows) map.set(this.k(r.model_id, r.provider_id), { ok: Number(r.ok), total: Number(r.total) });
    this.uptimeMap = map;
    const q = await db.execute(sql`
      SELECT DISTINCT ON (model_id, provider_id) model_id, provider_id, quality
      FROM canaries WHERE quality IS NOT NULL
      ORDER BY model_id, provider_id, ts DESC`);
    const qrows = ((q as { rows?: unknown[] }).rows ?? q) as Array<{ model_id: string; provider_id: string; quality: number }>;
    for (const r of qrows) this.qualityMap.set(this.k(r.model_id, r.provider_id), Number(r.quality));
  }

  empty200Rate(modelId: string, providerId: string, windowMs = 24 * 3_600_000) {
    const since = Date.now() - windowMs;
    const list = (this.recent.get(this.k(modelId, providerId)) ?? []).filter((e) => e.at! >= since && e.source === "traffic");
    if (!list.length) return { rate: 0, n: 0 };
    return { rate: list.filter((e) => e.empty200).length / list.length, n: list.length };
  }
}
