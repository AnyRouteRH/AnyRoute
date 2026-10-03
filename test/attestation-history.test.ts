import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { attestationEvents, attestations, measurements, providers } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runCanaries } from "../src/services/canaries.ts";
import { runProbes } from "../src/services/probes.ts";
import {
  DAY_MS,
  REASON_MESSAGES,
  WINDOWS,
  attestationStatus,
  cleanMeasurements,
  coverageIntervals,
  coveredMs,
  describeReason,
  encodeEventCursor,
  failureCode,
  measurementChange,
  parseEventCursor,
  probeErrorKind,
  publicEvent,
  windowCoverage,
  type EventRow,
} from "../src/services/attestation-history.ts";
import { buildSummary, probeChanges, pruneAttestationEvents, recordAttestorRun, recordCanaryEvent, recordProbeChanges } from "../src/services/attestation-events.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const FRESH = 30 * MIN; // three attestor intervals of ten minutes

// ---- pure helpers -------------------------------------------------------------------------------------------------

describe("failure reasons are codes, never the provider's text", () => {
  test("every reason the attestor can give maps to a listed code", () => {
    const cases: [string, string][] = [
      ["attestation endpoint HTTP 503", "endpoint_http_error"],
      ["attestation endpoint unreachable: connect ECONNREFUSED 10.1.2.3:443", "endpoint_unreachable"],
      ["boot attestation unreachable: fetch failed", "endpoint_unreachable"],
      ["report has no TEE quote", "no_quote"],
      ["unparseable TDX quote: TDX quote too short (12 bytes)", "quote_unparseable"],
      ["nonce is not bound into report_data", "nonce_not_bound"],
      ["nonce mismatch", "nonce_not_bound"],
      ["report_data does not bind the supplied nonce", "nonce_not_bound"],
      ["the quote's report_data is not the report's claimed binding", "nonce_not_bound"],
      ["quote_report_data disagrees with the nonce", "nonce_not_bound"],
      ["MRTD not in allowlist", "measurement_not_allowed"],
      ["RTMR3 not in allowlist", "measurement_not_allowed"],
      ["measurement not in allowlist", "measurement_not_allowed"],
      ["sidecar bindings carry no valid image, compose and model digests", "bindings_invalid"],
      ["sidecar bindings are not committed in report_data", "bindings_invalid"],
      ["compose hash in the bindings does not match the verified event log", "bindings_invalid"],
      ["the boot and fresh quotes bind different values", "bindings_invalid"],
      ["the endpoint did not present the TLS key its quote binds", "tls_binding_failed"],
      ["a self-signed endpoint must prove its certificate with a hardware TDX quote", "tls_binding_failed"],
      ["the certificate's attestation reference is not the hash of the quote the endpoint serves", "tls_binding_failed"],
      ["GPU evidence missing", "gpu_evidence_failed"],
      ["GPU evidence is not bound to our nonce", "gpu_evidence_failed"],
      ["NRAS HTTP 500", "gpu_evidence_failed"],
      ["quote not verified (Revoked)", "quote_rejected"],
      ["TD is debuggable", "quote_rejected"],
      ["Intel Trust Authority token rejected: token signature does not verify", "quote_rejected"],
      ["verifiers disagree on the compose hash", "quote_rejected"],
      ["verifier HTTP 502", "verifier_unavailable"],
      ["no DCAP verifier configured (TDX_VERIFIER_URL)", "verifier_unavailable"],
      ["Intel Trust Authority HTTP 503", "verifier_unavailable"],
      ["dev attestation is disabled", "simulated_refused"],
    ];
    for (const [raw, code] of cases) expect([raw, failureCode(raw)]).toEqual([raw, code]);
    for (const [, code] of cases) expect(REASON_MESSAGES[code]).toBeTruthy();
  });
  test("an unrecognised text is `other` and is not kept", () => {
    expect(failureCode("something the provider wrote: secret-value-123")).toBe("other");
    expect(failureCode(undefined)).toBe("other");
    expect(describeReason("other")).toEqual({ code: "other", message: REASON_MESSAGES.other });
    expect(describeReason("made_up")).toEqual({ code: "other", message: REASON_MESSAGES.other });
    expect(describeReason("constructor")).toEqual({ code: "other", message: REASON_MESSAGES.other });
    expect(describeReason(null)).toBeNull();
  });
  test("probe outcomes keep the health tracker's names", () => {
    expect(probeErrorKind(true, 200)).toBeNull();
    expect(probeErrorKind(false, 503)).toBe("http_5xx");
    expect(probeErrorKind(false, 429)).toBe("rate_limited");
    expect(probeErrorKind(false, 401)).toBe("provider_auth");
    expect(probeErrorKind(false, null)).toBe("connection");
  });
});

