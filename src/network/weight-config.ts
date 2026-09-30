import { z } from "zod";

/** Network-only policy. Multipliers apply after the existing price/quality/lane formula. */
export const NETWORK_WEIGHT_POLICY = Object.freeze({
  probationWeight: 0.1, // Ten percent until the probation period and evidence thresholds pass.
  errorThreshold: 0.05, // More than five percent counted failures in the last hour.
  errorWeight: 0.25, // Quarter weight while above that error threshold.
  minimumUptime: 0.9, // Below ninety percent observed probe availability: no traffic.
  latencyTargetMs: 1_000, // Above this median response latency, scale by target / observed.
  maximumLatencyMs: 30_000, // At this median response latency, no traffic.
  recentWindowMs: 3_600_000,
  evidenceMaxAgeMs: 120_000, // Fail closed if the health aggregate refresh stops.
});

export const networkWeightEnv = {
  NETWORK_HOSTS_ENABLED: z.union([z.boolean(), z.string()]).transform((v) => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false),
  NETWORK_PROBATION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  NETWORK_GRADUATE_REQUESTS: z.coerce.number().int().min(1).default(200),
  NETWORK_GRADUATE_UPTIME: z.coerce.number().min(0.9).max(1).default(0.99),
};

export function networkWeightSettings(e: z.infer<z.ZodObject<typeof networkWeightEnv>>) {
  return { enabled: e.NETWORK_HOSTS_ENABLED, probationDays: e.NETWORK_PROBATION_DAYS, graduateRequests: e.NETWORK_GRADUATE_REQUESTS, graduateUptime: e.NETWORK_GRADUATE_UPTIME };
}

export type NetworkWeightSettings = ReturnType<typeof networkWeightSettings>;
