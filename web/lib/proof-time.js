// Proof-time page: pure helpers (no React), shared by components/ProofTime.jsx and its tests.
// They turn `GET /api/v1/attestation/summary` into what the page shows, and keep it honest: a share is never rounded up
// to a better-looking number, time the record does not reach back to is shown as unknown (not as covered or uncovered),
// and a provider with nothing recorded says so instead of showing an empty bar as a good result.

import { shortDigest, teeLabel, verifyHref } from "./verify.js";

export { verifyHref };
export const SUMMARY_PATH = "/api/v1/attestation/summary";
export const historyPath = (providerId) => `/api/v1/attestation/${encodeURIComponent(providerId)}/history`;

/** The record must span at least this long before a share is shown as a number. */
export const MIN_OBSERVED_MS = 3_600_000;
export const WINDOW_MS = { "24h": 86_400_000, "7d": 604_800_000 };
export const WINDOW_LABEL = { "24h": "Last 24 hours", "7d": "Last 7 days" };

/** "87.5%": truncated to one decimal, so 99.96% reads 99.9% and only a full share reads 100%. Empty for a non-share. */
export function formatShare(share) {
  if (typeof share !== "number" || !Number.isFinite(share) || share < 0) return "";
  const tenth = Math.floor(Math.min(1, share) * 1000 + 1e-9) / 10;
  return `${Number.isInteger(tenth) ? tenth : tenth.toFixed(1)}%`;
}

