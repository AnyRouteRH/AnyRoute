import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { and, desc, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { health, statusDpHours, statusIncidents, statusWindows } from "../db/schema.ts";
import { LATENCY_EDGES_MS, bucketLabels, bucketOf } from "../lib/dpstats.ts";
import { log } from "../lib/util.ts";
import { viaOnion } from "../api/common.ts";
import { batchLineOf } from "../router/batch-line.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { PRIVATE_LANES, isPrivateLaneRequest, privateLaneStats } from "./private-stats.ts";

// The public status page: availability, latency and error budgets per privacy lane and per API surface.
//
// Where each number comes from, and nothing else:
//   public lane   the outcome (status class) and latency of each public-lane request, summed per surface into five-minute
//                 buckets (status_windows). No key, account, model or address is kept, and no row is per request.
//   attested,     only the differentially private hourly releases (lib/dpstats.ts, the same counters GET /api/v1/stats
//   unlinkable    publishes), copied as released into status_dp_hours. A private-lane request never reaches status_windows:
//                 the middleware below drops it, and every figure for these lanes says `source: "dp-noised"`.
// The two private lanes share one set of noisy counters (requests are counted per lane, refusals and latency are not), so
// their availability and latency are one combined figure, shown on both lanes, and they have no per-surface breakdown.

export const LANES = ["public", ...PRIVATE_LANES] as const;
export type Lane = (typeof LANES)[number];
export const SURFACES = ["chat", "embeddings", "batch", "messages", "ollama", "rerank"] as const;
export type Surface = (typeof SURFACES)[number];
export const WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
export type WindowName = keyof typeof WINDOWS;
export const BUCKET_MS = 5 * 60_000;
export const STRIP_DAYS = 90;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Below this many noisy eligible requests a private-lane share is not published: the noise would be the figure. */
export const DP_MIN_ELIGIBLE = 50;
/** Refusals that are the caller's doing, not the router's: they do not count for or against availability. */
const CLIENT_REASONS = ["unauthorized", "payment_required", "forbidden", "invalid_request"] as const;
const SERVER_REASONS = ["upstream_error", "no_provider"] as const;
export const LATENCY_LABELS = bucketLabels(LATENCY_EDGES_MS);

// ---- pure SLO math -------------------------------------------------------------------------------------------------

/** The API surface a request belongs to, or null when the status page does not count it. */
export function surfaceOf(method: string, path: string): Surface | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (method === "OPTIONS" || method === "HEAD") return null;
  if (method === "POST" && /^\/(api\/)?v1\/(chat\/completions|completions|responses)$/.test(p)) return "chat";
  if (method === "POST" && /^\/(api\/)?v1\/embeddings$/.test(p)) return "embeddings";
  if (/^\/(api\/)?v1\/batches(\/|$)/.test(p)) return "batch";
  if (method === "POST" && /^\/(api\/)?v1\/messages$/.test(p)) return "messages";
  if (method === "POST" && /^\/ollama\/api\/(chat|generate|embed|embeddings)$/.test(p)) return "ollama";
  if (method === "POST" && /^\/(api\/)?v1\/rerank$/.test(p)) return "rerank";
  return null;
}

export type Outcome = "ok" | "failed" | "rejected" | "rate_limited";
/** 5xx is the router's failure; 429 and other 4xx are not held against availability. */
export function outcomeOf(status: number): Outcome {
  if (status >= 500) return "failed";
  if (status === 429) return "rate_limited";
  if (status >= 400) return "rejected";
  return "ok";
}

/** Share of eligible requests that succeeded, or null when none were eligible. */
export function availability(ok: number, failed: number): number | null {
  const n = ok + failed;
  return n > 0 ? Math.min(1, Math.max(0, ok / n)) : null;
}

/** The error budget of a window: how many failures the target allows, how many happened, and the share still unspent. */
export function errorBudget(target: number, eligible: number, failed: number) {
  const allowed = Math.max(0, (1 - target) * eligible);
  const remaining = eligible <= 0 ? null : allowed > 0 ? Math.max(0, 1 - failed / allowed) : failed > 0 ? 0 : 1;
  return { target, window: "30d" as const, eligible: round(eligible, 0), allowed_failures: round(allowed, 1), failures: round(failed, 0), remaining: remaining == null ? null : round(remaining, 4), exhausted: eligible > 0 && failed > allowed };
}

/**
 * A percentile read from a histogram with the fixed latency edges: the upper edge of the bucket the percentile falls in,
 * so the true value is at or under it. Null without data, or when it falls in the open last bucket.
 */
