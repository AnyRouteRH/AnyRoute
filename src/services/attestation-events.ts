import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { attestationEvents, attestations, providers } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { currentMeasurement } from "./measurements.ts";
import {
  DAY_MS,
  WINDOWS,
  attestationStatus,
  cleanMeasurements,
  coverageIntervals,
  describeReason,
  encodeEventCursor,
  failureCode,
  measurementChange,
  probeErrorKind,
  publicEvent,
  windowCoverage,
  type EventCursor,
  type EventKind,
  type Measurements,
} from "./attestation-history.ts";

// The proof-time record: one row per attestor run, per canary run, and per change of a provider's health-probe outcome
// (a probe every 15 seconds would be noise; the change and the moment it happened are what matter). Recording never
// affects the checks themselves: a failure to write is logged and the run goes on. ATTESTATION_HISTORY_DAYS = 0 records
// nothing.

const enabled = (ctx: Ctx) => ctx.cfg.attestation.historyDays > 0;
const HEX64 = /^[0-9a-f]{64}$/i;

async function insertEvent(ctx: Ctx, row: typeof attestationEvents.$inferInsert) {
  await ctx.db.insert(attestationEvents).values({ ts: new Date(), ...row });
}

// ---- recording ----------------------------------------------------------------------------------------------------

export type AttestorResult = { provider: string; ok: boolean; reason?: string; hash?: string; tls_pin?: { spki_sha256?: string } };

/**
 * Record one attestor run, given what attestProvider returned. The digests come from what that run wrote: the
 * attestation row (TDX registers, verifiers, whether the evidence was simulated) and, with MEASUREMENTS_ENABLED, the
 * measurement row it refreshed (image, compose and model digests). A failed run keeps no digests: they came from
 * evidence that was not accepted.
 */
export async function recordAttestorRun(ctx: Ctx, p: typeof providers.$inferSelect, result: AttestorResult, startedAt: Date): Promise<void> {
  if (!enabled(ctx)) return;
  try {
    const [row] = await ctx.db.select().from(attestations).where(eq(attestations.providerId, p.id)).orderBy(desc(attestations.ts), desc(attestations.id)).limit(1);
    // The row this run wrote, not an older one (the attestor writes it before it returns).
    const mine = !!row && row.ok === result.ok && (!result.ok || row.reportHash === result.hash);
    const detail = (mine ? row.detail : null) as { verifiers?: unknown; simulated?: unknown } | null;
    if (!result.ok) {
      await insertEvent(ctx, { providerId: p.id, kind: "attestation", ok: false, reason: failureCode(result.reason), teeKind: p.teeKind });
      return;
    }
    const simulated = p.teeKind === "dev" || detail?.simulated === true;
    let measurements: Measurements | null = cleanMeasurements(mine ? row.measurements : null);
    if (!simulated && ctx.cfg.measurements.enabled) {
      const m = await currentMeasurement(ctx, p.id);
      if (m && m.lastSeenAt.getTime() >= startedAt.getTime()) measurements = { ...(measurements ?? {}), ...cleanMeasurements({ image_digest: m.imageDigest, compose_hash: m.composeHash, model_digest: m.modelDigest }) };
    }
    const [prev] = await ctx.db
      .select({ measurements: attestationEvents.measurements })
      .from(attestationEvents)
      .where(and(eq(attestationEvents.providerId, p.id), eq(attestationEvents.kind, "attestation"), eq(attestationEvents.ok, true), eq(attestationEvents.simulated, simulated), sql`${attestationEvents.measurements} is not null`))
      .orderBy(desc(attestationEvents.ts), desc(attestationEvents.id))
      .limit(1);
    const previous = cleanMeasurements(prev?.measurements);
    const changed = measurementChange(previous, measurements);
    const spki = result.tls_pin?.spki_sha256;
    await insertEvent(ctx, {
      providerId: p.id,
      kind: "attestation",
      ok: true,
      simulated,
      teeKind: (mine ? row.teeKind : null) ?? p.teeKind,
      attestationHash: result.hash ?? null,
      tlsSpkiSha256: typeof spki === "string" && HEX64.test(spki) ? spki.toLowerCase() : null,
      measurements,
      measurementChanged: changed.length > 0,
      verifiers: Array.isArray(detail?.verifiers) ? detail.verifiers.filter((v): v is string => typeof v === "string") : [],
      detail: changed.length ? { changed, previous } : null,
    });
  } catch (e) {
    log.warn("recording the attestation event failed", { provider: p.id, error: (e as Error).message });
  }
}

