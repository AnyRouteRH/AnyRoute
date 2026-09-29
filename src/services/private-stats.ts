import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { generations } from "../db/schema.ts";
import { DpStats, type Observation } from "../lib/dpstats.ts";

// Public metrics for the private lanes (`attested`, `unlinkable`) come only from differentially private hourly
// counters (lib/dpstats.ts, the same file the sidecar runs). The router still keeps its per-request rows for billing
// and receipts, but every public aggregate built from those rows is limited to the public lane (`PUBLIC_LANE_ROWS`),
// and private-lane traffic is published only as noisy hourly releases at GET /api/v1/stats.

export const PRIVATE_LANES = ["attested", "unlinkable"] as const;

/** Why a private-lane request was refused, from its HTTP status and error type. Fixed and public. */
export const ROUTER_BLOCK_REASONS = ["unauthorized", "payment_required", "forbidden", "no_provider", "rate_limited", "invalid_request", "upstream_error"] as const;

export function blockReasonForStatus(status: number, type?: string): string {
  if (type === "no_attested_endpoint" || type === "disclosure_provider_unavailable" || type === "disclosure_unavailable") return "no_provider";
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 403) return "forbidden";
  if (status === 409) return "no_provider";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return "invalid_request";
}

const stats = new WeakMap<Ctx, DpStats>();
const lanes = new WeakMap<Request, string>();
const counted = new WeakSet<Request>();

/** The counters of this router process, created on first use. */
export function privateLaneStats(ctx: Ctx): DpStats {
  let s = stats.get(ctx);
  if (!s) {
    s = new DpStats({ requestKinds: PRIVATE_LANES, blockReasons: ROUTER_BLOCK_REASONS });
    stats.set(ctx, s);
  }
  return s;
}

/** Test hook: replace the counters (a test clock, a seeded source). */
export function setPrivateLaneStats(ctx: Ctx, s: DpStats) {
  stats.set(ctx, s);
}

/** Remember that this request asked for a private lane. The public lane is not counted here. */
export function noteLane(req: Request, lane: string) {
  if (lane !== "public") lanes.set(req, lane);
}

export const isPrivateLaneRequest = (req: Request) => lanes.has(req);

/**
 * Count a private-lane request, once: the first call for a request wins, so council and dual-verification requests
 * (several provider calls) still add at most 1 to each family.
 */
export function recordPrivateLane(ctx: Ctx, req: Request, o: Omit<Observation, "kind">) {
  const lane = lanes.get(req);
  if (!lane || counted.has(req)) return;
  counted.add(req);
  privateLaneStats(ctx).observe({ kind: lane, ...o });
}

/** Rows served on the public lane: the only rows raw public aggregates (status, rankings) may be built from. */
export const PUBLIC_LANE_ROWS = sql`(NOT ${generations.private} AND coalesce(${generations.receipt}->>'lane', 'public') = 'public')`;
