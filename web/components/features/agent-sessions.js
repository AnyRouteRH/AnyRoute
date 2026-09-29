// Pure helpers for the Agent Sessions tab (formatting, validation, sample content). No DOM, no fetch.

export const LIMITS = { maxBudget: 1000, minTtl: 1, maxTtl: 1440, defaultTtl: 60, maxName: 80, maxModels: 50 };
export const TTL_PRESETS = [
  [15, "15m"],
  [60, "1h"],
  [240, "4h"],
  [1440, "24h"],
];
export const REFRESH_MS = 5000;

const STATUS = {
  active: { label: "Active", tone: "active" },
  ended: { label: "Ended", tone: "ended" },
  expired: { label: "Expired", tone: "stopped" },
  budget_exhausted: { label: "Budget spent", tone: "stopped" },
};
export const statusMeta = (status) => STATUS[status] || { label: String(status || "Unknown"), tone: "ended" };

/** USD with enough decimals to show sub-cent agent spend. */
export function formatUsd(n) {
  const v = Number(n) || 0;
  const digits = v === 0 ? 2 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Countdown text: 42s, 12m 05s, 3h 07m. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Relative time for "last call": just now, 12s ago, 4m ago, 2h ago, 3d ago. */
export function formatAgo(iso, now = Date.now()) {
  if (!iso) return "No calls yet";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "—";
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Percentages for the spend-vs-budget bar: settled spend plus in-flight holds, clamped to 100. */
export function spendShare(spent, reserved, budget) {
  const b = Number(budget) || 0;
  if (b <= 0) return { spent: 0, reserved: 0 };
  const sp = Math.min(100, Math.max(0, (100 * (Number(spent) || 0)) / b));
  const rs = Math.min(100 - sp, Math.max(0, (100 * (Number(reserved) || 0)) / b));
  return { spent: sp, reserved: rs };
}

/** Share of the session's lifetime already used (0-100). */
export function timeShare(createdAt, expiresAt, secondsLeft) {
  const total = (Date.parse(expiresAt) - Date.parse(createdAt)) / 1000;
  if (!Number.isFinite(total) || total <= 0) return 100;
  return Math.min(100, Math.max(0, 100 - (100 * Math.max(0, secondsLeft)) / total));
}

/** Seconds left from a deadline measured on this device's clock (avoids client/server clock skew). */
export const secondsLeft = (deadline, now = Date.now()) => Math.max(0, Math.floor((deadline - now) / 1000));

/** Shell lines an agent run can source. */
export function envSnippet(key, apiBase) {
  const base = String(apiBase || "").replace(/\/$/, "");
  return `ANYROUTE_API_KEY=${key}\nANYROUTE_BASE_URL=${base}/api/v1`;
}

/** Client-side checks mirroring the API (the router validates again). Returns an error message or "". */
export function validateForm({ name = "", budget, ttl }) {
  const b = Number(budget);
  const t = Number(ttl);
  if (String(name).trim().length > LIMITS.maxName) return `Keep the name to ${LIMITS.maxName} characters.`;
  if (budget === "" || !Number.isFinite(b) || b <= 0 || b > LIMITS.maxBudget) return `Set a budget greater than 0 and up to ${LIMITS.maxBudget.toLocaleString("en-US")} USDG.`;
  if (ttl === "" || !Number.isInteger(t) || t < LIMITS.minTtl || t > LIMITS.maxTtl) return `Set a time limit of ${LIMITS.minTtl} to ${LIMITS.maxTtl.toLocaleString("en-US")} whole minutes (24 hours).`;
  return "";
}

/** POST /api/v1/sessions body. An empty allowlist means "the creating key's models". */
export function createBody({ name = "", budget, ttl, models = [] }) {
  const body = { budget_usd: Number(budget), ttl_minutes: Number(ttl) };
  if (String(name).trim()) body.name = String(name).trim();
  if (models.length) body.allowed_models = [...new Set(models)].slice(0, LIMITS.maxModels);
  return body;
}

/** Saved routes from GET /api/v1/routes, as allowlist entries. Tolerates any list shape; skips bad rows. */
export function routeOptions(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return rows
    .filter((r) => typeof r?.slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(r.slug))
    .map((r) => ({ id: "@route/" + r.slug, name: typeof r.name === "string" && r.name ? r.name : r.slug }));
}

/** Local deadline for each session so countdowns tick between refreshes. */
export function withDeadlines(sessions, fetchedAt = Date.now()) {
  return (sessions || []).map((s) => ({ ...s, deadline: fetchedAt + (Number(s.time_left_s) || 0) * 1000 }));
}

// ---- sample workspace: clearly labelled illustrations, never presented as live data ----
const at = (base, s) => new Date(base + s * 1000).toISOString();
export function sampleSessions(now = Date.now()) {
  const call = (id, s, model, provider, tin, tout, cost, ms) => ({ id: "sample-" + id, ts: at(now, s), model, provider, tokens_in: tin, tokens_out: tout, cost_usd: cost, latency_ms: ms, finish_reason: "stop", receipt: false, anchored: false });
  return [
    {
      id: "sample-research",
      sample: true,
      name: "Research agent · sample",
      status: "active",
      key_label: "sample key",
      created_by: "sample owner key",
      budget_usd: 2,
      spent_usd: 0.4182,
      reserved_usd: 0.0125,
      remaining_usd: 1.5818,
      calls: 37,
      last_call_at: at(now, -14),
      allowed_models: ["meta-llama/llama-3.3-70b-instruct", "qwen/qwen3-32b"],
      metadata: { run: "sample-001" },
      created_at: at(now, -18 * 60),
      expires_at: at(now, 42 * 60),
      time_left_s: 42 * 60,
      ended_at: null,
      end_reason: null,
      recent_calls: [call(3, -14, "qwen/qwen3-32b", "Sample provider A", 1840, 212, 0.00049, 910), call(2, -71, "meta-llama/llama-3.3-70b-instruct", "Sample provider B", 2210, 388, 0.00127, 1430), call(1, -160, "qwen/qwen3-32b", "Sample provider A", 960, 140, 0.00027, 780)],
    },
    {
      id: "sample-triage",
      sample: true,
      name: "Ticket triage · sample",
      status: "budget_exhausted",
      key_label: "sample key",
      created_by: "sample owner key",
      budget_usd: 0.5,
      spent_usd: 0.5,
      reserved_usd: 0,
      remaining_usd: 0,
      calls: 212,
      last_call_at: at(now, -9 * 60),
      allowed_models: [],
      metadata: null,
      created_at: at(now, -75 * 60),
      expires_at: at(now, 45 * 60),
      time_left_s: 0,
      ended_at: at(now, -9 * 60),
      end_reason: "budget",
      recent_calls: [call(4, -9 * 60, "meta-llama/llama-3.3-70b-instruct", "Sample provider B", 3020, 512, 0.00181, 1610)],
    },
    {
      id: "sample-nightly",
      sample: true,
      name: "Nightly eval · sample",
      status: "ended",
      key_label: "sample key",
      created_by: "sample owner key",
      budget_usd: 5,
      spent_usd: 1.2034,
      reserved_usd: 0,
      remaining_usd: 0,
      calls: 96,
      last_call_at: at(now, -3 * 3600),
      allowed_models: ["qwen/qwen3-32b"],
      metadata: null,
      created_at: at(now, -5 * 3600),
      expires_at: at(now, 19 * 3600),
      time_left_s: 0,
      ended_at: at(now, -3 * 3600 + 30),
      end_reason: "ended",
      recent_calls: [],
    },
  ];
}
