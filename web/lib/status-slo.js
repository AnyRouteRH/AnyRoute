// Status page: pure helpers (no React), shared by components/StatusBoard.jsx and its tests.
// They turn `GET /api/v1/status/slo` and `GET /api/v1/attestation/summary` into what the page shows. A share is truncated,
// never rounded up; a day or window without data says "no data" instead of looking healthy; and a private lane's figure is
// always labelled as noisy.

export const SLO_PATH = "/api/v1/status/slo";
export const ATTESTATION_PATH = "/api/v1/attestation/summary";
export const FEEDS = { atom: "/api/v1/status/incidents.atom", rss: "/api/v1/status/incidents.rss" };
export const REFRESH_MS = 30_000;
export const WINDOWS = ["1h", "24h", "7d", "30d"];
export const WINDOW_LABEL = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

const LANE = {
  public: { name: "Public", blurb: "Any provider. Counted from each request’s outcome, never its content." },
  attested: { name: "Attested", blurb: "Confidential hardware the router verified. Counted only through noisy hourly totals." },
  unlinkable: { name: "Unlinkable", blurb: "Attested, reached without your address. Counted only through noisy hourly totals." },
};
const SURFACE = { chat: "Chat and Responses", embeddings: "Embeddings", batch: "Batch", messages: "Anthropic Messages", ollama: "Ollama", rerank: "Rerank" };
const STATE = {
  operational: { tone: "ok", label: "Operational" },
  degraded: { tone: "warn", label: "Degraded" },
  outage: { tone: "bad", label: "Outage" },
  no_data: { tone: "none", label: "No data" },
};
const INCIDENT = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };

export const laneName = (l) => LANE[l]?.name ?? String(l);
export const surfaceName = (s) => SURFACE[s] ?? String(s);
export const stateView = (s) => STATE[s] ?? STATE.no_data;