/** One canary run for a model at a provider. `quantMatch` null means the canary could not say. */
export async function recordCanaryEvent(ctx: Ctx, e: { providerId: string; modelId: string; declared: string; quantMatch: boolean | null; quality: number | null }): Promise<void> {
  if (!enabled(ctx)) return;
  try {
    const reason = e.quality == null ? "no_answer" : e.quantMatch === false ? "quantization_mismatch" : null;
    await insertEvent(ctx, {
      providerId: e.providerId,
      kind: "canary",
      ok: reason === null,
      reason,
      detail: { model: e.modelId, declared: e.declared, quant_match: e.quantMatch, quality: e.quality == null ? null : Math.round(e.quality * 100) / 100 },
    });
  } catch (err) {
    log.warn("recording the canary event failed", { provider: e.providerId, error: (err as Error).message });
  }
}

/** The providers whose last recorded probe outcome differs from `results` (or who have none), as events to record. */
export function probeChanges(last: Map<string, boolean>, results: { provider: string; ok: boolean; status: number | null }[]) {
  return results.filter((r) => last.get(r.provider) !== r.ok);
}

/** Record a probe outcome only when it differs from the provider's last recorded one. */
export async function recordProbeChanges(ctx: Ctx, results: { provider: string; ok: boolean; status: number | null }[]): Promise<void> {
  if (!enabled(ctx) || !results.length) return;
  try {
    const ids = results.map((r) => r.provider);
    const rows = await ctx.db
      .selectDistinctOn([attestationEvents.providerId], { providerId: attestationEvents.providerId, ok: attestationEvents.ok })
      .from(attestationEvents)
      .where(and(eq(attestationEvents.kind, "probe"), inArray(attestationEvents.providerId, ids)))
      .orderBy(attestationEvents.providerId, desc(attestationEvents.ts), desc(attestationEvents.id));
    const changed = probeChanges(new Map(rows.map((r) => [r.providerId, r.ok])), results);
    if (!changed.length) return;
    await ctx.db.insert(attestationEvents).values(
      changed.map((r) => ({ providerId: r.provider, kind: "probe", ts: new Date(), ok: r.ok, reason: probeErrorKind(r.ok, r.status), detail: r.status == null ? null : { status: r.status } })),
    );
  } catch (e) {
    log.warn("recording the probe events failed", { error: (e as Error).message });
  }
}

/** Delete events older than the retention. Returns how many went. A no-op when history is off. */
export async function pruneAttestationEvents(ctx: Ctx, now = Date.now()): Promise<number> {
  const days = ctx.cfg.attestation.historyDays;
  if (days <= 0) return 0;
  const gone = await ctx.db.delete(attestationEvents).where(lt(attestationEvents.ts, new Date(now - days * DAY_MS))).returning({ id: attestationEvents.id });
  return gone.length;
}

// ---- history ------------------------------------------------------------------------------------------------------

// Keyset order (ts desc, id desc) at millisecond precision: Postgres keeps microseconds but the cursor carries a JS
// Date, so the order and the comparison use the same truncated value and events at one instant break on id.
const at = sql`date_trunc('milliseconds', ${attestationEvents.ts})`;

