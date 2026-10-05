import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { activityAccess } from "../activity/access.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";

// Lane report: where an account's calls ran over a date range. For each lane (public, attested, unlinkable) the calls
// and the charged spend; the share that ran on proven hardware; and, for the two proven lanes, each provider and model
// with a link to that provider's hardware evidence. It reads the existing call records only (the lane each call's
// receipt records, its provider, model, charged cost and time) and keeps nothing. The same summary is a section of the
// proof pack (src/proof-pack/read.ts), built from the calls listed in that file, and scripts/verify-proof-pack.mjs
// recomputes it from those calls.
//
// Not recorded per call, so not in the report: whether a lane was filled in by a key's default route (U101 only sets a
// response header), and requests refused because no endpoint on a lane could take them (those feed only the
// differentially private hourly counters in services/private-stats.ts).

export const LANE_REPORT_TYPE = "anyroute.lane-report.v1";
/** Lanes that admit only endpoints with a fresh hardware attestation the router verified (router/select.ts). */
export const PROVEN_LANES = ["attested", "unlinkable"] as const;
const LANE_ORDER = ["public", "attested", "unlinkable"] as const;
export const LANE_REPORT_LIMITS = { maxDays: 31, perMinute: 30 } as const;
export const PROOF_TIME_URL = "/status/#proof-time";
const DAY_MS = 86_400_000;

/** Where a provider's hardware evidence is read: the Verify page, and the router's attestation record it shows. */
export const evidenceUrl = (provider: string) => `/verify/?p=${encodeURIComponent(provider)}`;
export const attestationUrl = (provider: string) => `/api/v1/attestation/${encodeURIComponent(provider)}`;

// Dates as the proof pack reads them: YYYY-MM-DD, a real calendar date, UTC.
const day = (v: string | undefined, name: string) => {
  const ok = v !== undefined && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
  if (!ok) fail(400, `Give ${name} as a calendar date in YYYY-MM-DD format (UTC).`, "invalid_request");
  return new Date(`${v}T00:00:00.000Z`);
};

/** from and to are UTC calendar dates, both included. Over LANE_REPORT_LIMITS.maxDays answers 413. */
export function laneReportQuery(q: Record<string, string | undefined>, now = new Date()) {
  const from = day(q.from, "from");
  const last = day(q.to, "to");
  if (last < from) fail(400, "from must be on or before to.", "invalid_request");
  if (from > now) fail(400, "This range starts in the future.", "invalid_request");
  const days = Math.round((last.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > LANE_REPORT_LIMITS.maxDays) fail(413, `A lane report covers at most ${LANE_REPORT_LIMITS.maxDays} days; this range has ${days}. Choose a shorter range.`, "range_too_large", { max_days: LANE_REPORT_LIMITS.maxDays, days });
  return { from, toExclusive: new Date(last.getTime() + DAY_MS), fromDay: q.from!, toDay: q.to!, days };
}
export type LaneReportQuery = ReturnType<typeof laneReportQuery>;

/** Calls and charged pico-USDG for one lane, provider and model. A lane the receipt does not record is null. */
export type LaneGroup = { lane: string | null; provider: string; model: string; calls: number; pico: bigint };

/** part / whole to four decimal places, rounded half up; null when there is nothing to divide. The verifier does the same. */
export function share(part: bigint, whole: bigint): number | null {
  return whole === 0n ? null : Number((part * 20_000n + whole) / (2n * whole)) / 10_000;
}

const isProven = (lane: string | null) => (PROVEN_LANES as readonly (string | null)[]).includes(lane);
const laneRank = (lane: string | null) => (lane === null ? 99 : LANE_ORDER.indexOf(lane as (typeof LANE_ORDER)[number]) + 1 || 50);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The report body from grouped calls: totals, each lane (the three lanes always, then any other lane name a receipt
 * records, then calls with no recorded lane as null), the proven share, and one row per provider and model on the
 * proven lanes. Amounts are exact USDG decimal strings.
 */
export function summarizeLanes(groups: LaneGroup[]) {
  let calls = 0n, spend = 0n, provenCalls = 0n, provenSpend = 0n;
  const lanes = new Map<string | null, { calls: bigint; spend: bigint }>(LANE_ORDER.map((l) => [l, { calls: 0n, spend: 0n }]));
  const rows = new Map<string, { lane: string; provider: string; model: string; calls: bigint; spend: bigint }>();
  for (const g of groups) {
    const n = BigInt(g.calls);
    calls += n;
    spend += g.pico;
    const lane = lanes.get(g.lane) ?? { calls: 0n, spend: 0n };
    lane.calls += n;
    lane.spend += g.pico;
    lanes.set(g.lane, lane);
    if (!isProven(g.lane)) continue;
    provenCalls += n;
    provenSpend += g.pico;
    const id = JSON.stringify([g.lane, g.provider, g.model]);
    const row = rows.get(id) ?? { lane: g.lane!, provider: g.provider, model: g.model, calls: 0n, spend: 0n };
    row.calls += n;
    row.spend += g.pico;
    rows.set(id, row);
  }
  const money = picoToUsdString;
  return {
    currency: "USDG",
    totals: { calls: Number(calls), spend: money(spend) },
    lanes: [...lanes]
      .sort(([a], [b]) => laneRank(a) - laneRank(b) || byText(a ?? "", b ?? ""))
      .map(([lane, t]) => ({ lane, proven: isProven(lane), calls: Number(t.calls), spend: money(t.spend), share_of_calls: share(t.calls, calls), share_of_spend: share(t.spend, spend) })),
    proven: { lanes: [...PROVEN_LANES], calls: Number(provenCalls), spend: money(provenSpend), share_of_calls: share(provenCalls, calls), share_of_spend: share(provenSpend, spend) },
    providers: [...rows.values()]
      .sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || byText(a.provider, b.provider) || byText(a.model, b.model))
      .map((r) => ({ lane: r.lane, provider: r.provider, model: r.model, calls: Number(r.calls), spend: money(r.spend), evidence_url: evidenceUrl(r.provider), attestation_url: attestationUrl(r.provider) })),
  };
}
export type LaneSummary = ReturnType<typeof summarizeLanes>;