export function histogramPercentile(counts: readonly number[], p: number): number | null {
  const total = counts.reduce((s, x) => s + Math.max(0, x), 0);
  if (total <= 0) return null;
  const want = (p / 100) * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += Math.max(0, counts[i] ?? 0);
    if (seen >= want - 1e-9) return i < LATENCY_EDGES_MS.length ? LATENCY_EDGES_MS[i] : null;
  }
  return null;
}

/** The current state of a lane or surface from its last hour, made worse (never better) by an open incident. */
export function stateOf(avail1h: number | null, target: number, incidentImpact?: string | null): "operational" | "degraded" | "outage" | "no_data" {
  const rank = { no_data: 0, operational: 1, degraded: 2, outage: 3 } as const;
  let s: keyof typeof rank = avail1h == null ? "no_data" : avail1h >= target ? "operational" : avail1h >= 0.9 ? "degraded" : "outage";
  const fromIncident = incidentImpact === "critical" ? "outage" : incidentImpact === "major" || incidentImpact === "minor" ? "degraded" : null;
  if (fromIncident && rank[fromIncident] > rank[s]) s = fromIncident;
  return s;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const addInto = (a: number[], b: readonly number[]) => {
  for (let i = 0; i < LATENCY_LABELS.length; i++) a[i] = (a[i] ?? 0) + Math.max(0, Number(b[i] ?? 0));
  return a;
};
const zeros = () => LATENCY_LABELS.map(() => 0);

// ---- public-lane recorder --------------------------------------------------------------------------------------------

type Cell = { ok: number; failed: number; rejected: number; rateLimited: number; latency: number[] };

/** Public-lane outcomes of this process, summed per surface and five-minute bucket until they are flushed. */
export class SloRecorder {
  private cells = new Map<string, Cell>();

  record(surface: Surface, status: number, latencyMs: number, at = Date.now()) {
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    const key = `${surface}|${bucket}`;
    const cell = this.cells.get(key) ?? { ok: 0, failed: 0, rejected: 0, rateLimited: 0, latency: zeros() };
    const o = outcomeOf(status);
    if (o === "ok") {
      cell.ok++;
      cell.latency[LATENCY_LABELS.indexOf(bucketOf(LATENCY_EDGES_MS, latencyMs))]++;
    } else if (o === "failed") cell.failed++;
    else if (o === "rejected") cell.rejected++;
    else cell.rateLimited++;
    this.cells.set(key, cell);
  }

  get size() {
    return this.cells.size;
  }

  /** Add the buffered counts to status_windows (summed with other processes' counts for the same bucket). */
  async flush(db: Ctx["db"]) {
    if (!this.cells.size) return 0;
    const batch = [...this.cells.entries()];
    this.cells.clear();
    const rows = batch.map(([key, c]) => {
      const [surface, bucket] = key.split("|");
      return { surface, bucket: new Date(Number(bucket)), ok: c.ok, failed: c.failed, rejected: c.rejected, rateLimited: c.rateLimited, latency: c.latency };
    });
    try {
      await db
        .insert(statusWindows)
        .values(rows)
        .onConflictDoUpdate({
          target: [statusWindows.surface, statusWindows.bucket],
          set: {
            ok: sql.raw(`"status_windows"."ok" + excluded."ok"`),
            failed: sql.raw(`"status_windows"."failed" + excluded."failed"`),
            rejected: sql.raw(`"status_windows"."rejected" + excluded."rejected"`),
            rateLimited: sql.raw(`"status_windows"."rate_limited" + excluded."rate_limited"`),
            latency: sql.raw(`ARRAY(SELECT coalesce(a, 0) + coalesce(b, 0) FROM unnest("status_windows"."latency", excluded."latency") WITH ORDINALITY AS t(a, b, i) ORDER BY i)`),
          },
        });
    } catch (err) {
      // Put the counts back so the next flush retries them.
      for (const [key, c] of batch) {
        const cur = this.cells.get(key);
        if (!cur) this.cells.set(key, c);
        else {
          cur.ok += c.ok;
          cur.failed += c.failed;
          cur.rejected += c.rejected;
          cur.rateLimited += c.rateLimited;
          addInto(cur.latency, c.latency);
        }
      }
      throw err;
    }
    return rows.length;
  }
}

const recorders = new WeakMap<Ctx, SloRecorder>();
export function sloRecorder(ctx: Ctx): SloRecorder {
  let r = recorders.get(ctx);
  if (!r) recorders.set(ctx, (r = new SloRecorder()));
  return r;
}

// An in-process call made while serving a counted request (messages and ollama call the chat handler, responses too)
// belongs to the outer request: it is not counted again, but it reports whether the request turned out to be private.
const scope = new AsyncLocalStorage<{ private: boolean }>();

const privateByHeader = (c: Context) => {
  const lane = c.req.header("x-anyroute-lane")?.trim().toLowerCase();
  return !!lane && lane !== "public";
};

/** Refusals that only a request for a private lane can get. */
const PRIVATE_LANE_ERROR = /^(no_attested_endpoint|lane_[a-z_]+|unlinkable_[a-z_]+)$/;

/** Whether the response shows the request was on a private lane: the served lane header, or a private-lane refusal. */
async function privateByResponse(res: Response) {
  const lane = res.headers.get("x-anyroute-lane")?.toLowerCase();
  if (lane && lane !== "public") return true;
  if (res.status < 400 || !res.headers.get("content-type")?.includes("json")) return false;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { type?: unknown } } | null;
  return typeof body?.error?.type === "string" && PRIVATE_LANE_ERROR.test(body.error.type);
}

