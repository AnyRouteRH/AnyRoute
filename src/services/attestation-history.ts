// Proof-time, pure part: everything that turns recorded attestor, canary and probe events into what the public sees.
// No database and no clock here (callers pass `now`), so every rule below is tested on its own.
//
// What "fresh" means. The router treats a provider as attested while its last verified attestation is at most three
// attestor intervals old and no later run has failed (a failed run clears the flag at once). Coverage replays that rule
// over the recorded events: an ok run covers the time from its own moment until three intervals later, a failed run (or
// one accepted only as simulated evidence) ends the cover, and the share of a window is the covered part of the time the
// record actually spans. A window the record does not reach back to is reported as such, never padded.

export const EVENT_KINDS = ["attestation", "canary", "probe"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WINDOWS = {
  "24h": { ms: DAY_MS, buckets: 48 },
  "7d": { ms: 7 * DAY_MS, buckets: 84 },
} as const;
export type WindowName = keyof typeof WINDOWS;

// ---- failure reasons ------------------------------------------------------------------------------------------------
// The attestor's failure text can quote what a provider sent back or the address it was reached at. Only a code from
// this list is stored and served; the message is fixed text.

export const REASON_MESSAGES: Record<string, string> = {
  endpoint_unreachable: "The attestation endpoint could not be reached.",
  endpoint_http_error: "The attestation endpoint answered with an HTTP error.",
  no_quote: "The report carried no hardware quote.",
  quote_unparseable: "The hardware quote could not be parsed.",
  nonce_not_bound: "The quote did not bind the fresh nonce the router sent.",
  quote_rejected: "A quote verifier rejected the quote.",
  verifier_unavailable: "A quote verifier could not be reached or is not configured, so the quote was not checked.",
  measurement_not_allowed: "A measurement was not in the operator's allowlist.",
  bindings_invalid: "The endpoint's digests were missing, or not committed to by the quote.",
  tls_binding_failed: "The endpoint's TLS certificate could not be tied to its quote.",
  gpu_evidence_failed: "The GPU attestation evidence was missing or rejected.",
  simulated_refused: "Simulated (development) evidence was refused.",
  http_5xx: "The endpoint answered a health probe with a server error.",
  rate_limited: "The endpoint rate-limited the health probe.",
  provider_auth: "The endpoint refused the health probe with an HTTP 4xx answer.",
  connection: "The endpoint could not be reached by the health probe.",
  quantization_mismatch: "The canary output looked like lower precision than the provider declares.",
  no_answer: "The provider gave the canary no usable answer.",
  other: "The check failed for a reason this record does not list.",
};

// Order matters: the first pattern that matches wins.
const REASON_PATTERNS: [RegExp, string][] = [
  [/^dev attestation is disabled/i, "simulated_refused"],
  [/^attestation endpoint HTTP \d+/i, "endpoint_http_error"],
  [/unreachable/i, "endpoint_unreachable"],
  [/^report has no TEE quote/i, "no_quote"],
  [/^unparseable .*quote/i, "quote_unparseable"],
  // aci/1 gateways (providers/aci.ts)
  [/^report_data does not bind|the quote's report_data is not the report's|quote_report_data disagrees/i, "nonce_not_bound"],
  [/workload_keyset|app_compose is not the measured compose|keyset lists no|keyset has no/i, "bindings_invalid"],
  [/GPU|NRAS/i, "gpu_evidence_failed"],
  [/nonce (mismatch|is not bound)|not bound to our nonce/i, "nonce_not_bound"],
  [/allowlist/i, "measurement_not_allowed"],
  [/no .*verifier configured|no Intel Trust Authority key|verifier HTTP \d+|Trust Authority (HTTP|key set|returned no)|verifier .*returned/i, "verifier_unavailable"],
  [/bindings|compose hash in the (boot )?bindings|boot and fresh quotes/i, "bindings_invalid"],
  [/self-signed|TLS key|certificate|attestation reference/i, "tls_binding_failed"],
  [/quote not verified|quote or event log|token|debuggable|report_data reported|mr_config_id|verifiers disagree|TDX quotes only|event log|did not appraise|did not report|rejected the quote/i, "quote_rejected"],
];

/** The public code for an attestor failure text. Anything unrecognised is `other`; the text itself is never kept. */
export function failureCode(raw: string | null | undefined): string {
  const text = String(raw ?? "");
  for (const [re, code] of REASON_PATTERNS) if (re.test(text)) return code;
  return "other";
}

/** `{ code, message }` for a stored code; an unknown code reads as `other`. */
export function describeReason(code: string | null | undefined): { code: string; message: string } | null {
  if (!code) return null;
  const known = Object.hasOwn(REASON_MESSAGES, code);
  return { code: known ? code : "other", message: REASON_MESSAGES[known ? code : "other"] };
}

/** The health probe's failure kind, as the health tracker names it. */
export function probeErrorKind(ok: boolean, status: number | null | undefined): string | null {
  if (ok) return null;
  return status && status >= 500 ? "http_5xx" : status === 429 ? "rate_limited" : status ? "provider_auth" : "connection";
}

// ---- measurements ---------------------------------------------------------------------------------------------------

export const MEASUREMENT_KEYS = ["image_digest", "compose_hash", "model_digest", "mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3", "measurement"] as const;
export type Measurements = Partial<Record<(typeof MEASUREMENT_KEYS)[number], string>>;
const VALUE = /^[0-9A-Za-z_.:-]{1,256}$/;

/** Keep only the known digest fields, and only plain token-like values. Null when nothing is left. */
export function cleanMeasurements(input: unknown): Measurements | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Measurements = {};
  for (const k of MEASUREMENT_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && VALUE.test(v)) out[k] = v.toLowerCase();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The fields whose value differs between two runs' measurements. Only fields both runs report are compared, so a run
 * that starts reporting more (measurements switched on after registers were already recorded) is not a change.
 * Empty when either side is missing, when they share no field, or when nothing differs.
 */
export function measurementChange(prev: Measurements | null | undefined, next: Measurements | null | undefined): string[] {
  if (!prev || !next) return [];
  return MEASUREMENT_KEYS.filter((k) => prev[k] !== undefined && next[k] !== undefined && prev[k] !== next[k]);
}

// ---- coverage -------------------------------------------------------------------------------------------------------

export type CoverageEvent = { at: number; ok: boolean; simulated?: boolean };
export type Interval = [start: number, end: number];

/**
 * The stretches of time during which the provider held a fresh attestation, from its attestor runs (oldest first):
 * an ok run covers [at, at + freshnessMs]; overlapping cover merges; a failed run, or an ok run that was only
 * simulated evidence, cuts the cover at its own moment.
 */
export function coverageIntervals(events: CoverageEvent[], freshnessMs: number): Interval[] {
  const out: Interval[] = [];
  let open: Interval | null = null;
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.ok && !e.simulated) {
      if (open && e.at <= open[1]) open[1] = e.at + freshnessMs;
      else {
        if (open) out.push(open);
        open = [e.at, e.at + freshnessMs];
      }
    } else if (open) {
      open[1] = Math.min(open[1], e.at);
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out.filter(([s, e]) => e > s);
}

/** Milliseconds of [from, to] the intervals cover. */
export function coveredMs(intervals: Interval[], from: number, to: number): number {
  let total = 0;
  for (const [s, e] of intervals) total += Math.max(0, Math.min(e, to) - Math.max(s, from));
  return total;
}

export type WindowCoverage = {
  /** Covered share of the time the record spans within the window, 0..1; null when the record spans none of it. */
  share: number | null;
  /** How much of the window the record spans, in milliseconds. */
  observedMs: number;
  /** The record reaches back to the start of the window. False means the share describes a shorter stretch. */
  complete: boolean;
  /** Where the observed part of the window begins (never earlier than the record's first event). */
  observedFrom: number | null;
  buckets: (number | null)[];
};

/** Coverage of the window ending at `now`, as a share and as `buckets` equal slices (percent covered, null before the record begins). */
export function windowCoverage(intervals: Interval[], now: number, windowMs: number, buckets: number, firstAt: number | null): WindowCoverage {
  const from = now - windowMs;
  const start = firstAt == null ? null : Math.max(from, firstAt);
  const observedMs = start == null ? 0 : Math.max(0, now - start);
  const share = observedMs > 0 ? Math.min(1, coveredMs(intervals, start!, now) / observedMs) : null;
  const width = windowMs / buckets;
  const slices: (number | null)[] = [];
  for (let i = 0; i < buckets; i++) {
    const b0 = from + i * width;
    const b1 = i === buckets - 1 ? now : b0 + width;
    const o0 = firstAt == null ? b1 : Math.max(b0, firstAt);
    slices.push(o0 >= b1 ? null : Math.round((100 * coveredMs(intervals, o0, b1)) / (b1 - o0)));
  }
  return { share, observedMs, complete: firstAt != null && firstAt <= from, observedFrom: start, buckets: slices };
}

// ---- current status -------------------------------------------------------------------------------------------------

export type StatusInput = { attested: boolean; attestationHash: string | null; teeKind: string | null; attestedAt: Date | null };
export type StatusOptions = { intervalMs: number; production: boolean; now: number };

/**
 * Attested, simulated or unverified, by the same rule as GET /api/v1/attestation/:providerId (a test keeps the two in
 * step): attested only while the last verified attestation is at most three intervals old, simulated only for
 * development evidence outside production, unverified otherwise, with the reason.
 */
export function attestationStatus(p: StatusInput, last: { ok: boolean; detail: unknown } | undefined, o: StatusOptions): { status: "attested" | "simulated" | "unverified"; reason?: string } {
  const age = p.attestedAt ? o.now - p.attestedAt.getTime() : Number.NaN;
  const fresh = p.attested && !!p.attestationHash && !!p.teeKind && Number.isFinite(age) && age >= 0 && age <= o.intervalMs * 3;
  const okRow = last?.ok ? last : null;
  const simulatedEvidence = fresh && (p.teeKind === "dev" || (okRow?.detail as { simulated?: unknown } | null)?.simulated === true);
  const status = fresh && !simulatedEvidence ? "attested" : simulatedEvidence && !o.production ? "simulated" : "unverified";
  if (status !== "unverified") return { status };
  return { status, reason: !last ? "no_attestation" : !last.ok ? "last_attempt_failed" : simulatedEvidence ? "simulated_evidence_refused" : "attestation_stale" };
}

// ---- paging ---------------------------------------------------------------------------------------------------------

export type EventCursor = { at: Date; id: number };
const CURSOR_PREFIX = "h_";
export const CURSOR_MESSAGE = "`before` must be the `next` value of the previous page.";

/** An opaque cursor for the position of one event: its time (whole milliseconds) and id, so events at the same instant never tie. */
export function encodeEventCursor(at: Date, id: number): string {
  return CURSOR_PREFIX + Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

/** The position a cursor names, or null when it is not one this module issued. */
export function parseEventCursor(raw: string): EventCursor | null {
  if (!raw.startsWith(CURSOR_PREFIX) || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw.slice(CURSOR_PREFIX.length))) return null;
  const decoded = Buffer.from(raw.slice(CURSOR_PREFIX.length), "base64url").toString("utf8");
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(\d{1,15})$/.exec(decoded);
  if (!m) return null;
  const at = new Date(m[1]);
  return Number.isNaN(at.getTime()) ? null : { at, id: Number(m[2]) };
}

// ---- public shape of one event ----------------------------------------------------------------------------------------

export type EventRow = {
  id: number;
  providerId: string;
  kind: string;
  ts: Date;
  ok: boolean;
  reason: string | null;
  simulated: boolean;
  teeKind: string | null;
  attestationHash: string | null;
  tlsSpkiSha256: string | null;
  measurements: unknown;
  measurementChanged: boolean;
  verifiers: unknown;
  detail: unknown;
};

const scalar = (v: unknown) => (typeof v === "string" ? v.slice(0, 128) : typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? v : null);

/** The parts of an event's `detail` that may be served: a fixed list per kind, plain values only. */
export function cleanDetail(kind: string, detail: unknown): Record<string, unknown> | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (kind === "canary") for (const k of ["model", "declared", "quant_match", "quality"]) if (d[k] !== undefined && d[k] !== null) out[k] = scalar(d[k]);
  if (kind === "probe" && typeof d.status === "number") out.status = d.status;
  if (kind === "attestation") {
    const changed = Array.isArray(d.changed) ? d.changed.filter((k): k is string => (MEASUREMENT_KEYS as readonly string[]).includes(k as string)) : [];
    if (changed.length) out.changed = changed;
    const previous = cleanMeasurements(d.previous);
    if (previous) out.previous = previous;
  }
  return Object.keys(out).length ? out : null;
}

const HEX64 = /^[0-9a-f]{64}$/;
export function publicEvent(r: EventRow) {
  return {
    id: r.id,
    kind: r.kind,
    at: r.ts.toISOString(),
    ok: r.ok,
    reason: r.ok ? null : describeReason(r.reason),
    tee: r.simulated ? "dev" : r.teeKind ?? null,
    simulated: r.simulated,
    attestation_hash: r.attestationHash && /^0x[0-9a-f]{64}$/.test(r.attestationHash) ? r.attestationHash : null,
    tls_spki_sha256: r.tlsSpkiSha256 && HEX64.test(r.tlsSpkiSha256) ? r.tlsSpkiSha256 : null,
    measurements: cleanMeasurements(r.measurements),
    measurement_changed: r.measurementChanged,
    verifiers: Array.isArray(r.verifiers) ? r.verifiers.filter((v): v is string => typeof v === "string" && /^[\w.-]{1,32}$/.test(v)) : [],
    detail: cleanDetail(r.kind, r.detail),
  };
}
