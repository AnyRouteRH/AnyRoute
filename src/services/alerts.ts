import { upstreamAlertChecks } from "../rush/monitor.ts"; // ON3
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { readiness } from "./readiness.ts";

// Readiness-driven alert delivery for platforms without Alertmanager (for example Railway).
// Each minute one worker evaluates readiness. A check that has failed for ALERT_SUSTAIN_MS is
// announced once; its recovery is announced once. State lives in the kv table and a short
// lease serializes evaluation, so replicas and separate worker services never double-send.
// Delivery is at-least-once: a crash between delivery and the state write can repeat a notice.
// Messages carry only check names, states and timestamps: never URLs, hosts, secrets or errors.

export const ALERT_INTERVAL_MS = 60_000;
export const ALERT_SUSTAIN_MS = 120_000;
export const ALERT_STATE_KEY = "alerts:state";
export const ALERT_LEASE_KEY = "alerts:lease";
const LEASE_MS = 55_000;
const CHECK_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export type AlertFormat = "ntfy" | "slack" | "discord" | "json";
export type CheckState = { ok: boolean; since: string; firing: boolean; notified: "ok" | "failing" };
export type AlertState = { v: 1; evaluated_at: string; checks: Record<string, CheckState> };
export type Transition = { check: string; state: "failing" | "recovered" | "test"; since: string };
export type AlertMessage = { kind: "alert" | "test"; environment: string; at: string; transitions: Transition[] };

/** Readiness names are fixed identifiers; anything else is folded into one anonymous check. */
function sanitize(observed: Record<string, boolean>) {
  const out: Record<string, boolean> = {};
  for (const [name, ok] of Object.entries(observed)) {
    const key = CHECK_NAME.test(name) ? name : "unnamed_check";
    out[key] = (out[key] ?? true) && ok === true;
  }
  return out;
}

function parseState(value: unknown): AlertState | null {
  const state = value as AlertState | null;
  if (!state || state.v !== 1 || typeof state.checks !== "object" || !state.checks) return null;
  const checks: Record<string, CheckState> = {};
  for (const [name, c] of Object.entries(state.checks)) {
    if (!CHECK_NAME.test(name) && name !== "unnamed_check") continue;
    if (!c || typeof c.ok !== "boolean" || typeof c.since !== "string" || !Number.isFinite(Date.parse(c.since))) continue;
    checks[name] = { ok: c.ok, since: c.since, firing: c.firing === true, notified: c.notified === "failing" ? "failing" : "ok" };
  }
  return { v: 1, evaluated_at: typeof state.evaluated_at === "string" ? state.evaluated_at : new Date(0).toISOString(), checks };
}

/** Pure transition planner: which checks must be announced now, and the next persisted state. */
export function planAlerts(prev: AlertState | null | undefined, observed: Record<string, boolean>, now: number, sustainMs = ALERT_SUSTAIN_MS) {
  const at = new Date(now).toISOString();
  const obs = sanitize(observed);
  const names = [...new Set([...Object.keys(prev?.checks ?? {}), ...Object.keys(obs)])].sort();
  const checks: Record<string, CheckState> = {};
  const transitions: Transition[] = [];
  for (const name of names) {
    const ok = obs[name] ?? true; // A check that is no longer reported is not failing.
    const before = prev?.checks[name];
    const since = before && before.ok === ok ? before.since : at;
    const notified = before?.notified === "failing" ? "failing" : "ok";
    const firing = !ok && now - Date.parse(since) >= sustainMs;
    const desired = firing ? "failing" : ok ? "ok" : notified;
    if (desired !== notified) transitions.push({ check: name, state: desired === "failing" ? "failing" : "recovered", since });
    if (!(name in obs) && notified === "ok") continue; // Forget checks that disappeared quietly.
    checks[name] = { ok, since, firing, notified };
  }
  return { state: { v: 1 as const, evaluated_at: at, checks }, transitions };
}

export function markDelivered(state: AlertState, transitions: Transition[]) {
  for (const t of transitions) {
    const c = state.checks[t.check];
    if (c && t.state !== "test") c.notified = t.state === "failing" ? "failing" : "ok";
  }
  return state;
}

/** ALERT_WEBHOOK_FORMAT wins; otherwise well-known webhook hosts are recognised and anything else gets JSON. */
export function resolveFormat(url: string, explicit?: AlertFormat): AlertFormat {
  if (explicit) return explicit;
  try {
    const u = new URL(url);
    if (u.hostname === "ntfy.sh") return "ntfy";
    if (u.hostname === "hooks.slack.com") return "slack";
    if (/^(?:[a-z]+\.)?discord(?:app)?\.com$/.test(u.hostname) && u.pathname.startsWith("/api/webhooks/")) return "discord";
  } catch { /* fall through */ }
  return "json";
}