/** Count each public-lane request on a status surface. Private-lane requests are dropped here: they have DP counters only. */
export function statusMiddleware(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    const outer = scope.getStore();
    if (outer) {
      await next();
      if (isPrivateLaneRequest(c.req.raw) || privateByHeader(c) || (await privateByResponse(c.res))) outer.private = true;
      return;
    }
    let surface = surfaceOf(c.req.method, new URL(c.req.url).pathname);
    if (!surface) return next();
    if (batchLineOf(c)) surface = "batch";
    // Onion and Oblivious HTTP arrivals are treated as private from the start, whatever lane they end up on.
    const state = { private: privateByHeader(c) || viaOnion(c, ctx.cfg) || !!gatewayOrigin(c.req.raw) };
    const t0 = performance.now();
    await scope.run(state, () => next());
    if (state.private || isPrivateLaneRequest(c.req.raw) || (await privateByResponse(c.res))) return;
    // Handlers return a stream only after its first content chunk (router/execute.ts), so for a stream this is time to first token.
    sloRecorder(ctx).record(surface, c.res.status, performance.now() - t0);
  };
}

// ---- private lanes: DP releases only ---------------------------------------------------------------------------------

const instanceId = `p${randomBytes(6).toString("hex")}`;
const persisted = new WeakMap<Ctx, Set<string>>();

/** Copy the private-lane counters' released hours into status_dp_hours. Withheld hours have no values and are skipped. */
export async function persistDpHours(ctx: Ctx) {
  const doc = privateLaneStats(ctx).document();
  const done = persisted.get(ctx) ?? new Set<string>();
  persisted.set(ctx, done);
  const rows = doc.hours
    .filter((h) => h.status === "released" && h.counts && !done.has(h.hour))
    .map((h) => ({ instance: instanceId, hour: new Date(h.hour), epsilon: h.epsilon, counts: { requests: h.counts!.requests, blocked: h.counts!.blocked, latency: h.counts!.latency } }));
  if (!rows.length) return 0;
  await ctx.db.insert(statusDpHours).values(rows).onConflictDoNothing();
  for (const r of rows) done.add(r.hour.toISOString().replace(".000Z", "Z"));
  return rows.length;
}

type DpCounts = { requests: Record<string, number>; blocked: Record<string, number>; latency: Record<string, number> };
type DpSum = { hours: number; requests: Record<string, number>; eligible: number; failed: number; clientRefused: number; rateLimited: number; latency: number[] };

function emptyDp(): DpSum {
  return { hours: 0, requests: {}, eligible: 0, failed: 0, clientRefused: 0, rateLimited: 0, latency: zeros() };
}

/** Sum released noisy hours (post-processing). Eligible = requests minus refusals that were the caller's doing. */
export function sumDp(hours: DpCounts[]): DpSum {
  const s = emptyDp();
  for (const h of hours) {
    s.hours++;
    let requests = 0;
    for (const [k, v] of Object.entries(h.requests ?? {})) {
      s.requests[k] = (s.requests[k] ?? 0) + v;
      requests += v;
    }
    const b = h.blocked ?? {};
    const client = CLIENT_REASONS.reduce((a, r) => a + (b[r] ?? 0), 0);
    s.clientRefused += client;
    s.rateLimited += b.rate_limited ?? 0;
    s.failed += SERVER_REASONS.reduce((a, r) => a + (b[r] ?? 0), 0);
    s.eligible += requests - client - (b.rate_limited ?? 0);
    addInto(s.latency, LATENCY_LABELS.map((l) => h.latency?.[l] ?? 0));
  }
  s.eligible = Math.max(0, s.eligible);
  return s;
}

