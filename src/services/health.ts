import { sql } from "drizzle-orm";
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
