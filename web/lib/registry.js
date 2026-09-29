// Registry pages: pure helpers (no React), shared by components/Registry.jsx and its tests.
// The list is GET /api/v1/attestation/summary; one provider's measurement history is GET /api/v1/attestation/{id}/history.
// A run of identical checks is shown once, with how many there were and when; a measurement change is always its own
// entry; a failed check is never folded into a passing run; and time the record does not cover is not drawn as covered.

import { SUMMARY_PATH, ago, describeProvider, fieldLabel, historyPath } from "./proof-time.js";
import { shortDigest, verifyHref } from "./verify.js";

export { SUMMARY_PATH, historyPath };
export const HISTORY_QUERY = "?kind=attestation&limit=200";
export const PLACEHOLDER = "_";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const registryHref = (id) => `/registry/${encodeURIComponent(id)}/`;

/** The provider id from /registry/<id>/, or from ?p=<id> (the exported page and local previews). "" when none. */
export function registryIdFrom(pathname = "", search = "") {
  const seg = String(pathname).split("/").filter(Boolean);
  let id = seg[0] === "registry" && seg[1] ? safeDecode(seg[1]) : "";
  if (!id || id === PLACEHOLDER) id = new URLSearchParams(search).get("p") || "";
  return ID.test(id) ? id : "";
}
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
}

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const idPath = (id) => String(id).split("/").map(encodeURIComponent).join("/");

/** The script badge for a host page. */
export function badgeSnippet(origin, id, theme = "light") {
  return `<script src="${escAttr(origin)}/badge.js" data-endpoint="${escAttr(id)}" data-theme="${escAttr(theme)}" async></script>`;
}
/** The static image badge, for places that do not run scripts (a README, a model card). */
export function badgeImage(origin, id, theme = "light") {
  return `<img src="${escAttr(origin)}/api/v1/badge/${escAttr(idPath(id))}.svg${theme === "dark" ? "?theme=dark" : ""}" alt="Anyroute attestation status" height="48">`;
}
/** The same image in Markdown, for a README or a Hugging Face model card. */
export function badgeMarkdown(origin, id) {
  return `[![Anyroute attestation status](${origin}/api/v1/badge/${idPath(id)}.svg)](${origin}${String(id).includes("/") ? "/registry/" : registryHref(id)})`;
}

const MEASURE_KEYS = ["compose_hash", "image_digest", "model_digest"];
/** The digest that names a measurement version: compose hash, else image digest, else model digest. */
export function versionOf(m) {
  if (!m || typeof m !== "object") return "";
  for (const k of MEASURE_KEYS) if (typeof m[k] === "string" && m[k]) return m[k];
  return "";
}

/** One row per attesting provider, attested first. */
export function describeRegistry(summary, now = Date.now()) {
  const list = Array.isArray(summary?.providers) ? summary.providers : [];
  const order = { attested: 0, simulated: 1, unverified: 2 };
  return list
    .map((p) => {
      const v = describeProvider(p, summary, now);
      const week = v.windows.find((w) => w.name === "7d");
      const version = v.status === "unverified" ? "" : versionOf(p.measurement?.digests);
      return {
        id: v.id,
        name: v.name,
        status: v.status,
        label: v.label,
        tone: v.tone,
        version: version ? shortDigest(version) : "",
        versionNote: version ? "" : v.status === "unverified" ? "No current measurement" : "No measurement recorded",
        changes7d: Array.isArray(p.measurement_changes_7d) ? p.measurement_changes_7d.length : 0,
        lastChange: v.change.state === "seen" ? `Changed ${v.change.when}` : v.change.text,
        share: week?.shareText || "",
        shareNote: week?.shareText ? (week.state === "complete" ? "of 7 days" : "of the time on record") : week?.state === "early" ? "Too early to say" : "No record",
        href: registryHref(v.id),
      };
    })
    .filter((r) => r.id)
    .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const sameRun = (a, e) => a.ok === e.ok && a.simulated === !!e.simulated && a.version === versionOf(e.measurements) && (a.ok || a.reason === (e.reason?.code || "")) && !e.measurement_changed;

/**
 * Attestation events (newest first, as the history API pages them) as a timeline, newest first: runs of the same
 * outcome and measurement folded into one span, each measurement change its own entry.
 */
export function describeHistory(events, now = Date.now()) {
  const spans = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.kind !== "attestation" || !Number.isFinite(Date.parse(e.at || ""))) continue;
    const last = spans[spans.length - 1];
    // Events arrive newest first; a change event starts (in time) the span it heads, so it closes the span above it.
    if (last && sameRun(last, e) && !last.changed) {
      last.from = e.at;
      last.count++;
      continue;
    }
    const version = versionOf(e.measurements);
    spans.push({
      ok: !!e.ok,
      simulated: !!e.simulated,
      changed: !!e.measurement_changed,
      version,
      reason: e.ok ? "" : e.reason?.code || "other",
      reasonText: e.ok ? "" : e.reason?.message || "The check failed.",
      measurements: e.measurements && typeof e.measurements === "object" ? e.measurements : null,
      verifiers: Array.isArray(e.verifiers) ? e.verifiers : [],
      from: e.at,
      to: e.at,
      count: 1,
    });
  }
  return spans.map((s) => ({
    ...s,
    kind: !s.ok ? "failed" : s.simulated ? "simulated" : s.changed ? "changed" : "passed",
    title: !s.ok ? "Check failed" : s.simulated ? "Simulated evidence" : s.changed ? "Measurement changed" : s.count > 1 ? `${s.count} checks passed` : "Check passed",
    text: !s.ok ? s.reasonText : s.simulated ? "Development evidence. Nothing about it is verified." : s.version ? `Measurement ${shortDigest(s.version)}` : "No measurement digests recorded for this check.",
    when: s.count > 1 ? `${ago(s.from, now)} to ${ago(s.to, now)}` : ago(s.to, now),
    digests: s.measurements ? Object.entries(s.measurements).map(([k, v]) => ({ key: k, label: fieldLabel(k), value: String(v) })) : [],
  }));
}

/** The distinct measurement versions in a history, newest first, with when each was first and last seen verified. */
export function measurementVersions(events) {
  const seen = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e?.ok || e.simulated || e.kind !== "attestation") continue;
    const v = versionOf(e.measurements);
    if (!v) continue;
    const cur = seen.get(v);
    if (!cur) seen.set(v, { version: v, short: shortDigest(v), first: e.at, last: e.at, runs: 1 });
    else {
      cur.first = e.at;
      cur.runs++;
    }
  }
  return [...seen.values()];
}

export { verifyHref };