/** A private-lane share from noisy sums: published only with enough eligible requests, clamped to [0, 1]. */
export function dpAvailability(s: Pick<DpSum, "eligible" | "failed">, min = DP_MIN_ELIGIBLE): number | null {
  if (s.eligible < min) return null;
  return Math.min(1, Math.max(0, 1 - s.failed / s.eligible));
}

// ---- incidents -------------------------------------------------------------------------------------------------------

export const INCIDENT_STATUSES = ["suggested", "investigating", "identified", "monitoring", "resolved", "dismissed"] as const;
export const ACTIVE_STATUSES = ["investigating", "identified", "monitoring"] as const;
export const IMPACTS = ["none", "minor", "major", "critical"] as const;
export type IncidentRow = typeof statusIncidents.$inferSelect;
export type IncidentUpdate = { at: string; status: string; text: string };

/** The public view of an incident. Suggestions and dismissed suggestions are never public. */
export function incidentJson(r: IncidentRow) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    impact: r.impact,
    lanes: r.lanes as string[],
    surfaces: r.surfaces as string[],
    source: r.source,
    started_at: r.startedAt.toISOString(),
    resolved_at: r.resolvedAt?.toISOString() ?? null,
    updated_at: r.updatedAt.toISOString(),
    updates: [...((r.updates as IncidentUpdate[]) ?? [])].reverse(),
    ...(r.evidence ? { evidence: r.evidence } : {}),
  };
}

export const isPublicIncident = (r: Pick<IncidentRow, "status">) => r.status !== "suggested" && r.status !== "dismissed";

export async function publicIncidents(ctx: Ctx, limit = 50, sinceDays = STRIP_DAYS) {
  const since = new Date(Date.now() - sinceDays * DAY_MS);
  return ctx.db
    .select()
    .from(statusIncidents)
    .where(and(notInArray(statusIncidents.status, ["suggested", "dismissed"]), gte(statusIncidents.startedAt, since)))
    .orderBy(desc(statusIncidents.startedAt))
    .limit(limit);
}

type Suggestion = { lanes: Lane[]; surfaces: Surface[]; window: string; availability: number; target: number; requests: number; source: "request-aggregates" | "dp-noised"; from: Date };

/**
 * Record an incident suggestion when a lane (or one of its surfaces) was below its target over the last complete
 * five-minute bucket (public lane) or the last released hour (private lanes: the noisy counters are hourly). A suggestion
 * is not public until an operator confirms it, and none is made for a lane that already has an open incident or suggestion.
 */
export async function suggestIncidents(ctx: Ctx, now = Date.now()) {
  const min = ctx.cfg.status.suggestMinRequests;
  const found: Suggestion[] = [];
  const from = new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS - BUCKET_MS);
  const rows = await ctx.db.select().from(statusWindows).where(and(gte(statusWindows.bucket, from), lt(statusWindows.bucket, new Date(from.getTime() + BUCKET_MS))));
  const target = ctx.cfg.status.targets.public;
  let ok = 0;
  let failed = 0;
  const dipped: Surface[] = [];
  for (const r of rows) {
    ok += r.ok;
    failed += r.failed;
    const a = availability(r.ok, r.failed);
    if (r.ok + r.failed >= min && a != null && a < target) dipped.push(r.surface as Surface);
  }
  const lane = availability(ok, failed);
  if ((ok + failed >= min && lane != null && lane < target) || dipped.length)
    found.push({ lanes: ["public"], surfaces: dipped.sort(), window: "5m", availability: round(lane ?? 0, 4), target, requests: ok + failed, source: "request-aggregates", from });

  const hourStart = new Date(Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS);
  const dp = await ctx.db.select({ counts: statusDpHours.counts }).from(statusDpHours).where(and(gte(statusDpHours.hour, hourStart), lt(statusDpHours.hour, new Date(hourStart.getTime() + HOUR_MS))));
  if (dp.length) {
    const s = sumDp(dp.map((d) => d.counts as DpCounts));
    const a = dpAvailability(s, Math.max(min, DP_MIN_ELIGIBLE));
    const t = Math.min(ctx.cfg.status.targets.attested, ctx.cfg.status.targets.unlinkable);
    if (a != null && a < t) found.push({ lanes: [...PRIVATE_LANES], surfaces: [], window: "1h", availability: round(a, 4), target: t, requests: Math.round(s.eligible), source: "dp-noised", from: hourStart });
  }
  if (!found.length) return [];

  const open = await ctx.db.select({ lanes: statusIncidents.lanes }).from(statusIncidents).where(inArray(statusIncidents.status, ["suggested", ...ACTIVE_STATUSES]));
  const busy = new Set(open.flatMap((o) => o.lanes as string[]));
  const made: string[] = [];
  for (const f of found) {
    if (f.lanes.some((l) => busy.has(l))) continue;
    const id = `sug_${f.lanes[0] === "public" ? "public" : "private"}_${f.from.toISOString().replace(/[-:]|\.\d+Z$/g, "")}`;
    const pct = (x: number) => `${round(x * 100, 2)}%`;
    const text = `Automatic suggestion: ${f.lanes.join(" and ")} ${f.surfaces.length ? `(${f.surfaces.join(", ")}) ` : ""}availability was ${pct(f.availability)} over ${f.window === "5m" ? "five minutes" : "one hour"}, below the ${pct(f.target)} target.`;
    const at = new Date(now).toISOString();
    const inserted = await ctx.db
      .insert(statusIncidents)
      .values({
        id,
        title: `${f.lanes[0] === "public" ? "Public lane" : "Private lanes"} availability below target`,
        status: "suggested",
        impact: "minor",
        lanes: f.lanes,
        surfaces: f.surfaces,
        source: "auto",
        updates: [{ at, status: "suggested", text }],
        evidence: { lanes: f.lanes, surfaces: f.surfaces, window: f.window, from: f.from.toISOString(), availability: f.availability, target: f.target, requests: f.requests, source: f.source },
        startedAt: f.from,
      })
      .onConflictDoNothing()
      .returning({ id: statusIncidents.id });
    if (inserted.length) made.push(id);
    for (const l of f.lanes) busy.add(l);
  }
  return made;
}