describe("measurements", () => {
  test("cleanMeasurements keeps known fields with plain values, lower-cased, and drops the rest", () => {
    expect(cleanMeasurements({ image_digest: "0xABCD", mrtd: "aa".repeat(48), extra: "x", model_digest: "<script>", rtmr3: 5 })).toEqual({ image_digest: "0xabcd", mrtd: "aa".repeat(48) });
    expect(cleanMeasurements({ measurement: "mock-measurement-v1" })).toEqual({ measurement: "mock-measurement-v1" });
    for (const bad of [null, undefined, [], "x", {}, { unknown: "aa" }]) expect(cleanMeasurements(bad)).toBeNull();
  });
  test("measurementChange compares only the fields both runs report", () => {
    const a = { image_digest: "0x11", compose_hash: "0x22", model_digest: "0x33", mrtd: "aa" };
    expect(measurementChange(a, { ...a })).toEqual([]);
    expect(measurementChange(a, { ...a, image_digest: "0x99" })).toEqual(["image_digest"]);
    expect(measurementChange(a, { ...a, model_digest: "0x98", compose_hash: "0x97" })).toEqual(["compose_hash", "model_digest"]);
    // digests that start being reported are not a change; neither is losing them
    expect(measurementChange({ mrtd: "aa", rtmr3: "bb" }, { mrtd: "aa", rtmr3: "bb", image_digest: "0x11" })).toEqual([]);
    expect(measurementChange(a, { mrtd: "aa" })).toEqual([]);
    expect(measurementChange({ mrtd: "aa" }, { mrtd: "ab" })).toEqual(["mrtd"]);
    expect(measurementChange(null, a)).toEqual([]);
    expect(measurementChange(a, null)).toEqual([]);
    expect(measurementChange({ mrtd: "aa" }, { measurement: "dev" })).toEqual([]);
  });
});

describe("coverage", () => {
  const ev = (minute: number, ok = true, simulated = false) => ({ at: minute * MIN, ok, simulated });
  const runs = (from: number, to: number, step = 10) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => ev(from + i * step));

  test("runs on schedule cover the whole time, and cover lasts three intervals past the last run", () => {
    expect(coverageIntervals(runs(0, 60), FRESH)).toEqual([[0, 90 * MIN]]);
    expect(coverageIntervals([], FRESH)).toEqual([]);
  });
  test("a gap longer than the freshness window is uncovered", () => {
    expect(coverageIntervals([...runs(0, 30), ...runs(120, 150)], FRESH)).toEqual([
      [0, 60 * MIN],
      [120 * MIN, 180 * MIN],
    ]);
    // a gap just inside the window keeps the cover unbroken
    expect(coverageIntervals([ev(0), ev(30)], FRESH)).toEqual([[0, 60 * MIN]]);
    expect(coverageIntervals([ev(0), ev(31)], FRESH)).toEqual([[0, 30 * MIN], [31 * MIN, 61 * MIN]]);
  });
  test("a failed run ends the cover at once, and the next ok run starts a new one", () => {
    expect(coverageIntervals([...runs(0, 20), ev(25, false), ev(40)], FRESH)).toEqual([
      [0, 25 * MIN],
      [40 * MIN, 70 * MIN],
    ]);
    // a failure after the cover has already lapsed changes nothing
    expect(coverageIntervals([ev(0), ev(100, false)], FRESH)).toEqual([[0, 30 * MIN]]);
    // a failure at the very first moment leaves nothing
    expect(coverageIntervals([ev(0, false)], FRESH)).toEqual([]);
  });
  test("evidence that was only simulated never counts, and it ends earlier cover", () => {
    expect(coverageIntervals([ev(0, true, true), ev(10, true, true)], FRESH)).toEqual([]);
    expect(coverageIntervals([ev(0), ev(10, true, true), ev(20)], FRESH)).toEqual([
      [0, 10 * MIN],
      [20 * MIN, 50 * MIN],
    ]);
  });
  test("events are read in time order whatever order they arrive in", () => {
    expect(coverageIntervals([ev(20), ev(0), ev(10)], FRESH)).toEqual([[0, 50 * MIN]]);
  });
  test("coveredMs clips to the window", () => {
    expect(coveredMs([[0, 100]], 20, 60)).toBe(40);
    expect(coveredMs([[0, 100]], 150, 200)).toBe(0);
    expect(coveredMs([[0, 10], [20, 30]], 5, 25)).toBe(10);
  });

  test("windowCoverage reports the share of the time the record spans, never more", () => {
    const now = 48 * HOUR;
    const full = windowCoverage([[0, now]], now, DAY_MS, 48, 0);
    expect(full).toMatchObject({ share: 1, complete: true, observedMs: DAY_MS });
    expect(full.buckets).toHaveLength(48);
    expect(full.buckets.every((b) => b === 100)).toBe(true);
    // the record begins 6 hours ago: the window is not complete, and the share is over those 6 hours
    const partial = windowCoverage([[now - 6 * HOUR, now - 3 * HOUR]], now, DAY_MS, 48, now - 6 * HOUR);
    expect(partial.complete).toBe(false);
    expect(partial.observedMs).toBe(6 * HOUR);
    expect(partial.share).toBeCloseTo(0.5, 6);
    expect(partial.observedFrom).toBe(now - 6 * HOUR);
    expect(partial.buckets.slice(0, 36).every((b) => b === null)).toBe(true);
    expect(partial.buckets.slice(36, 42).every((b) => b === 100)).toBe(true);
    expect(partial.buckets.slice(42).every((b) => b === 0)).toBe(true);
    // no record at all: no share, no bucket
    const none = windowCoverage([], now, DAY_MS, 48, null);
    expect(none).toMatchObject({ share: null, observedMs: 0, complete: false, observedFrom: null });
    expect(none.buckets.every((b) => b === null)).toBe(true);
    // a bucket that straddles the start of the record is measured over the part that was observed
    const straddle = windowCoverage([[now - 15 * MIN, now]], now, DAY_MS, 48, now - 15 * MIN);
    expect(straddle.buckets[47]).toBe(100);
    expect(straddle.buckets[46]).toBeNull();
  });
});