export async function listHistory(ctx: Ctx, providerId: string, opts: { limit: number; before?: EventCursor; kind?: EventKind; ok?: boolean }) {
  const bt = opts.before && sql`${opts.before.at.toISOString()}::timestamptz`; // an ISO string: drivers differ on how they bind a raw Date inside sql``
  const conds: (SQL | undefined)[] = [eq(attestationEvents.providerId, providerId)];
  if (opts.kind) conds.push(eq(attestationEvents.kind, opts.kind));
  if (opts.ok !== undefined) conds.push(eq(attestationEvents.ok, opts.ok));
  if (opts.before) conds.push(or(sql`${at} < ${bt}`, and(sql`${at} = ${bt}`, lt(attestationEvents.id, opts.before.id))));
  const rows = await ctx.db
    .select()
    .from(attestationEvents)
    .where(and(...conds))
    .orderBy(desc(at), desc(attestationEvents.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { data: page.map(publicEvent), next: rows.length > opts.limit ? encodeEventCursor(last.ts, last.id) : null };
}

// ---- summary ------------------------------------------------------------------------------------------------------

const newestPer = <T extends { providerId: string }>(rows: T[]) => new Map(rows.map((r) => [r.providerId, r]));

/** Per attestable provider: current status, coverage of the last 24 hours and 7 days, and what changed or failed. */
export async function buildSummary(ctx: Ctx, now = Date.now()) {
  const intervalMs = ctx.cfg.attestation.intervalMs;
  const freshnessMs = intervalMs * 3;
  const rows = await ctx.db.select().from(providers).where(and(inArray(providers.status, ["shadow", "live"]), sql`${providers.attestationUrl} is not null`, sql`${providers.teeKind} is not null`)).orderBy(asc(providers.id));
  const ids = rows.map((p) => p.id);
  const base = { generated_at: new Date(now).toISOString(), attestation_interval_ms: intervalMs, fresh_within_ms: freshnessMs, history_days: ctx.cfg.attestation.historyDays };
  if (!ids.length) return { ...base, providers: [] };

  const week = new Date(now - WINDOWS["7d"].ms - freshnessMs);
  const A = attestationEvents;
  const mine = (...more: (SQL | undefined)[]) => and(inArray(A.providerId, ids), ...more);
  const [events, first, lastFail, lastChange, latestOk, latestRun, probe, canary] = await Promise.all([
    ctx.db
      .select({ providerId: A.providerId, ts: A.ts, ok: A.ok, simulated: A.simulated, changed: A.measurementChanged, detail: A.detail })
      .from(A)
      .where(mine(eq(A.kind, "attestation"), gte(A.ts, week)))
      .orderBy(asc(A.ts), asc(A.id)),
    ctx.db.selectDistinctOn([A.providerId], { providerId: A.providerId, ts: A.ts }).from(A).where(mine(eq(A.kind, "attestation"))).orderBy(A.providerId, asc(A.ts), asc(A.id)),
    ctx.db.selectDistinctOn([A.providerId], { providerId: A.providerId, ts: A.ts, reason: A.reason }).from(A).where(mine(eq(A.kind, "attestation"), eq(A.ok, false))).orderBy(A.providerId, desc(A.ts), desc(A.id)),
    ctx.db.selectDistinctOn([A.providerId], { providerId: A.providerId, ts: A.ts, detail: A.detail, measurements: A.measurements }).from(A).where(mine(eq(A.kind, "attestation"), eq(A.measurementChanged, true))).orderBy(A.providerId, desc(A.ts), desc(A.id)),
    ctx.db.selectDistinctOn([A.providerId], { providerId: A.providerId, measurements: A.measurements }).from(A).where(mine(eq(A.kind, "attestation"), eq(A.ok, true), eq(A.simulated, false), sql`${A.measurements} is not null`)).orderBy(A.providerId, desc(A.ts), desc(A.id)),
    ctx.db.selectDistinctOn([attestations.providerId], { providerId: attestations.providerId, ok: attestations.ok, detail: attestations.detail }).from(attestations).where(inArray(attestations.providerId, ids)).orderBy(attestations.providerId, desc(attestations.ts), desc(attestations.id)),
    ctx.db.selectDistinctOn([A.providerId], { providerId: A.providerId, ts: A.ts, ok: A.ok, reason: A.reason }).from(A).where(mine(eq(A.kind, "probe"))).orderBy(A.providerId, desc(A.ts), desc(A.id)),
    ctx.db.selectDistinctOn([A.providerId], { providerId: A.providerId, ts: A.ts, ok: A.ok, reason: A.reason, detail: A.detail }).from(A).where(mine(eq(A.kind, "canary"))).orderBy(A.providerId, desc(A.ts), desc(A.id)),
  ]);

  const byProvider = new Map<string, typeof events>();
  for (const e of events) byProvider.set(e.providerId, [...(byProvider.get(e.providerId) ?? []), e]);
  const firstBy = newestPer(first);
  const failBy = newestPer(lastFail);
  const changeBy = newestPer(lastChange);
  const okBy = newestPer(latestOk);
  const runBy = newestPer(latestRun);
  const probeBy = newestPer(probe);
  const canaryBy = newestPer(canary);

  return {
    ...base,
    providers: rows.map((p) => {
      const evs = byProvider.get(p.id) ?? [];
      const intervals = coverageIntervals(evs.map((e) => ({ at: e.ts.getTime(), ok: e.ok, simulated: e.simulated })), freshnessMs);
      const firstAt = firstBy.get(p.id)?.ts.getTime() ?? null;
      const windows = Object.fromEntries(
        (Object.keys(WINDOWS) as (keyof typeof WINDOWS)[]).map((name) => {
          const c = windowCoverage(intervals, now, WINDOWS[name].ms, WINDOWS[name].buckets, firstAt);
          return [name, { share: c.share, observed_ms: c.observedMs, observed_from: c.observedFrom == null ? null : new Date(c.observedFrom).toISOString(), history_complete: c.complete, buckets: c.buckets }];
        }),
      );
      const inWeek = evs.filter((e) => e.ts.getTime() >= now - WINDOWS["7d"].ms);
      const attested = inWeek.filter((e) => e.ok && !e.simulated).length;
      const st = attestationStatus(p, runBy.get(p.id), { intervalMs, production: ctx.cfg.production, now });
      const fail = failBy.get(p.id);
      const change = changeBy.get(p.id);
      const changeDetail = (change?.detail ?? null) as { changed?: string[]; previous?: unknown } | null;
      const pr = probeBy.get(p.id);
      const ca = canaryBy.get(p.id);
      return {
        provider: p.id,
        name: p.name,
        status: st.status,
        ...(st.reason ? { reason: st.reason } : {}),
        tee: st.status === "simulated" ? "dev" : p.teeKind,
        attested_at: st.status === "attested" || st.status === "simulated" ? p.attestedAt?.toISOString() ?? null : null,
        history_since: firstAt == null ? null : new Date(firstAt).toISOString(),
        runs_7d: { total: inWeek.length, attested, attested_pct: inWeek.length ? Math.round((1000 * attested) / inWeek.length) / 10 : null },
        fresh: windows,
        measurement: okBy.has(p.id) ? { digests: cleanMeasurements(okBy.get(p.id)!.measurements) } : null,
        measurement_changes_7d: inWeek.filter((e) => e.changed).slice(-50).map((e) => ({ at: e.ts.toISOString(), changed: ((e.detail ?? {}) as { changed?: string[] }).changed ?? [] })),
        last_measurement_change: change
          ? { at: change.ts.toISOString(), changed: changeDetail?.changed ?? [], from: cleanMeasurements(changeDetail?.previous), to: cleanMeasurements(change.measurements) }
          : null,
        last_failure: fail ? { at: fail.ts.toISOString(), ...describeReason(fail.reason ?? "other")! } : null,
        probe: pr ? { ok: pr.ok, since: pr.ts.toISOString(), ...(pr.ok ? {} : { reason: describeReason(pr.reason) }) } : null,
        canary: ca ? { ok: ca.ok, at: ca.ts.toISOString(), model: (ca.detail as { model?: string } | null)?.model ?? null, ...(ca.ok ? {} : { reason: describeReason(ca.reason) }) } : null,
      };
    }),
  };
}