/** "6 h 12 min", "45 min", "3 d 4 h": the two largest units, "" when unusable. */
export function durationLabel(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const STATUS = {
  attested: { tone: "ok", label: "Attested", text: "The router holds a fresh attestation it verified itself." },
  simulated: { tone: "warn", label: "Simulated", text: "Development evidence only. Nothing about it is verified, and a production router refuses it." },
  unverified: { tone: "bad", label: "Unverified", text: "The router has no current verification for this provider." },
};
const UNVERIFIED = {
  no_attestation: "The router has never verified this provider.",
  last_attempt_failed: "The router's latest attempt to verify this provider failed.",
  attestation_stale: "The router's last verification is too old to count.",
  simulated_evidence_refused: "The only evidence is simulated, which this router does not accept.",
};

const FIELD = { image_digest: "image digest", compose_hash: "compose hash", model_digest: "model digest", mrtd: "TDX build measurement", rtmr0: "TDX runtime register 0", rtmr1: "TDX runtime register 1", rtmr2: "TDX runtime register 2", rtmr3: "TDX runtime register 3", measurement: "measurement" };
export const fieldLabel = (k) => FIELD[k] || String(k);

/** One cell of a timeline bar. `pct` is the share of the cell covered, or null before the record begins. */
export function barCells(buckets) {
  return (Array.isArray(buckets) ? buckets : []).map((b) => {
    if (typeof b !== "number" || !Number.isFinite(b)) return { pct: null, kind: "nodata" };
    const pct = Math.max(0, Math.min(100, Math.round(b)));
    return { pct, kind: pct === 100 ? "full" : pct === 0 ? "none" : "partial" };
  });
}

/** Where each change falls along a window ending at `now`, as a percentage from the left. Changes outside it are dropped. */
export function markerPositions(changes, now, windowMs) {
  const out = [];
  for (const c of Array.isArray(changes) ? changes : []) {
    const t = Date.parse(c?.at || "");
    const pos = ((t - (now - windowMs)) / windowMs) * 100;
    if (Number.isFinite(pos) && pos >= 0 && pos <= 100) out.push({ at: c.at, left: Math.round(pos * 10) / 10, changed: Array.isArray(c.changed) ? c.changed : [] });
  }
  return out;
}

const list = (keys) => (keys.length ? keys.map(fieldLabel).join(", ") : "the recorded measurement");

/** One window's row: the share (or why there is none), the bar and what the numbers describe. */
export function describeWindow(name, w, changes, now) {
  const win = w || {};
  const observed = typeof win.observed_ms === "number" ? win.observed_ms : 0;
  const cells = barCells(win.buckets);
  const hasRecord = observed > 0 && typeof win.share === "number";
  const enough = hasRecord && observed >= MIN_OBSERVED_MS;
  let caption;
  if (!hasRecord) caption = "Nothing recorded in this window yet.";
  else if (!enough) caption = `The record spans only ${durationLabel(observed)}, too little to give a share.`;
  else if (win.history_complete) caption = `Covered for ${formatShare(win.share)} of the window.`;
  else caption = `Covered for ${formatShare(win.share)} of the ${durationLabel(observed)} the record spans. The earlier part of the window is unknown, and is not counted either way.`;
  const covered = cells.filter((c) => c.kind === "full").length;
  const gaps = cells.filter((c) => c.kind === "none" || c.kind === "partial").length;
  const unknown = cells.filter((c) => c.kind === "nodata").length;
  return {
    name,
    label: WINDOW_LABEL[name] || name,
    state: !hasRecord ? "empty" : !enough ? "early" : win.history_complete ? "complete" : "partial",
    share: enough ? win.share : null,
    shareText: enough ? formatShare(win.share) : "",
    caption,
    cells,
    markers: markerPositions(changes, now, WINDOW_MS[name] || 0),
    summary: `${WINDOW_LABEL[name] || name}: ${enough ? `fresh attestation for ${formatShare(win.share)} of the time` : caption} ${cells.length} slices: ${covered} fully covered, ${gaps} with a gap, ${unknown} before the record begins.`,
  };
}

/** "just now", "12 min ago", "30 h ago" (hours up to two days), "5 d ago"; "" when the time is unusable. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < -60) return "in the future";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
const at = ago;

/** A view model for one provider of the summary. */
export function describeProvider(p, summary, now = Date.now()) {
  const d = p || {};
  const status = STATUS[d.status] ? d.status : "unverified";
  const s = STATUS[status];
  const changes7 = Array.isArray(d.measurement_changes_7d) ? d.measurement_changes_7d : [];
  const changes24 = changes7.filter((c) => Date.parse(c?.at || "") >= now - WINDOW_MS["24h"]);
  const days = Number(summary?.history_days) || 0;
  const hasHistory = !!d.history_since;
  // How much time the absence of a failure or change is measured over: what is on record, never more than the router keeps.
  const sinceMs = hasHistory ? now - Date.parse(d.history_since) : Number.NaN;
  const onRecord = Number.isFinite(sinceMs) && sinceMs >= 0 ? durationLabel(days ? Math.min(sinceMs, days * 86_400_000) : sinceMs) : "";
  const lf = d.last_failure;
  const lc = d.last_measurement_change;
  const runs = d.runs_7d || {};
  const probe = d.probe;
  const canary = d.canary;
  return {
    id: String(d.provider || ""),
    name: String(d.name || d.provider || ""),
    status,
    tone: s.tone,
    label: s.label,
    text: status === "unverified" ? UNVERIFIED[d.reason] || s.text : s.text,
    tee: status === "unverified" ? "Not established" : teeLabel(d.tee),
    lastVerified: status === "unverified" ? "" : at(d.attested_at, now),
    hasHistory,
    historySince: d.history_since || "",
    changes: changes7.map((c) => ({ at: c.at, when: at(c.at, now), text: list(Array.isArray(c.changed) ? c.changed : []) })),
    windows: [describeWindow("24h", d.fresh?.["24h"], changes24, now), describeWindow("7d", d.fresh?.["7d"], changes7, now)],
    runs: typeof runs.total === "number" && runs.total > 0 ? { text: `${formatShare((runs.attested || 0) / runs.total)} of ${runs.total} checks in 7 days passed`, total: runs.total, attested: runs.attested || 0 } : null,
    failure: lf
      ? { state: "seen", when: at(lf.at, now), at: lf.at, text: lf.message || "The check failed.", code: lf.code || "other" }
      : hasHistory
        ? { state: "none", text: onRecord ? `No failed check in the ${onRecord} on record.` : "No failed check on record." }
        : { state: "unknown", text: "Nothing has been recorded yet." },
    change: lc
      ? { state: "seen", when: at(lc.at, now), at: lc.at, text: `Changed: ${list(Array.isArray(lc.changed) ? lc.changed : [])}.`, from: shortDigest(Object.values(lc.from || {})[0] || ""), to: shortDigest(Object.values(lc.to || {})[0] || "") }
      : hasHistory
        ? { state: "none", text: onRecord ? `No measurement change in the ${onRecord} on record.` : "No measurement change on record." }
        : { state: "unknown", text: "Nothing has been recorded yet." },
    probe: probe ? { ok: !!probe.ok, text: probe.ok ? `Answered its last health probe, unchanged since ${at(probe.since, now) || "the record began"}.` : `Failed its last health probe ${at(probe.since, now)}: ${probe.reason?.message || "no answer"}` } : null,
    canary: canary ? { ok: !!canary.ok, text: canary.ok ? `Last canary ${at(canary.at, now)} matched what the provider declares.` : `Last canary ${at(canary.at, now)}: ${canary.reason?.message || "did not match"}` } : null,
    verifyHref: verifyHref(String(d.provider || "")),
  };
}

/** The whole page from a summary: the providers, and what the numbers mean on this router. */
export function describeSummary(summary, now = Date.now()) {
  const s = summary || {};
  const providers = (Array.isArray(s.providers) ? s.providers : []).map((p) => describeProvider(p, s, now));
  const freshMin = Number.isFinite(s.fresh_within_ms) ? Math.round(s.fresh_within_ms / 60_000) : null;
  return {
    providers,
    historyDays: Number(s.history_days) || 0,
    generatedAt: s.generated_at || "",
    freshMinutes: freshMin,
    definition: freshMin
      ? `A fresh attestation is one the router verified itself in the last ${freshMin} minutes, with no failed check since. Time is counted as covered only while one is held.`
      : "A fresh attestation is one the router verified itself recently, with no failed check since.",
  };
}

/** The page state for a response to the summary request: what to show, and what to say about it. */
export function pageState(status) {
  if (status === 501) return { kind: "off", text: "This router does not keep an attestation history, so there is no proof-time to show." };
  if (status === "network" || status >= 500 || status === 0) return { kind: "error", text: "The router could not be reached, so nothing is known from here. That is not the same as “not attested”; try again." };
  if (status >= 400) return { kind: "error", text: "The router did not return its attestation record. Try again in a moment." };
  return { kind: "ok", text: "" };
}