describe("current status follows the per-provider route's rule", () => {
  const NOW = Date.parse("2026-09-29T12:00:00Z");
  const o = { intervalMs: 600_000, production: false, now: NOW };
  const p = (over: Partial<Parameters<typeof attestationStatus>[0]> = {}) => ({ attested: true, attestationHash: "0x" + "ab".repeat(32), teeKind: "tdx", attestedAt: new Date(NOW - 5 * MIN), ...over });
  const ok = { ok: true, detail: { verifiers: ["dcap"] } };

  test("fresh and verified is attested", () => expect(attestationStatus(p(), ok, o)).toEqual({ status: "attested" }));
  test("stale, failing, never attested and un-flagged are unverified with the reason", () => {
    expect(attestationStatus(p({ attestedAt: new Date(NOW - 31 * MIN) }), ok, o)).toEqual({ status: "unverified", reason: "attestation_stale" });
    expect(attestationStatus(p({ attested: false }), { ok: false, detail: {} }, o)).toEqual({ status: "unverified", reason: "last_attempt_failed" });
    expect(attestationStatus(p({ attested: false, attestedAt: null, attestationHash: null }), undefined, o)).toEqual({ status: "unverified", reason: "no_attestation" });
    expect(attestationStatus(p({ attestedAt: new Date(NOW + MIN) }), ok, o)).toMatchObject({ status: "unverified" });
    expect(attestationStatus(p({ teeKind: null }), ok, o)).toMatchObject({ status: "unverified" });
  });
  test("development evidence is simulated outside production and refused in it", () => {
    expect(attestationStatus(p({ teeKind: "dev" }), { ok: true, detail: { simulated: true } }, o)).toEqual({ status: "simulated" });
    expect(attestationStatus(p(), { ok: true, detail: { simulated: true } }, o)).toEqual({ status: "simulated" });
    expect(attestationStatus(p({ teeKind: "dev" }), { ok: true, detail: { simulated: true } }, { ...o, production: true })).toEqual({ status: "unverified", reason: "simulated_evidence_refused" });
  });
});

describe("cursor and public shape", () => {
  test("a cursor round-trips the moment and the id, and nothing else parses", () => {
    const at = new Date("2026-09-29T08:30:00.123Z");
    const c = encodeEventCursor(at, 42);
    expect(c).toMatch(/^h_[A-Za-z0-9_-]+$/);
    expect(parseEventCursor(c)).toEqual({ at, id: 42 });
    for (const bad of ["", "h_", "x_abc", "2026-09-29T08:30:00Z", "h_!!!", "h_" + Buffer.from("nope").toString("base64url"), "h_" + Buffer.from("2026-09-29T08:30:00.000Z|-1").toString("base64url"), "h_" + Buffer.from("2026-13-99T08:30:00.000Z|4").toString("base64url"), "h_" + "a".repeat(300)]) expect(parseEventCursor(bad)).toBeNull();
  });
  test("publicEvent serves codes, digests and fixed fields only", () => {
    const row: EventRow = {
      id: 7,
      providerId: "p",
      kind: "attestation",
      ts: new Date("2026-09-29T08:30:00.000Z"),
      ok: false,
      reason: "endpoint_unreachable",
      simulated: false,
      teeKind: "tdx",
      attestationHash: "not a hash",
      tlsSpkiSha256: "zz",
      measurements: { mrtd: "aa", secret: "leak" },
      measurementChanged: false,
      verifiers: ["dcap", { x: 1 }, "has space"],
      detail: { changed: ["image_digest", "password"], previous: { mrtd: "bb", token: "leak" }, api_key: "leak" },
    };
    const j = publicEvent(row);
    expect(j).toMatchObject({ id: 7, kind: "attestation", at: "2026-09-29T08:30:00.000Z", ok: false, reason: { code: "endpoint_unreachable" }, tee: "tdx", attestation_hash: null, tls_spki_sha256: null, measurements: { mrtd: "aa" }, verifiers: ["dcap"], detail: { changed: ["image_digest"], previous: { mrtd: "bb" } } });
    expect(JSON.stringify(j)).not.toContain("leak");
    expect(publicEvent({ ...row, ok: true, reason: "endpoint_unreachable" }).reason).toBeNull();
    expect(publicEvent({ ...row, kind: "probe", detail: { status: 503, host: "10.0.0.1" } }).detail).toEqual({ status: 503 });
    expect(publicEvent({ ...row, kind: "canary", detail: { model: "a/b", quality: 0.9, note: "leak" } }).detail).toEqual({ model: "a/b", quality: 0.9 });
    expect(publicEvent({ ...row, simulated: true, ok: true }).tee).toBe("dev");
  });
  test("probeChanges picks the providers whose outcome differs or is new", () => {
    const last = new Map([["a", true], ["b", false]]);
    const results = [{ provider: "a", ok: true, status: 200 }, { provider: "b", ok: true, status: 200 }, { provider: "c", ok: false, status: null }, { provider: "d", ok: true, status: 200 }];
    expect(probeChanges(last, results).map((r) => r.provider)).toEqual(["b", "c", "d"]);
  });
});