export function renderAlert(format: AlertFormat, msg: AlertMessage): { headers: Record<string, string>; body: string } {
  const failing = msg.transitions.filter((t) => t.state === "failing").length;
  const recovered = msg.transitions.filter((t) => t.state === "recovered").length;
  const env = /^[a-z]{1,16}$/.test(msg.environment) ? msg.environment : "unknown";
  const title = msg.kind === "test"
    ? `AnyRoute ${env} alert drill: synthetic test, no action needed`
    : `AnyRoute ${env}: ${[failing ? `${failing} check${failing === 1 ? "" : "s"} failing` : "", recovered ? `${recovered} recovered` : ""].filter(Boolean).join(", ")}`;
  const label = { failing: "FAILING", recovered: "RECOVERED", test: "TEST" } as const;
  const line = (t: Transition, code: boolean) => `${label[t.state]} ${code ? `\`${t.check}\`` : t.check} (since ${t.since})`;
  const footer = msg.kind === "test" ? "This is a delivery drill. No AnyRoute check changed state." : "Check names only; details are in the private operator logs and /ready.";
  if (format === "ntfy")
    return {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        title,
        priority: msg.kind === "test" ? "low" : failing ? "urgent" : "default",
        tags: msg.kind === "test" ? "test_tube" : failing ? "rotating_light" : "white_check_mark",
      },
      body: [...msg.transitions.map((t) => line(t, false)), footer].join("\n"),
    };
  if (format === "slack") return { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: [`*${title}*`, ...msg.transitions.map((t) => line(t, true)), `_${footer}_`].join("\n") }) };
  if (format === "discord")
    return { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: [`**${title}**`, ...msg.transitions.map((t) => line(t, true)), footer].join("\n").slice(0, 1900), allowed_mentions: { parse: [] } }) };
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "anyroute", kind: msg.kind, environment: env, title, at: msg.at, checks: msg.transitions.map((t) => ({ name: t.check, state: t.state, since: t.since })) }),
  };
}

/** Never logs or returns the URL, response body or exception text. */
export async function deliverAlert(url: string, format: AlertFormat, msg: AlertMessage, fetchImpl: typeof fetch = fetch) {
  const { headers, body } = renderAlert(format, msg);
  try {
    const response = await fetchImpl(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status as number | null };
  } catch {
    return { ok: false, status: null as number | null };
  }
}

async function acquireLease(ctx: Ctx, holder: string, now: number) {
  const value = { holder, until: now + LEASE_MS };
  const rows = await ctx.db.insert(kv).values({ key: ALERT_LEASE_KEY, value })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() }, setWhere: sql`coalesce((${kv.value}->>'until')::bigint, 0) < ${now}::bigint` })
    .returning({ key: kv.key });
  return rows.length > 0;
}

async function releaseLease(ctx: Ctx, holder: string) {
  await ctx.db.delete(kv).where(and(eq(kv.key, ALERT_LEASE_KEY), sql`${kv.value}->>'holder' = ${holder}`)).catch(() => undefined);
}

async function evaluateReadiness(ctx: Ctx) {
  return { ...(await readiness(ctx)).checks, ...await upstreamAlertChecks(ctx) }; // ON3
}

export type NotifierOptions = { now?: () => number; evaluate?: (ctx: Ctx) => Promise<Record<string, boolean>>; fetch?: typeof fetch; sustainMs?: number };

export async function runAlertNotifier(ctx: Ctx, opts: NotifierOptions = {}) {
  const now = opts.now ?? Date.now;
  const holder = randomUUID();
  if (!(await acquireLease(ctx, holder, now()))) return { skipped: "another replica is evaluating alerts" };
  let deliveryFailed = false;
  try {
    let observed: Record<string, boolean>;
    try { observed = await (opts.evaluate ?? evaluateReadiness)(ctx); } catch { observed = { readiness_evaluation: false }; }
    const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, ALERT_STATE_KEY));
    const t = now();
    const { state, transitions } = planAlerts(parseState(row?.value), observed, t, opts.sustainMs);
    const url = ctx.cfg.alerts.webhookUrl;
    if (transitions.length && url) {
      const msg: AlertMessage = { kind: "alert", environment: ctx.cfg.env, at: new Date(t).toISOString(), transitions };
      const result = await deliverAlert(url, resolveFormat(url, ctx.cfg.alerts.webhookFormat), msg, opts.fetch);
      if (result.ok) markDelivered(state, transitions);
      else {
        deliveryFailed = true;
        log.warn("alert webhook delivery failed; it will be retried", { status: result.status, notices: transitions.length });
      }
    }
    // Without a webhook the job only records state: firing checks stay visible in kv for operators.
    await ctx.db.insert(kv).values({ key: ALERT_STATE_KEY, value: state }).onConflictDoUpdate({ target: kv.key, set: { value: state, updatedAt: new Date() } });
    if (deliveryFailed) throw new Error("Alert webhook delivery failed.");
    return {
      firing: Object.entries(state.checks).filter(([, c]) => c.firing).map(([name]) => name),
      notices: transitions.length,
      delivered: !!url && transitions.length > 0,
      webhook: !!url,
    };
  } finally {
    await releaseLease(ctx, holder);
  }
}