/** "99.95%": truncated to two decimals, so 99.999% reads 99.99% and only a perfect share reads 100%. "" for a non-share. */
export function formatPct(x) {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return "";
  const v = Math.floor(Math.min(1, x) * 10_000 + 1e-9) / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0$/, "")}%`;
}

/** "at most 500 ms", "at most 2.5 s"; the percentile is the upper edge of its bucket. */
export function latencyText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  return ms < 1000 ? `≤ ${ms} ms` : `≤ ${Number((ms / 1000).toFixed(1))} s`;
}

/** One solid bar per day: at or above target, a small dip, a real drop, or no data. */
export function stripCells(daily, target) {
  return (Array.isArray(daily) ? daily : []).map((d) => {
    const a = d?.availability;
    const kind = typeof a !== "number" ? "none" : a >= target ? "ok" : a >= 0.95 ? "dip" : "bad";
    return { day: d?.day ?? "", kind, text: `${d?.day ?? ""}: ${typeof a === "number" ? formatPct(a) : "no data"}` };
  });
}

/** The error budget as a share left, with a sentence. */
export function budgetView(b) {
  if (!b || typeof b.remaining !== "number") return { pct: null, text: "No requests in the last 30 days, so no budget is spent." };
  const left = Math.max(0, Math.min(1, b.remaining));
  const failures = Math.round(b.failures);
  const allowed = Math.round(b.allowed_failures);
  return {
    pct: Math.floor(left * 1000) / 10,
    exhausted: !!b.exhausted,
    text: b.exhausted ? `Spent: ${failures} failed requests against ${allowed} allowed over 30 days.` : `${failures} failed of ${allowed} allowed over 30 days.`,
  };
}

/** A headline for the whole page from the lanes' states. */
export function headline(lanes) {
  const bad = (lanes ?? []).filter((l) => l.state === "outage" || l.state === "degraded");
  if (!lanes?.length) return { tone: "none", text: "No status yet" };
  if (!bad.length) return lanes.every((l) => l.state === "no_data") ? { tone: "none", text: "No traffic measured yet" } : { tone: "ok", text: "All lanes operational" };
  return { tone: bad.some((l) => l.state === "outage") ? "bad" : "warn", text: `${bad.map((l) => laneName(l.lane)).join(" and ")} ${bad.length > 1 ? "are" : "is"} ${bad.some((l) => l.state === "outage") ? "having an outage" : "degraded"}` };
}

export function laneView(l) {
  const windows = WINDOWS.map((w) => {
    const x = l.windows?.[w] ?? {};
    return { name: w, label: WINDOW_LABEL[w], pct: formatPct(x.availability), eligible: x.eligible ?? 0 };
  });
  return {
    id: l.lane,
    name: laneName(l.lane),
    blurb: LANE[l.lane]?.blurb ?? "",
    state: stateView(l.state),
    noisy: l.source === "dp-noised",
    target: formatPct(l.target),
    headline: windows.find((w) => w.name === "30d")?.pct || "",
    windows,
    strip: stripCells(l.daily, l.target),
    p50: latencyText(l.latency_24h?.p50_ms),
    p95: latencyText(l.latency_24h?.p95_ms),
    measure: l.latency_24h?.measure ?? "",
    budget: budgetView(l.error_budget),
  };
}

export function surfaceView(s) {
  const d = s.windows?.["24h"] ?? {};
  return {
    id: s.surface,
    name: surfaceName(s.surface),
    state: stateView(s.state),
    day: formatPct(d.availability) || "no data",
    p50: latencyText(s.latency_24h?.p50_ms) || "no data",
    p95: latencyText(s.latency_24h?.p95_ms) || "no data",
    errors: typeof d.errors?.server_error_rate === "number" ? formatPct(d.errors.server_error_rate) : "no data",
  };
}

const when = (iso) => (iso ? new Date(iso).toISOString().replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC") : "");

export function incidentView(i) {
  return {
    id: i.id,
    anchor: `incident-${i.id}`,
    title: i.title,
    status: INCIDENT[i.status] ?? i.status,
    open: i.status !== "resolved",
    impact: i.impact,
    scope: [(i.lanes ?? []).map(laneName).join(", "), (i.surfaces ?? []).length ? (i.surfaces ?? []).map(surfaceName).join(", ") : ""].filter(Boolean).join(" · "),
    started: when(i.started_at),
    resolved: when(i.resolved_at),
    updates: (i.updates ?? []).map((u) => ({ at: when(u.at), status: INCIDENT[u.status] ?? u.status, text: u.text })),
  };
}

/** The SLO document as the page shows it. */
export function describeSlo(d) {
  if (!d || !Array.isArray(d.lanes)) return null;
  const recent = (d.incidents?.recent ?? []).map(incidentView);
  return {
    generatedAt: d.generated_at,
    headline: headline(d.lanes),
    lanes: d.lanes.map(laneView),
    surfaces: (d.surfaces ?? []).map(surfaceView),
    open: (d.incidents?.open ?? []).map(incidentView),
    history: recent.filter((i) => !i.open),
  };
}

const DAY = 86_400_000;
/**
 * Advisories about the trusted computing base, from the proof-time summary: a provider the router cannot verify right now,
 * a measurement change in the last 7 days (new software in the enclave), and a failed check in the last 24 hours.
 */
export function advisories(summary, now = Date.now()) {
  const out = [];
  for (const p of summary?.providers ?? []) {
    const name = p.name || p.provider;
    if (p.status === "unverified") out.push({ tone: "bad", provider: p.provider, text: `${name}: the router holds no current verification, so the attested lanes do not route to it.` });
    const change = p.last_measurement_change;
    if (change?.at && now - Date.parse(change.at) < 7 * DAY) out.push({ tone: "warn", provider: p.provider, text: `${name}: measured software changed on ${change.at.slice(0, 10)} (${(change.changed ?? []).join(", ") || "measurement"}). Check the new digests against the published build.` });
    const fail = p.last_failure;
    if (p.status === "attested" && fail?.at && now - Date.parse(fail.at) < DAY) out.push({ tone: "warn", provider: p.provider, text: `${name}: a check failed on ${fail.at.slice(0, 16).replace("T", " ")} UTC and later passed.` });
  }
  return out;
}