// ---- the SLO document ------------------------------------------------------------------------------------------------

type WindowCounts = { ok: number; failed: number; rejected: number; rate_limited: number };

async function publicRows(ctx: Ctx, now: number) {
  const since = new Date(now - STRIP_DAYS * DAY_MS);
  const agg = await ctx.db.execute(sql`
    SELECT surface,
      ${sql.join(
        (Object.keys(WINDOWS) as WindowName[]).map(
          (w) => sql`
        coalesce(sum(ok) FILTER (WHERE bucket >= ${new Date(now - WINDOWS[w]).toISOString()}::timestamptz), 0) AS ${sql.raw(`"ok_${w}"`)},
        coalesce(sum(failed) FILTER (WHERE bucket >= ${new Date(now - WINDOWS[w]).toISOString()}::timestamptz), 0) AS ${sql.raw(`"failed_${w}"`)},
        coalesce(sum(rejected) FILTER (WHERE bucket >= ${new Date(now - WINDOWS[w]).toISOString()}::timestamptz), 0) AS ${sql.raw(`"rejected_${w}"`)},
        coalesce(sum(rate_limited) FILTER (WHERE bucket >= ${new Date(now - WINDOWS[w]).toISOString()}::timestamptz), 0) AS ${sql.raw(`"rl_${w}"`)}`,
        ),
        sql`,`,
      )}
    FROM status_windows WHERE bucket >= ${new Date(now - WINDOWS["30d"]).toISOString()}::timestamptz GROUP BY surface`);
  const days = await ctx.db.execute(sql`
    SELECT to_char(date_trunc('day', bucket AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, sum(ok) AS ok, sum(failed) AS failed
    FROM status_windows WHERE bucket >= ${since.toISOString()}::timestamptz GROUP BY 1`);
  const lat = await ctx.db.select({ surface: statusWindows.surface, latency: statusWindows.latency }).from(statusWindows).where(gte(statusWindows.bucket, new Date(now - WINDOWS["24h"])));
  const rowsOf = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? r) as Record<string, string | number>[];
  const bySurface = new Map<string, Record<WindowName, WindowCounts>>();
  for (const r of rowsOf(agg)) {
    const w = {} as Record<WindowName, WindowCounts>;
    for (const name of Object.keys(WINDOWS) as WindowName[]) w[name] = { ok: Number(r[`ok_${name}`]), failed: Number(r[`failed_${name}`]), rejected: Number(r[`rejected_${name}`]), rate_limited: Number(r[`rl_${name}`]) };
    bySurface.set(String(r.surface), w);
  }
  const latency = new Map<string, number[]>();
  for (const r of lat) latency.set(r.surface, addInto(latency.get(r.surface) ?? zeros(), r.latency));
  const daily = new Map(rowsOf(days).map((r) => [String(r.day), { ok: Number(r.ok), failed: Number(r.failed) }]));
  return { bySurface, latency, daily };
}