const NOT_RECORDED = {
  default_route: "Whether a request's lane came from the key's default route is not recorded per call; the response header X-Anyroute-Default-Route says so at the time. Each call is counted under the lane it was served on.",
  refusals: "Requests refused because no endpoint on a lane could take them are not recorded per account, so they are not counted here.",
};
const LIMITS = [
  "Calls are counted by call time in UTC, with the same scope and rows as Activity and the proof pack. Spend is the amount charged for each call; the monthly statement groups charged usage by settlement time, so the two can differ near a month's edge.",
  "The lane is the one each call's signed receipt records. Calls on the attested and unlinkable lanes ran on proven hardware: both lanes admit only endpoints whose fresh hardware attestation the router verified.",
  "Each evidence link shows that provider's current attestation record and its history; each call's receipt carries the attestation reference it was served under. Proof-time shows how recently each provider's hardware was verified.",
  "Calls paid with a blind token name no payer, so the router cannot attribute them to an account and they are not in this report.",
];

/** GET /api/v1/lane-report: the account's calls (or only this key's, as for statements and Activity) grouped by lane. */
export async function readLaneReport(ctx: Ctx, key: KeyRow, q: LaneReportQuery, now = new Date()) {
  const { whole } = await activityAccess(ctx, key); // the Activity, statement and proof pack scope rule, unchanged
  const from = q.from.toISOString(), to = q.toExclusive.toISOString();
  // The rows the proof pack lists as calls for the same key and range (src/proof-pack/read.ts), grouped.
  const result = await ctx.db.execute(sql`
    select coalesce(g.receipt->>'lane', g.receipt_v2->>'lane') lane, g.provider_id provider, g.model_id model, count(*)::int calls, coalesce(sum(g.cost), 0)::text pico
    from generations g left join keys k on k.key_hash = g.key_hash
    where ((k.account_id = ${key.accountId} and (${whole} or k.key_hash = ${key.keyHash})) or (${whole} and g.account_id = ${key.accountId}))
      and (g.account_id is null or g.account_id = ${key.accountId})
      and g.ts >= ${from}::timestamptz and g.ts < ${to}::timestamptz
    group by 1, 2, 3`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as { lane: string | null; provider: string; model: string; calls: number; pico: string }[];
  const summary = summarizeLanes(rows.map((r) => ({ lane: r.lane, provider: r.provider, model: r.model, calls: Number(r.calls), pico: BigInt(r.pico) })));
  return {
    type: LANE_REPORT_TYPE, generated_at: now.toISOString(),
    range: { from: q.fromDay, to: q.toDay, from_ts: from, to_exclusive: to, days: q.days, so_far: q.toExclusive > now, time_zone: "UTC" },
    scope: whole ? "account" : "key", key_hash: whole ? null : key.keyHash,
    ...summary,
    proof_time_url: PROOF_TIME_URL,
    not_recorded: NOT_RECORDED,
    limits: LIMITS,
  };
}
