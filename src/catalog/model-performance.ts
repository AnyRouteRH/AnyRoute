// E150: catalogue-only measurements from existing health events; no new retained data.
import type { Ctx } from "../context.ts";
import type { Candidate } from "../catalog/catalog.ts";
import type { HealthEvent } from "../services/health.ts";
import { percentile } from "../lib/util.ts";

export const PERFORMANCE_WINDOW_SECONDS = 1800;
const reading = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Fresh successful readings only. A median needs at least three measurements of that metric. */
export function recentPerformance(events: readonly HealthEvent[], now = Date.now()) {
  const successful = events.filter(e => e.ok && e.at != null && e.at > now - PERFORMANCE_WINDOW_SECONDS * 1000 && e.at <= now);
  const median = (values: unknown[]) => {
    const sorted = values.filter(reading).sort((a, b) => a - b);
    return sorted.length >= 3 ? percentile(sorted, 50) ?? null : null;
  };
  return { latency_p50_ms: median(successful.map(e => e.latencyMs)), throughput_p50_tps: median(successful.map(e => e.tps)) };
}

/** Best measured speed per eligible route; observation-weighted success rate for this model's eligible routes. */
export function modelPerformance(ctx: Ctx, modelId: string, offers: Candidate[]) {
  const rows = [...new Set(offers.map(o => o.providerId))].map(providerId => ({
    speed: ctx.health.catalogPerformance?.(modelId, providerId),
    uptime: ctx.health.observedUptime?.(modelId, providerId),
  }));
  const best = (key: "latency_p50_ms" | "throughput_p50_tps", compare: (a: number, b: number) => number) => {
    const values = rows.map(row => row.speed?.[key]).filter(reading).sort(compare);
    return values[0] ?? null;
  };
  const observations = rows.flatMap(row => row.uptime && row.uptime.events > 0 && reading(row.uptime.rate) && row.uptime.rate <= 1 ? [row.uptime] : []);
  const events = observations.reduce((total, row) => total + row.events, 0);
  return {
    latency_p50_ms: best("latency_p50_ms", (a, b) => a - b),
    throughput_p50_tps: best("throughput_p50_tps", (a, b) => b - a),
    speed_window_seconds: PERFORMANCE_WINDOW_SECONDS,
    uptime_percent: events ? Number((100 * observations.reduce((total, row) => total + row.rate * row.events, 0) / events).toFixed(2)) : null,
    uptime_window_days: 30,
    uptime_observations: events,
  };
}