async function dpRows(ctx: Ctx, now: number) {
  const rows = await ctx.db.select({ hour: statusDpHours.hour, counts: statusDpHours.counts }).from(statusDpHours).where(gte(statusDpHours.hour, new Date(now - STRIP_DAYS * DAY_MS)));
  return rows.map((r) => ({ at: r.hour.getTime(), counts: r.counts as DpCounts }));
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const stripDays = (now: number) => Array.from({ length: STRIP_DAYS }, (_, i) => dayKey(now - (STRIP_DAYS - 1 - i) * DAY_MS));

const windowView = (c: WindowCounts) => ({
  availability: availability(c.ok, c.failed) == null ? null : round(availability(c.ok, c.failed)!, 5),
  eligible: c.ok + c.failed,
  errors: { ok: c.ok, server_error: c.failed, client_error: c.rejected, rate_limited: c.rate_limited, server_error_rate: c.ok + c.failed ? round(c.failed / (c.ok + c.failed), 5) : null },
});

const sumCounts = (list: WindowCounts[]): WindowCounts => list.reduce((a, b) => ({ ok: a.ok + b.ok, failed: a.failed + b.failed, rejected: a.rejected + b.rejected, rate_limited: a.rate_limited + b.rate_limited }), { ok: 0, failed: 0, rejected: 0, rate_limited: 0 });

/** Surfaces this router serves: rerank and the rest appear only when a route for them is registered. */
export function activeSurfaces(routes: { method: string; path: string }[]): Surface[] {
  const seen = new Set<Surface>();
  for (const r of routes) {
    const s = surfaceOf(r.method === "ALL" ? "POST" : r.method, r.path.replace(/\/:[^/]+.*$/, ""));
    if (s) seen.add(s);
  }
  return SURFACES.filter((s) => seen.has(s));
}

export async function buildSlo(ctx: Ctx, surfaces: readonly Surface[] = SURFACES, now = Date.now()) {
  await sloRecorder(ctx).flush(ctx.db).catch((e) => log.warn("status flush failed", { error: (e as Error).message }));
  if (ctx.cfg.runtimeRole !== "worker") await persistDpHours(ctx).catch((e) => log.warn("status dp persist failed", { error: (e as Error).message }));
  const [pub, dp, open, recent, synthetic] = await Promise.all([
    publicRows(ctx, now),
    dpRows(ctx, now),
    ctx.db.select().from(statusIncidents).where(inArray(statusIncidents.status, [...ACTIVE_STATUSES])).orderBy(desc(statusIncidents.startedAt)),
    publicIncidents(ctx, 50),
    ctx.db
      .select({ ok: sql<number>`count(*) FILTER (WHERE ${health.ok})`, total: sql<number>`count(*)` })
      .from(health)
      .where(and(gte(health.ts, new Date(now - WINDOWS["24h"])), inArray(health.source, ["probe", "canary"]), sql`(${health.ok} OR ${health.errorKind} IS DISTINCT FROM 'rate_limited')`)),
  ]);
  const targets = ctx.cfg.status.targets;
  const worstImpact = (lane: string, surface?: string) => {
    const order = ["none", "minor", "major", "critical"];
    let worst: string | null = null;
    for (const i of open) {
      if (!(i.lanes as string[]).includes(lane)) continue;
      const s = i.surfaces as string[];
      if (surface && s.length && !s.includes(surface)) continue;
      if (worst == null || order.indexOf(i.impact) > order.indexOf(worst)) worst = i.impact;
    }
    return worst;
  };

  // Public lane: exact sums of public-lane requests.
  const pubWindows = {} as Record<WindowName, WindowCounts>;
  for (const w of Object.keys(WINDOWS) as WindowName[]) pubWindows[w] = sumCounts(surfaces.map((s) => pub.bySurface.get(s)?.[w] ?? { ok: 0, failed: 0, rejected: 0, rate_limited: 0 }));
  const pubLatency = surfaces.reduce((a, s) => addInto(a, pub.latency.get(s) ?? zeros()), zeros());
  const latencyView = (counts: number[], measure: string) => ({ p50_ms: histogramPercentile(counts, 50), p95_ms: histogramPercentile(counts, 95), samples: round(counts.reduce((a, b) => a + b, 0), 0), measure, basis: "upper edge of the latency bucket the percentile falls in (the value is at or under it); null when it falls above the last edge" });
  const PUBLIC_MEASURE = "time to first token for streams, time to the full response otherwise, measured at the router";
  const days = stripDays(now);
  const publicLane = {
    lane: "public" as const,
    source: "request-aggregates" as const,
    target: targets.public,
    state: stateOf(availability(pubWindows["1h"].ok, pubWindows["1h"].failed), targets.public, worstImpact("public")),
    windows: Object.fromEntries((Object.keys(WINDOWS) as WindowName[]).map((w) => [w, windowView(pubWindows[w])])),
    latency_24h: latencyView(pubLatency, PUBLIC_MEASURE),
    error_budget: errorBudget(targets.public, pubWindows["30d"].ok + pubWindows["30d"].failed, pubWindows["30d"].failed),
    daily: days.map((d) => {
      const c = pub.daily.get(d);
      const a = c ? availability(c.ok, c.failed) : null;
      return { day: d, availability: a == null ? null : round(a, 5), eligible: c ? c.ok + c.failed : 0 };
    }),
  };

  // Private lanes: noisy hourly releases only.
  const dpWindow = (w: WindowName) => sumDp(dp.filter((h) => h.at >= now - WINDOWS[w] - HOUR_MS && h.at + HOUR_MS <= now + 1).map((h) => h.counts));
  const dpW = Object.fromEntries((Object.keys(WINDOWS) as WindowName[]).map((w) => [w, dpWindow(w)])) as Record<WindowName, DpSum>;
  const dpDaily = new Map<string, DpCounts[]>();
  for (const h of dp) dpDaily.set(dayKey(h.at), [...(dpDaily.get(dayKey(h.at)) ?? []), h.counts]);
  const stats = privateLaneStats(ctx);
  const privateLane = (lane: (typeof PRIVATE_LANES)[number]) => {
    const target = targets[lane];
    return {
      lane,
      source: "dp-noised" as const,
      target,
      state: stateOf(dpAvailability(dpW["1h"]), target, worstImpact(lane)),
      scope: "attested+unlinkable",
      windows: Object.fromEntries(
        (Object.keys(WINDOWS) as WindowName[]).map((w) => {
          const s = dpW[w];
          const a = dpAvailability(s);
          return [
            w,
            {
              availability: a == null ? null : round(a, 5),
              eligible: round(s.eligible, 0),
              lane_requests: round(s.requests[lane] ?? 0, 0),
              hours: s.hours,
              errors: { server_error: round(s.failed, 0), client_error: round(s.clientRefused, 0), rate_limited: round(s.rateLimited, 0), server_error_rate: s.eligible >= DP_MIN_ELIGIBLE ? round(Math.min(1, s.failed / s.eligible), 5) : null },
            },
          ];
        }),
      ),
      latency_24h: latencyView(dpW["24h"].latency, "total generation time of served requests and time to refusal of refused ones (the only latency the noisy counters keep)"),
      error_budget: errorBudget(target, dpW["30d"].eligible, dpW["30d"].failed),
      daily: days.map((d) => {
        const s = sumDp(dpDaily.get(d) ?? []);
        const a = dpAvailability(s);
        return { day: d, availability: a == null ? null : round(a, 5), eligible: round(s.eligible, 0) };
      }),
      privacy: {
        mechanism: "laplace",
        unit: "request",
        epsilon_per_hour: stats.epsilon,
        scale_per_hour: 1 / stats.epsilon.requests,
        min_eligible: DP_MIN_ELIGIBLE,
        note: "Every figure for this lane is summed from the differentially private hourly releases published at /api/v1/stats, never from per-request records. The attested and unlinkable lanes share one set of noisy counters, so their availability and latency are one combined figure. A window with fewer than min_eligible noisy requests shows no share.",
      },
    };
  };

  const surfaceViews = surfaces.map((s) => {
    const w = pub.bySurface.get(s);
    const counts = (name: WindowName) => w?.[name] ?? { ok: 0, failed: 0, rejected: 0, rate_limited: 0 };
    return {
      surface: s,
      lane: "public" as const,
      source: "request-aggregates" as const,
      target: targets.public,
      state: stateOf(availability(counts("1h").ok, counts("1h").failed), targets.public, worstImpact("public", s)),
      windows: Object.fromEntries((Object.keys(WINDOWS) as WindowName[]).map((name) => [name, windowView(counts(name))])),
      latency_24h: latencyView(pub.latency.get(s) ?? zeros(), PUBLIC_MEASURE),
      error_budget: errorBudget(targets.public, counts("30d").ok + counts("30d").failed, counts("30d").failed),
    };
  });

  const syn = synthetic[0] ?? { ok: 0, total: 0 };
  return {
    object: "status.slo",
    generated_at: new Date(now).toISOString(),
    cache_seconds: 30,
    windows: Object.keys(WINDOWS),
    targets,
    lanes: [publicLane, privateLane("attested"), privateLane("unlinkable")],
    surfaces: surfaceViews,
    surfaces_note: "Per-surface figures cover the public lane only: the private lanes' noisy counters are not split by surface.",
    synthetic_24h: { source: "provider probes and canaries", ok: Number(syn.ok), total: Number(syn.total), availability: Number(syn.total) ? round(Number(syn.ok) / Number(syn.total), 5) : null },
    incidents: { open: open.map(incidentJson), recent: recent.map(incidentJson) },
  };
}

// ---- feeds -------------------------------------------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const LABEL: Record<string, string> = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
const entryText = (i: ReturnType<typeof incidentJson>) =>
  [`Status: ${LABEL[i.status] ?? i.status}. Impact: ${i.impact}. Lanes: ${i.lanes.join(", ")}${i.surfaces.length ? `. Surfaces: ${i.surfaces.join(", ")}` : ""}.`, ...i.updates.map((u) => `${u.at} ${LABEL[u.status] ?? u.status}: ${u.text}`)].join("\n");

export function atomFeed(base: string, incidents: ReturnType<typeof incidentJson>[], now = Date.now(), siteUrl = base) { // B116: keep feed API URLs on base
  const updated = incidents.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), new Date(now).toISOString());
  const page = `${siteUrl}/status/`;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Anyroute status: incidents</title>
  <id>${xml(`${base}/api/v1/status/incidents.atom`)}</id>
  <link rel="self" type="application/atom+xml" href="${xml(`${base}/api/v1/status/incidents.atom`)}"/>
  <link rel="alternate" type="text/html" href="${xml(page)}"/>
  <updated>${updated}</updated>
  <author><name>Anyroute</name></author>