// ---- the router: recording, the summary and the history --------------------------------------------------------------

const get = async (h: Harness, path: string) => {
  const r = await h.request(path);
  return { status: r.status, body: (await r.json()) as any, headers: r.headers };
};

describe("proof-time API", () => {
  let h: Harness;
  const NOW = Date.now();
  const db = () => h.ctx.db;
  const event = (kind: string, minutesAgo: number, over: Partial<typeof attestationEvents.$inferInsert> = {}) => ({ providerId: "tee", kind, ts: new Date(NOW - minutesAgo * MIN), ok: true, ...over });
  const ok = (minutesAgo: number, over: Partial<typeof attestationEvents.$inferInsert> = {}) => event("attestation", minutesAgo, { teeKind: "tdx", measurements: { image_digest: "0x" + "11".repeat(32), compose_hash: "0x" + "22".repeat(32), model_digest: "0x" + "33".repeat(32) }, verifiers: ["dcap"], ...over });
  const provider = async (id = "tee") => (await db().select().from(providers).where(eq(providers.id, id)))[0];

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "tee", name: "Enclave", models: [MODELS.llama], tee: "dev" },
        { id: "plain", name: "Plain", models: [MODELS.qwen] },
        { id: "waiting", name: "Waiting", models: [MODELS.llamaPricey], tee: "dev", live: false },
      ],
    });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await db().delete(attestationEvents);
    await db().delete(attestations);
    h.ctx.cfg.attestation.historyDays = 30;
    h.ctx.cfg.measurements.enabled = false;
    await fetch(h.mocks.tee.url + "/_control", { method: "POST", body: JSON.stringify({ tee: "dev" }) });
    await db().update(providers).set({ attested: false, attestationHash: null, attestedAt: null }).where(eq(providers.id, "tee"));
  });

  test("with nothing recorded the summary says so: no share, no invented history", async () => {
    const r = await get(h, "/api/v1/attestation/summary");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=30");
    const d = r.body.data;
    expect(d).toMatchObject({ attestation_interval_ms: 600_000, fresh_within_ms: 1_800_000, history_days: 30 });
    // only providers the attestor works on: not the plain one, not the one still applying
    expect(d.providers.map((p: any) => p.provider)).toEqual(["tee"]);
    const p = d.providers[0];
    expect(p).toMatchObject({ provider: "tee", name: "Enclave", status: "unverified", reason: "no_attestation", history_since: null, last_failure: null, last_measurement_change: null, measurement: null, probe: null, canary: null });
    expect(p.runs_7d).toEqual({ total: 0, attested: 0, attested_pct: null });
    for (const w of ["24h", "7d"]) {
      expect(p.fresh[w]).toMatchObject({ share: null, observed_ms: 0, observed_from: null, history_complete: false });
      expect(p.fresh[w].buckets.every((b: unknown) => b === null)).toBe(true);
    }
    expect(p.fresh["24h"].buckets).toHaveLength(WINDOWS["24h"].buckets);
    expect(p.fresh["7d"].buckets).toHaveLength(WINDOWS["7d"].buckets);
  });

  test("coverage, failures and measurement changes over a recorded week", async () => {
    const rows: (typeof attestationEvents.$inferInsert)[] = [];
    // ten-minute runs from 36 h ago to 20 h ago, then a failure at 19 h, then runs from 6 h ago to 10 minutes ago
    for (let m = 36 * 60; m >= 20 * 60; m -= 10) rows.push(ok(m));
    rows.push(event("attestation", 19 * 60, { ok: false, reason: "endpoint_unreachable", teeKind: "tdx" }));
    for (let m = 6 * 60; m >= 10; m -= 10) rows.push(ok(m, m <= 3 * 60 ? { measurements: { image_digest: "0x" + "44".repeat(32), compose_hash: "0x" + "22".repeat(32), model_digest: "0x" + "33".repeat(32) }, ...(m === 3 * 60 ? { measurementChanged: true, detail: { changed: ["image_digest"], previous: { image_digest: "0x" + "11".repeat(32), compose_hash: "0x" + "22".repeat(32), model_digest: "0x" + "33".repeat(32) } } } : {}) } : {}));
    await db().insert(attestationEvents).values(rows);
    const now = NOW;
    const s = (await buildSummary(h.ctx, now)).providers[0];

    // 24 h: covered from -24 h to -19.5 h (4.5 h) and from -6 h to now (6 h)
    expect(s.fresh["24h"].history_complete).toBe(true);
    expect(s.fresh["24h"].share).toBeCloseTo(10.5 / 24, 5);
    const b24 = s.fresh["24h"].buckets;
    expect(b24.slice(0, 9)).toEqual(Array(9).fill(100));
    expect(b24.slice(9, 36)).toEqual(Array(27).fill(0));
    expect(b24.slice(36)).toEqual(Array(12).fill(100));
    // 7 d: the record begins 36 h ago, so the share is over 36 h and the window is marked incomplete
    expect(s.fresh["7d"].history_complete).toBe(false);
    expect(s.fresh["7d"].observed_ms).toBe(36 * HOUR);
    expect(s.fresh["7d"].observed_from).toBe(new Date(now - 36 * HOUR).toISOString());
    expect(s.fresh["7d"].share).toBeCloseTo(22.5 / 36, 5);
    const b7 = s.fresh["7d"].buckets;
    expect(b7.slice(0, 66).every((b: unknown) => b === null)).toBe(true);
    expect(b7.slice(66, 74)).toEqual(Array(8).fill(100));
    expect(b7[74]).toBe(25);
    expect(b7.slice(75, 81)).toEqual(Array(6).fill(0));
    expect(b7.slice(81)).toEqual(Array(3).fill(100));
    expect(s.history_since).toBe(new Date(now - 36 * HOUR).toISOString());

    const okRuns = rows.filter((r) => r.ok).length;
    expect(s.runs_7d).toEqual({ total: rows.length, attested: okRuns, attested_pct: Math.round((1000 * okRuns) / rows.length) / 10 });
    expect(s.last_failure).toEqual({ at: new Date(now - 19 * HOUR).toISOString(), code: "endpoint_unreachable", message: REASON_MESSAGES.endpoint_unreachable });
    expect(s.measurement_changes_7d).toEqual([{ at: new Date(now - 3 * HOUR).toISOString(), changed: ["image_digest"] }]);
    expect(s.last_measurement_change).toEqual({
      at: new Date(now - 3 * HOUR).toISOString(),
      changed: ["image_digest"],
      from: { image_digest: "0x" + "11".repeat(32), compose_hash: "0x" + "22".repeat(32), model_digest: "0x" + "33".repeat(32) },
      to: { image_digest: "0x" + "44".repeat(32), compose_hash: "0x" + "22".repeat(32), model_digest: "0x" + "33".repeat(32) },
    });
    expect(s.measurement.digests.image_digest).toBe("0x" + "44".repeat(32));
    // the router's own flag says nothing was verified, and the summary reports that rather than the history's optimism
    expect(s.status).toBe("unverified");
  });

  test("a run that ended in a failure right now is not counted as fresh, whatever came before", async () => {
    const rows = [];
    for (let m = 120; m >= 20; m -= 10) rows.push(ok(m));
    rows.push(event("attestation", 5, { ok: false, reason: "quote_rejected", teeKind: "tdx" }));
    await db().insert(attestationEvents).values(rows);
    const s = (await buildSummary(h.ctx, NOW)).providers[0];
    // covered from 2 h ago to 5 minutes ago, out of a record that begins 2 h ago
    expect(s.fresh["24h"].share).toBeCloseTo((115 * MIN) / (120 * MIN), 5);
    expect(s.last_failure.code).toBe("quote_rejected");
    expect(s.fresh["24h"].buckets.at(-1)).toBe(83); // the last half hour was covered for its first 25 minutes
  });

  test("the summary's status agrees with GET /attestation/:id through attested-then-failing runs", async () => {
    const status = async () => {
      const summary = (await get(h, "/api/v1/attestation/summary")).body.data.providers[0];
      const route = (await get(h, "/api/v1/attestation/tee")).body.data;
      expect(summary.status).toBe(route.status);
      expect(summary.reason).toBe(route.reason);
      return summary;
    };
    expect(await status()).toMatchObject({ status: "unverified", reason: "no_attestation" });
    await runAttestor(h.ctx);
    const simulated = await status();
    expect(simulated.status).toBe("simulated"); // development evidence, and the router says so
    expect(simulated.tee).toBe("dev");
    // the simulated run is on record, but is not counted as a fresh attestation
    const [first] = await db().select().from(attestationEvents);
    expect(first).toMatchObject({ providerId: "tee", kind: "attestation", ok: true, simulated: true, reason: null, measurementChanged: false, measurements: { measurement: "mock-measurement-v1" } });
    expect(simulated.fresh["24h"].buckets.every((b: number | null) => b === null || b === 0)).toBe(true);
    expect(simulated.runs_7d).toEqual({ total: 1, attested: 0, attested_pct: 0 });
    // a refused run: the record keeps a code, the summary and the route both say unverified
    await fetch(h.mocks.tee.url + "/_control", { method: "POST", body: JSON.stringify({ tee: null }) });
    await runAttestor(h.ctx);
    const failing = await status();
    expect(failing).toMatchObject({ status: "unverified", reason: "last_attempt_failed" });
    expect(failing.last_failure).toMatchObject({ code: expect.any(String) });
    const events = await db().select().from(attestationEvents);
    expect(events.map((e) => [e.ok, e.reason === null])).toEqual([[true, true], [false, false]]);
  });

  test("history pages newest first with a compound cursor: events at one instant are never skipped or repeated", async () => {
    const same = new Date(NOW - 10 * MIN);
    await db().insert(attestationEvents).values([
      ...Array.from({ length: 7 }, () => ({ providerId: "tee", kind: "attestation", ts: same, ok: true })),
      { providerId: "tee", kind: "attestation", ts: new Date(NOW - 5 * MIN), ok: true },
      { providerId: "tee", kind: "attestation", ts: new Date(NOW - 20 * MIN), ok: false, reason: "no_quote" },
      { providerId: "tee", kind: "probe", ts: new Date(NOW - 20 * MIN), ok: true },
    ]);
    const all: any[] = [];
    let before = "";
    for (let i = 0; i < 20; i++) {
      const r = await get(h, `/api/v1/attestation/tee/history?limit=3${before}`);
      expect(r.status).toBe(200);
      expect(r.body.provider).toBe("tee");
      expect(r.body.history_days).toBe(30);
      all.push(...r.body.data);
      if (!r.body.next) break;
      expect(r.body.data).toHaveLength(3);
      before = `&before=${encodeURIComponent(r.body.next)}`;
    }
    expect(all).toHaveLength(10);
    expect(new Set(all.map((e) => e.id)).size).toBe(10);
    // ordered by time, then id, both descending
    const key = (e: any) => [Date.parse(e.at), e.id];
    for (let i = 1; i < all.length; i++) {
      const [t0, i0] = key(all[i - 1]);
      const [t1, i1] = key(all[i]);
      expect(t0 > t1 || (t0 === t1 && i0 > i1)).toBe(true);
    }
    // the last page says there is no more
    const lastPage = await get(h, "/api/v1/attestation/tee/history?limit=200");
    expect(lastPage.body.data).toHaveLength(10);
    expect(lastPage.body.next).toBeNull();
    // filters
    const failed = await get(h, "/api/v1/attestation/tee/history?ok=false");
    expect(failed.body.data.map((e: any) => e.reason.code)).toEqual(["no_quote"]);
    const probes = await get(h, "/api/v1/attestation/tee/history?kind=probe");
    expect(probes.body.data.map((e: any) => e.kind)).toEqual(["probe"]);
    // limit is clamped, not trusted
    expect((await get(h, "/api/v1/attestation/tee/history?limit=0")).body.data).toHaveLength(10); // unusable: the default
    expect((await get(h, "/api/v1/attestation/tee/history?limit=-5")).body.data).toHaveLength(1); // below the floor: the floor
    expect((await get(h, "/api/v1/attestation/tee/history?limit=99999")).body.data).toHaveLength(10); // above the ceiling: the ceiling
  });

  test("history refuses what it cannot read", async () => {
    const bad = async (q: string) => (await get(h, `/api/v1/attestation/tee/history?${q}`)).status;
    expect(await bad("before=nonsense")).toBe(400);
    expect(await bad("before=2026-09-29T08:30:00Z")).toBe(400);
    expect(await bad("kind=other")).toBe(400);
    expect(await bad("ok=maybe")).toBe(400);
    expect((await get(h, "/api/v1/attestation/nobody/history")).status).toBe(404);
    expect((await get(h, "/api/v1/attestation/waiting/history")).status).toBe(404); // still applying: the same answer as /attestation/:id
  });

  test("an unreachable endpoint is recorded as a code; the address and the error text never reach the record", async () => {
    await db().update(providers).set({ attestationUrl: "http://127.0.0.1:9/attestation" }).where(eq(providers.id, "tee"));
    try {
      const r = await runAttestor(h.ctx);
      expect(r.results[0]).toMatchObject({ ok: false });
      const [row] = await db().select().from(attestations);
      expect(JSON.stringify(row.detail)).toContain("unreachable"); // the private log keeps the full text
    } finally {
      await db().update(providers).set({ attestationUrl: h.mocks.tee.url + "/attestation" }).where(eq(providers.id, "tee"));
    }
    const history = await get(h, "/api/v1/attestation/tee/history");
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({ kind: "attestation", ok: false, reason: { code: "endpoint_unreachable", message: REASON_MESSAGES.endpoint_unreachable }, measurements: null, verifiers: [], attestation_hash: null });
    const summary = JSON.stringify((await get(h, "/api/v1/attestation/summary")).body);
    for (const text of [JSON.stringify(history.body), summary]) {
      expect(text).not.toContain("127.0.0.1");
      expect(text).not.toContain("ECONN");
      expect(text).not.toContain("attestation endpoint unreachable");
    }
  });

  test("recordAttestorRun keeps the run's digests, verifiers and pin, and flags a change of measurement", async () => {
    const p = await provider();
    const spki = "ab".repeat(32);
    const run = async (hash: string, mrtd: string, extra: Partial<typeof attestations.$inferInsert> = {}) => {
      await db().insert(attestations).values({ providerId: "tee", ok: true, teeKind: "tdx", reportHash: hash, nonce: "n", measurements: { mrtd, rtmr3: "cc".repeat(48), leaked: "x" }, detail: { verifiers: ["dcap", "dstack"], simulated: false }, ...extra });
      await recordAttestorRun(h.ctx, { ...p, teeKind: "tdx" }, { provider: "tee", ok: true, hash, tls_pin: { spki_sha256: spki } }, new Date(Date.now() - 1000));
    };
    await run("0x" + "01".repeat(32), "aa".repeat(48));
    await run("0x" + "02".repeat(32), "aa".repeat(48));
    await run("0x" + "03".repeat(32), "ab".repeat(48));
    const events = await get(h, "/api/v1/attestation/tee/history?kind=attestation");
    const [c, b, a] = events.body.data; // newest first
    expect(a).toMatchObject({ ok: true, simulated: false, tee: "tdx", attestation_hash: "0x" + "01".repeat(32), tls_spki_sha256: spki, verifiers: ["dcap", "dstack"], measurement_changed: false, measurements: { mrtd: "aa".repeat(48), rtmr3: "cc".repeat(48) }, detail: null });
    expect(b.measurement_changed).toBe(false);
    expect(c).toMatchObject({ measurement_changed: true, detail: { changed: ["mrtd"], previous: { mrtd: "aa".repeat(48), rtmr3: "cc".repeat(48) } } });
    expect(JSON.stringify(events.body)).not.toContain("leaked");
    const s = (await get(h, "/api/v1/attestation/summary")).body.data.providers[0];
    expect(s.last_measurement_change).toMatchObject({ changed: ["mrtd"], from: { mrtd: "aa".repeat(48) }, to: { mrtd: "ab".repeat(48) } });
    expect(s.measurement_changes_7d).toHaveLength(1);
  });

  test("with measurements on, the digests the run refreshed are recorded; a stale measurement row is not borrowed", async () => {
    h.ctx.cfg.measurements.enabled = true;
    const p = await provider();
    await db().delete(measurements);
    const started = new Date();
    await db().insert(measurements).values({ providerId: "tee", imageDigest: "0x" + "11".repeat(32), composeHash: "0x" + "22".repeat(32), modelDigest: "0x" + "33".repeat(32), verifier: "dcap", quote: "00", quoteProofHash: "0x00", attestedAt: new Date(started.getTime() - 1000), lastSeenAt: new Date(started.getTime() - 5000) });
    await db().insert(attestations).values({ providerId: "tee", ok: true, teeKind: "tdx", reportHash: "0x" + "05".repeat(32), measurements: { mrtd: "aa".repeat(48) }, detail: { verifiers: ["dcap"], simulated: false } });
    await recordAttestorRun(h.ctx, { ...p, teeKind: "tdx" }, { provider: "tee", ok: true, hash: "0x" + "05".repeat(32) }, started);
    await db().update(measurements).set({ lastSeenAt: new Date(started.getTime() + 10) });
    await db().insert(attestations).values({ providerId: "tee", ok: true, teeKind: "tdx", reportHash: "0x" + "06".repeat(32), measurements: { mrtd: "aa".repeat(48) }, detail: { verifiers: ["dcap"], simulated: false } });
    await recordAttestorRun(h.ctx, { ...p, teeKind: "tdx" }, { provider: "tee", ok: true, hash: "0x" + "06".repeat(32) }, started);
    const [newer, older] = (await get(h, "/api/v1/attestation/tee/history")).body.data;
    expect(older.measurements).toEqual({ mrtd: "aa".repeat(48) }); // last seen before this run began: not this run's
    expect(newer.measurements).toEqual({ mrtd: "aa".repeat(48), image_digest: "0x" + "11".repeat(32), compose_hash: "0x" + "22".repeat(32), model_digest: "0x" + "33".repeat(32) });
    expect(newer.measurement_changed).toBe(false); // digests newly reported are not a change
  });

  test("canary and probe outcomes are recorded for attestable providers and shown in the summary", async () => {
    await recordCanaryEvent(h.ctx, { providerId: "tee", modelId: "meta/llama", declared: "bf16", quantMatch: true, quality: 0.987 });
    await recordCanaryEvent(h.ctx, { providerId: "tee", modelId: "meta/llama", declared: "bf16", quantMatch: false, quality: 0.6 });
    await recordCanaryEvent(h.ctx, { providerId: "tee", modelId: "qwen/q", declared: "fp8", quantMatch: null, quality: null });
    const canaries = (await get(h, "/api/v1/attestation/tee/history?kind=canary")).body.data;
    expect(canaries.map((e: any) => [e.ok, e.reason?.code ?? null])).toEqual([[false, "no_answer"], [false, "quantization_mismatch"], [true, null]]);
    expect(canaries[2].detail).toEqual({ model: "meta/llama", declared: "bf16", quant_match: true, quality: 0.99 });
    // a probe outcome is recorded when it changes, not every time
    const up = [{ provider: "tee", ok: true, status: 200 }];
    await recordProbeChanges(h.ctx, up);
    await recordProbeChanges(h.ctx, up);
    await recordProbeChanges(h.ctx, [{ provider: "tee", ok: false, status: 503 }]);
    await recordProbeChanges(h.ctx, [{ provider: "tee", ok: false, status: null }]);
    const probes = (await get(h, "/api/v1/attestation/tee/history?kind=probe")).body.data;
    expect(probes.map((e: any) => [e.ok, e.reason?.code ?? null, e.detail])).toEqual([[false, "http_5xx", { status: 503 }], [true, null, { status: 200 }]]);
    const s = (await get(h, "/api/v1/attestation/summary")).body.data.providers[0];
    expect(s.probe).toMatchObject({ ok: false, reason: { code: "http_5xx" } });
    expect(s.canary).toMatchObject({ ok: false, model: "qwen/q", reason: { code: "no_answer" } });
    expect(s.last_failure).toBeNull(); // canaries and probes are not attestation failures
    expect(s.runs_7d.total).toBe(0);
  });

  test("the canary and probe jobs write to the record for a TEE provider only", async () => {
    const t = await startRouter({
      env: { CANARIES: "true" },
      providers: [
        { id: "ref", name: "Reference", models: [MODELS.llama], tee: "dev" },
        { id: "cheat", name: "Cheat", models: [{ ...MODELS.llama, quant: "bf16" }], tee: "dev", quantNoise: 0.9, wrongAnswers: true },
        { id: "plain", name: "Plain", models: [MODELS.llama] },
      ],
    });
    try {
      await t.ctx.db.update(providers).set({ attestationUrl: null }).where(eq(providers.id, "cheat")); // a TEE provider that never attests
      await runAttestor(t.ctx);
      await t.ctx.catalog.refresh();
      await runCanaries(t.ctx);
      await runProbes(t.ctx);
      await runProbes(t.ctx);
      const events = await t.ctx.db.select().from(attestationEvents);
      expect(new Set(events.map((e) => e.providerId))).toEqual(new Set(["ref", "cheat"])); // never the plain provider
      const of = (id: string, kind: string) => events.filter((e) => e.providerId === id && e.kind === kind);
      expect(of("ref", "canary")).toHaveLength(1);
      expect(of("cheat", "canary")).toHaveLength(1);
      expect(of("cheat", "canary")[0].ok).toBe(false);
      expect(of("ref", "probe")).toHaveLength(1); // two probes, one change: the first outcome
      expect(of("ref", "attestation")).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  test("events older than the retention are pruned by the attestor's next run", async () => {
    h.ctx.cfg.attestation.historyDays = 7;
    await db().insert(attestationEvents).values([
      { providerId: "tee", kind: "attestation", ts: new Date(NOW - 8 * DAY_MS), ok: true },
      { providerId: "tee", kind: "probe", ts: new Date(NOW - 7 * DAY_MS - MIN), ok: true },
      { providerId: "tee", kind: "attestation", ts: new Date(NOW - 6 * DAY_MS), ok: true },
    ]);
    expect(await pruneAttestationEvents(h.ctx, NOW)).toBe(2);
    expect(await pruneAttestationEvents(h.ctx, NOW)).toBe(0);
    expect(await db().select().from(attestationEvents)).toHaveLength(1);
    await db().insert(attestationEvents).values({ providerId: "tee", kind: "attestation", ts: new Date(Date.now() - 9 * DAY_MS), ok: true });
    await runAttestor(h.ctx);
    const left = await db().select().from(attestationEvents);
    expect(left.every((e) => e.ts.getTime() > Date.now() - 7 * DAY_MS)).toBe(true);
    expect(left).toHaveLength(2); // the 6-day-old row and this run's
  });

  test("history off: nothing is recorded, nothing is pruned, the endpoints say so, and the attestor is unaffected", async () => {
    h.ctx.cfg.attestation.historyDays = 0;
    await db().insert(attestationEvents).values({ providerId: "tee", kind: "attestation", ts: new Date(NOW - 400 * DAY_MS), ok: true });
    const r = await runAttestor(h.ctx);
    expect(r.results[0]).toMatchObject({ ok: true });
    await recordCanaryEvent(h.ctx, { providerId: "tee", modelId: "m", declared: "bf16", quantMatch: true, quality: 1 });
    await recordProbeChanges(h.ctx, [{ provider: "tee", ok: true, status: 200 }]);
    expect(await db().select().from(attestationEvents)).toHaveLength(1);
    expect(await pruneAttestationEvents(h.ctx, NOW)).toBe(0);
    for (const path of ["/api/v1/attestation/summary", "/api/v1/attestation/tee/history"]) {
      const res = await get(h, path);
      expect(res.status).toBe(501);
      expect(res.body.error.type).toBe("not_enabled");
    }
    // the existing per-provider record is untouched by any of this
    expect((await get(h, "/api/v1/attestation/tee")).status).toBe(200);
  });
});