${incidents
  .map(
    (i) => `  <entry>
    <id>${xml(`${base}/api/v1/status/incidents/${i.id}`)}</id>
    <title>${xml(`[${LABEL[i.status] ?? i.status}] ${i.title}`)}</title>
    <link rel="alternate" type="text/html" href="${xml(`${page}#incident-${i.id}`)}"/>
    <published>${i.started_at}</published>
    <updated>${i.updated_at}</updated>
    <content type="text">${xml(entryText(i))}</content>
  </entry>`,
  )
  .join("\n")}
</feed>
`;
}

export function rssFeed(base: string, incidents: ReturnType<typeof incidentJson>[], now = Date.now(), siteUrl = base) { // B116: keep feed API URLs on base
  const page = `${siteUrl}/status/`;
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Anyroute status: incidents</title>
    <link>${xml(page)}</link>
    <description>Incidents on the Anyroute router, per privacy lane and API surface.</description>
    <atom:link href="${xml(`${base}/api/v1/status/incidents.rss`)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>
${incidents
  .map(
    (i) => `    <item>
      <title>${xml(`[${LABEL[i.status] ?? i.status}] ${i.title}`)}</title>
      <link>${xml(`${page}#incident-${i.id}`)}</link>
      <guid isPermaLink="false">${xml(i.id)}</guid>
      <pubDate>${new Date(i.started_at).toUTCString()}</pubDate>
      <description>${xml(entryText(i))}</description>
    </item>`,
  )
  .join("\n")}
  </channel>
</rss>
`;
}

// ---- background loop ---------------------------------------------------------------------------------------------------

/** Every minute: flush this process's public-lane counts; on API processes also copy DP releases, suggest incidents and prune. */
export function startStatusLoop(ctx: Ctx, intervalMs = 60_000) {
  let lastPrune = 0;
  const tick = async () => {
    await sloRecorder(ctx).flush(ctx.db);
    if (ctx.cfg.runtimeRole === "worker") return;
    await persistDpHours(ctx);
    await suggestIncidents(ctx);
    if (Date.now() - lastPrune > HOUR_MS) {
      lastPrune = Date.now();
      await pruneStatus(ctx);
    }
  };
  const timer = setInterval(() => void tick().catch((e) => log.warn("status loop failed", { error: (e as Error).message })), intervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await sloRecorder(ctx).flush(ctx.db).catch(() => undefined);
  };
}

/** Keep the 90 days the page shows, and one more. Incidents are kept. */
export async function pruneStatus(ctx: Ctx, now = Date.now()) {
  const cutoff = new Date(now - (STRIP_DAYS + 1) * DAY_MS);
  await ctx.db.delete(statusWindows).where(lt(statusWindows.bucket, cutoff));
  await ctx.db.delete(statusDpHours).where(lt(statusDpHours.hour, cutoff));
}
