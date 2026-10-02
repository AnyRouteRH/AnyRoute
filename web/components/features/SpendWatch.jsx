"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Button, CopyButton, Modal } from "../UI";
import styles from "./SpendWatch.module.css";

/**
 * Spend Watch workspace tab. Props (from Dashboard): { live, apiKey, ws, status, catalog, refresh, notify, fail, navigate }.
 * Live: GET /api/v1/spend and /api/v1/spend/alerts for the signed-in key (billing metadata only, UTC days).
 * live=false is the explicit sample workspace: every figure is generated here and labelled as sample.
 */

// ---- spend-watch pure helpers: begin (plain JS; web/tests/spend-watch.test.mjs loads this block) ----
export const PERIODS = ["7d", "30d", "90d"];
export const MAX_ATTEMPTS = 3;
const DAY_MS = 86400000;

export function formatUsd(value) {
  const n = Number(value) || 0;
  const a = Math.abs(n);
  const max = a === 0 || a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return (n < 0 ? "-$" : "$") + a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: max });
}

/** Short axis labels: $0, $0.05, $2.5, $40, $1.2K. */
export function axisUsd(value) {
  const n = Number(value) || 0;
  if (n === 0) return "$0";
  if (n >= 1000) return "$" + (n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "K";
  return "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

/** A 0-based axis with round steps (1, 2, 2.5 or 5 x 10^k) covering `max`. */
export function niceScale(max, count = 4) {
  if (!(max > 0)) return { max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = step * Math.ceil(max / step - 1e-9);
  const ticks = [];
  for (let i = 0; i <= Math.round(top / step); i++) ticks.push(Number((i * step).toPrecision(12)));
  return { max: top, step, ticks };
}

/** Label every k-th day so labels keep at least `minGap` px apart. */
export const labelEvery = (n, width, minGap = 64) => Math.max(1, Math.ceil(n / Math.max(1, Math.floor(width / minGap))));

const asDate = (iso) => new Date(String(iso).length === 10 ? iso + "T00:00:00Z" : iso);
export const shortDate = (iso) => asDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const longDate = (iso) => asDate(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const dateTime = (iso) => asDate(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";

export const budgetLevel = (pct) => (pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok");
export const keyName = (k) => (k ? k.name || k.label || "Key" : "Whole account");

const WINDOW_WORD = { day: "per day", week: "per week", month: "per month", lifetime: "over its lifetime" };
export function describeRule(r) {
  if (r.kind === "threshold") return `Spend ≥ ${formatUsd(r.threshold_usd)} ${WINDOW_WORD[r.window] || "per " + r.window}`;
  if (r.kind === "budget_pct") return `Budget ≥ ${r.pct}% used`;
  return `Day spend ≥ ${Number(r.multiplier ?? 3).toLocaleString("en-US")}× the 7-day average`;
}
export const ruleScope = (r) => (r.key_hash ? r.key_name || r.key_label || "One key" : "Whole account");

export function firingText(f) {
  if (f.kind === "threshold") return `${formatUsd(f.value_usd)} spent ${f.window === "day" ? "today" : "this " + f.window} (limit ${formatUsd(f.threshold_usd)})`;
  if (f.kind === "budget_pct") return `${f.pct}% of budget used (${formatUsd(f.value_usd)})`;
  return `${formatUsd(f.value_usd)} today${f.pct ? ` · ${(f.pct / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}× the average` : " · no spend the week before"}`;
}

const REASONS = { timeout: "timed out", network: "network error", destination_blocked: "destination is not public", undecryptable: "URL must be entered again", no_result: "no result recorded" };
const reason = (d) => (d.http_status ? "HTTP " + d.http_status : REASONS[d.error] || d.error || "error");
/** Delivery status in words, and a tone: ok | wait | bad | off. */
export function deliveryText(d) {
  const max = d.max_attempts || MAX_ATTEMPTS;
  if (d.status === "delivered") return { tone: "ok", text: d.attempts > 1 ? `Delivered on attempt ${d.attempts}` : "Delivered" };
  if (d.status === "pending") return { tone: "wait", text: d.attempts ? `Retrying · attempt ${d.attempts} of ${max} failed (${reason(d)})` : "Queued" };
  if (d.status === "failed") return { tone: "bad", text: `Failed after ${d.attempts} attempt${d.attempts === 1 ? "" : "s"} (${reason(d)})` };
  if (d.status === "blocked") return { tone: "bad", text: `Not sent: ${reason(d)}` };
  if (d.status === "cancelled") return { tone: "off", text: "Cancelled" };
  return { tone: "off", text: "No webhook" };
}

export function emptyForm(rule, ownKey) {
  return {
    kind: rule?.kind || "threshold",
    window: rule?.kind === "threshold" ? rule.window : "day",
    threshold: rule?.threshold_usd != null ? String(rule.threshold_usd) : "",
    pct: rule?.pct != null ? String(rule.pct) : "80",
    multiplier: rule?.multiplier != null ? String(rule.multiplier) : "3",
    key: rule ? rule.key_hash || "" : ownKey || "",
    webhook: "", // never pre-filled: the saved URL is only ever shown masked
    removeWebhook: false,
    enabled: rule ? !!rule.enabled : true,
  };
}

/** Client-side checks (the router re-validates everything, including the webhook destination). */
export function formProblem(f) {
  if (f.kind === "threshold" && !(Number(f.threshold) > 0)) return "Enter the spend that triggers the alert, in USD.";
  if (f.kind === "budget_pct") {
    if (!f.key) return "Choose the key whose budget to watch.";
    if (!/^\d+$/.test(String(f.pct).trim()) || Number(f.pct) < 1 || Number(f.pct) > 1000) return "Use a whole percentage from 1 to 1000.";
  }
  if (f.kind === "anomaly" && !(Number(f.multiplier) >= 1.1 && Number(f.multiplier) <= 100)) return "Use a multiplier from 1.1 to 100.";
  const url = f.webhook.trim();
  if (url && !/^https:\/\//i.test(url)) return "The webhook must be an https:// URL.";
  return "";
}

/** The request body for POST (new) or PATCH (edit) /api/v1/spend/alerts. */
export function ruleBody(f, editing) {
  const body = editing ? {} : { kind: f.kind };
  if (f.kind === "threshold") Object.assign(body, { window: f.window, threshold_usd: Number(f.threshold) });
  if (f.kind === "budget_pct") body.pct = Number(f.pct);
  if (f.kind === "anomaly") body.multiplier = Number(f.multiplier);
  body.key_hash = f.key || null;
  const url = f.webhook.trim();
  if (url) body.webhook_url = url;
  else if (editing && f.removeWebhook) body.webhook_url = null;
  body.enabled = !!f.enabled;
  return body;
}

/** Deterministic sample workspace, shaped like the API responses and marked `sample`. */
export function sampleData(period, now) {
  const days = { "7d": 7, "30d": 30, "90d": 90 }[period] || 30;
  const today0 = Math.floor(now / DAY_MS) * DAY_MS;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const r2 = (v) => Math.round(v * 100) / 100;
  const costOn = (t) => {
    if (t === today0) return 11.84; // a spike, to show the anomaly banner
    const d = t / DAY_MS;
    const dow = new Date(t).getUTCDay();
    return r2((dow === 0 || dow === 6 ? 1.1 : 2.4) * (1 + 0.3 * Math.sin(d / 4.3)) + (d % 5) * 0.09);
  };
  const sum = (from, to) => {
    let s = 0;
    for (let t = from; t <= to; t += DAY_MS) s += costOn(t);
    return r2(s);
  };
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const dom = d.getUTCDate();
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = today0 - i * DAY_MS;
    series.push({ date: iso(t), cost_usd: costOn(t), requests: Math.round(costOn(t) * 137) });
  }
  const periodUsd = r2(series.reduce((s, x) => s + x.cost_usd, 0));
  const periodRequests = series.reduce((s, x) => s + x.requests, 0);
  const mtd = sum(monthStart, today0);
  const trailing = sum(today0 - 7 * DAY_MS, today0 - DAY_MS);
  const split = (parts) => parts.map(([id, share, extra]) => ({ id, ...extra, cost_usd: r2(periodUsd * share), requests: Math.round(periodRequests * share), share }));
  const keys = [
    ["sample-key-research", 0.52, { name: "Research agent", label: "sample key · research" }],
    ["sample-key-support", 0.31, { name: "Support bot", label: "sample key · support" }],
    ["sample-key-batch", 0.17, { name: "Nightly batch", label: "sample key · batch" }],
  ];
  const at = (daysAgo, h) => new Date(today0 - daysAgo * DAY_MS + h * 3600000).toISOString();
  const delivery = (status, attempts, http) => ({ status, attempts, max_attempts: MAX_ATTEMPTS, last_attempt_at: null, http_status: http, error: http && http >= 300 ? "http_" + http : null });
  return {
    sample: true,
    report: {
      sample: true,
      scope: "account",
      period,
      range: { from: series[0].date, to: series.at(-1).date },
      totals: { today_usd: costOn(today0), last_7d_usd: sum(today0 - 6 * DAY_MS, today0), month_to_date_usd: mtd, projected_month_usd: r2((mtd / dom) * dim), period_usd: periodUsd, period_requests: periodRequests, day_of_month: dom, days_in_month: dim },
      anomaly: { flagged: true, today_usd: costOn(today0), trailing_daily_avg_usd: r2(trailing / 7), ratio: r2(costOn(today0) / (trailing / 7)), multiplier: 3, min_today_usd: 1 },
      series,
      breakdown: split([
        ["meta-llama/llama-3.3-70b-instruct", 0.46],
        ["qwen/qwen3-32b", 0.27],
        ["deepseek/deepseek-r1", 0.19],
        ["mistralai/mistral-small", 0.08],
      ]),
      byKey: split(keys),
      budgets: [
        { key_hash: "sample-key-batch", name: "Nightly batch", label: "sample key · batch", budget_usd: 5, spent_usd: 4.81, remaining_usd: 0.19, pct: 96.2, reset: "daily", resets_at: new Date(today0 + DAY_MS).toISOString(), disabled: false },
        { key_hash: "sample-key-research", name: "Research agent", label: "sample key · research", budget_usd: 150, spent_usd: r2(mtd * 0.52), remaining_usd: r2(150 - mtd * 0.52), pct: Math.round((mtd * 0.52 * 1000) / 150) / 10, reset: "monthly", resets_at: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(), disabled: false },
        { key_hash: "sample-key-support", name: "Support bot", label: "sample key · support", budget_usd: 60, spent_usd: 18.4, remaining_usd: 41.6, pct: 30.7, reset: "weekly", resets_at: new Date(today0 + (7 - ((d.getUTCDay() + 6) % 7)) * DAY_MS).toISOString(), disabled: false },
      ],
    },
    rules: [
      { id: "sample-rule-anomaly", kind: "anomaly", window: "day", key_hash: null, multiplier: 3, webhook_url: "https://hooks.example.com/…", enabled: true, last_fired_at: at(0, 9), history: [{ id: "sample-f1", alert_id: "sample-rule-anomaly", kind: "anomaly", window: "day", at: at(0, 9), period: "day:" + iso(today0), value_usd: 9.12, threshold_usd: 7.1, pct: 385, key_label: null, delivery: delivery("delivered", 1, 204) }] },
      { id: "sample-rule-budget", kind: "budget_pct", window: "day", key_hash: "sample-key-batch", key_name: "Nightly batch", pct: 80, webhook_url: "https://ops.example.org/…", enabled: true, last_fired_at: at(0, 3), history: [{ id: "sample-f2", alert_id: "sample-rule-budget", kind: "budget_pct", window: "day", at: at(0, 3), period: "budget:day:" + iso(today0), value_usd: 4.02, threshold_usd: 4, pct: 80.4, key_label: "sample key · batch", delivery: delivery("pending", 1, 503) }, { id: "sample-f3", alert_id: "sample-rule-budget", kind: "budget_pct", window: "day", at: at(1, 2), period: "budget:day:" + iso(today0 - DAY_MS), value_usd: 4.1, threshold_usd: 4, pct: 82, key_label: "sample key · batch", delivery: delivery("failed", 3, 500) }] },
      { id: "sample-rule-threshold", kind: "threshold", window: "month", key_hash: null, threshold_usd: 250, webhook_url: null, enabled: true, last_fired_at: null, history: [] },
    ],
  };
}
// ---- spend-watch pure helpers: end ----

function SpendChart({ series, sample, flagged }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(260, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setActive(null), [series]);

  const narrow = width < 520;
  const H = narrow ? 210 : 260;
  const pad = { l: narrow ? 46 : 58, r: 12, t: 18, b: 30 };
  const plotW = width - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const n = series.length;
  const scale = niceScale(Math.max(0, ...series.map((d) => d.cost_usd)));
  const band = plotW / n;
  const barW = Math.max(1, Math.min(26, band * (n > 45 ? 0.78 : 0.64)));
  const y = (v) => pad.t + plotH - (v / scale.max) * plotH;
  const every = labelEvery(n, plotW, narrow ? 56 : 68);
  const total = series.reduce((s, d) => s + d.cost_usd, 0);
  const peak = series.reduce((a, b) => (b.cost_usd > a.cost_usd ? b : a), series[0]);
  const cur = active != null ? series[active] : null;
  const cx = (i) => pad.l + i * band + band / 2;

  const pick = (clientX) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.floor((clientX - r.left - pad.l) / band);
    setActive(i >= 0 && i < n ? i : null);
  };
  const onKey = (e) => {
    const next = { ArrowRight: (active ?? n - 1) + 1, ArrowLeft: (active ?? n) - 1, Home: 0, End: n - 1 }[e.key];
    if (e.key === "Escape") return setActive(null);
    if (next === undefined) return;
    e.preventDefault();
    setActive(Math.min(n - 1, Math.max(0, next)));
  };

  return (
    <div className={styles.chart + (sample ? " " + styles.chartSample : "")} ref={wrapRef}>
      <svg
        ref={svgRef}
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        tabIndex={0}
        className={styles.svg}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={(e) => e.pointerType === "mouse" && document.activeElement !== svgRef.current && setActive(null)}
        onKeyDown={onKey}
        onFocus={() => active == null && setActive(n - 1)}
        onBlur={() => setActive(null)}
      >
        <title id={titleId}>{sample ? "Sample spend by day (not your data)" : "Spend by day, UTC"}</title>
        <desc id={descId}>
          {`${sample ? "Sample figures. " : ""}${formatUsd(total)} from ${longDate(series[0].date)} to ${longDate(series[n - 1].date)}; the highest day was ${longDate(peak.date)} at ${formatUsd(peak.cost_usd)}. Use the left and right arrow keys to read each day.`}
        </desc>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? styles.baseline : styles.grid} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
            <text className={styles.axis} x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {axisUsd(t)}
            </text>
          </g>
        ))}
        {series.map((d, i) => {
          const h = d.cost_usd > 0 ? Math.max(2, y(0) - y(d.cost_usd)) : 0;
          const today = i === n - 1;
          const cls = [styles.bar, today && styles.barToday, today && flagged && styles.barSpike, active === i && styles.barActive].filter(Boolean).join(" ");
          return <rect key={d.date} className={cls} x={cx(i) - barW / 2} y={y(0) - h} width={barW} height={h} style={{ "--i": i }} />;
        })}
        {cur && <line className={styles.cursor} x1={cx(active)} x2={cx(active)} y1={pad.t} y2={y(0)} />}
        {series.map((d, i) => {
          if ((n - 1 - i) % every !== 0) return null;
          const anchor = i === n - 1 ? "end" : i === 0 ? "start" : "middle";
          const x = anchor === "end" ? Math.min(width - pad.r, cx(i) + barW / 2) : anchor === "start" ? Math.max(pad.l, cx(i) - barW / 2) : cx(i);
          return (
            <text key={d.date} className={styles.axis} x={x} y={H - 9} textAnchor={anchor}>
              {i === n - 1 ? "Today" : shortDate(d.date)}
            </text>
          );
        })}
        {sample && (
          <text className={styles.watermark} x={width - pad.r - 6} y={pad.t + 14} textAnchor="end">
            SAMPLE
          </text>
        )}
      </svg>
      {cur && (
        <div className={styles.tooltip} style={{ left: Math.min(width - 84, Math.max(84, cx(active))) }} aria-hidden="true">
          <span>{longDate(cur.date)}{active === n - 1 ? " · so far" : ""}</span>
          <strong>{formatUsd(cur.cost_usd)}</strong>
          <span>{cur.requests.toLocaleString("en-US")} requests</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {cur ? `${longDate(cur.date)}: ${formatUsd(cur.cost_usd)}, ${cur.requests} requests.` : ""}
      </p>
      <table className="sr-only">
        <caption>{sample ? "Sample spend by day" : "Spend by day (UTC)"}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Spend</th>
            <th scope="col">Requests</th>
          </tr>
        </thead>
        <tbody>
          {series.map((d) => (
            <tr key={d.date}>
              <th scope="row">{longDate(d.date)}</th>
              <td>{formatUsd(d.cost_usd)}</td>
              <td>{d.requests}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Breakdown({ title, rows, empty, nameOf, subOf, note }) {
  const top = rows.slice(0, 8);
  const rest = rows.slice(8);
  const restCost = rest.reduce((s, r) => s + r.cost_usd, 0);
  return (
    <section className={styles.panel} aria-label={title}>
      <div className={styles.panelHead}>
        <h3>{title}</h3>
        {note && <span className="eyebrow">{note}</span>}
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table className={"data-table " + styles.breakdownTable}>
            <thead>
              <tr>
                <th>{title.replace(/^By /, "").replace(/^\w/, (c) => c.toUpperCase())}</th>
                <th className="num">Spend</th>
                <th className="num">Share</th>
                <th className="num">Requests</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r, i) => (
                <tr key={r.id} style={{ "--i": i }}>
                  <td className="cell-primary">
                    <strong>{nameOf(r)}</strong>
                    {subOf?.(r) && <small className="mono">{subOf(r)}</small>}
                  </td>
                  <td className="num" data-label="Spend">{formatUsd(r.cost_usd)}</td>
                  <td className="num" data-label="Share">
                    <span className={styles.share}>
                      <span className={styles.shareBar} aria-hidden="true">
                        <i style={{ width: Math.max(1, Math.round(r.share * 100)) + "%" }} />
                      </span>
                      {(r.share * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="num" data-label="Requests">{r.requests.toLocaleString("en-US")}</td>
                </tr>
              ))}
              {rest.length > 0 && (
                <tr>
                  <td className="cell-primary">
                    <strong>{rest.length} more</strong>
                  </td>
                  <td className="num" data-label="Spend">{formatUsd(restCost)}</td>
                  <td className="num" data-label="Share">{((rest.reduce((s, r) => s + r.share, 0)) * 100).toFixed(1)}%</td>
                  <td className="num" data-label="Requests">{rest.reduce((s, r) => s + r.requests, 0).toLocaleString("en-US")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.quiet}>{empty}</p>
      )}
    </section>
  );
}

function Budgets({ budgets, sample }) {
  return (
    <ul className={styles.budgets}>
      {budgets.map((b, i) => {
        const level = budgetLevel(b.pct);
        return (
          <li key={b.key_hash} className={styles.budget} data-level={level} style={{ "--i": i }}>
            <div className={styles.budgetHead}>
              <strong>{b.name || b.label}</strong>
              <span className={styles.budgetPct}>
                {b.pct.toFixed(1)}%{level === "over" ? " · over" : level === "warn" ? " · near limit" : ""}
              </span>
            </div>
            <div
              className={styles.meter}
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, b.pct)}
              aria-valuetext={`${b.pct.toFixed(1)}% of ${formatUsd(b.budget_usd)} used`}
              aria-label={`${sample ? "Sample budget" : "Budget"} used by ${b.name || b.label}`}
            >
              <i style={{ width: Math.min(100, b.pct) + "%" }} />
            </div>
            <div className={styles.budgetFoot}>
              <span className="mono">
                {formatUsd(b.spent_usd)} of {formatUsd(b.budget_usd)}
              </span>
              <span>{b.reset ? `${b.reset[0].toUpperCase() + b.reset.slice(1)} budget${b.resets_at ? " · resets " + shortDate(b.resets_at) : ""}` : "Lifetime budget"}</span>
            </div>
            {b.disabled && <span className="badge">Disabled key</span>}
          </li>
        );
      })}
    </ul>
  );
}

function RuleForm({ rule, keyOptions, management, ownKey, onSave, onClose }) {
  const [form, setForm] = useState(() => emptyForm(rule, management ? "" : ownKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const editing = !!rule;
  // A rule may watch a key that is no longer selectable (disabled); keep it on the list while editing.
  const known = rule?.key_hash && !keyOptions.some((k) => k.hash === rule.key_hash) ? [...keyOptions, { hash: rule.key_hash, name: rule.key_name, label: rule.key_label || "", limit: rule.kind === "budget_pct" ? 0 : null }] : keyOptions;
  const budgetKeys = known.filter((k) => k.limit != null);
  const options = form.kind === "budget_pct" ? budgetKeys : known;
  const id = useId();
  async function submit(e) {
    e.preventDefault();
    const problem = formProblem(form);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await onSave(ruleBody(form, editing));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={editing ? "Edit alert rule" : "New alert rule"} onClose={onClose}>
      <form onSubmit={submit} className={styles.form} noValidate>
        <div className="field">
          <label htmlFor={id + "kind"}>Alert when</label>
          <select id={id + "kind"} value={form.kind} disabled={editing || busy} onChange={(e) => set({ kind: e.target.value, key: e.target.value === "budget_pct" && !budgetKeys.some((k) => k.hash === form.key) ? budgetKeys[0]?.hash || "" : form.key })}>
            <option value="threshold">Spend reaches an amount</option>
            <option value="budget_pct">A key uses a share of its budget</option>
            <option value="anomaly">Day spend spikes above its average</option>
          </select>
          {editing && <p className="help-text">A rule’s kind is fixed; create a new rule for another kind.</p>}
        </div>
        {form.kind === "threshold" && (
          <div className="two-fields">
            <div className="field">
              <label htmlFor={id + "amount"}>Amount (USD)</label>
              <input id={id + "amount"} type="number" inputMode="decimal" min="0.01" step="0.01" value={form.threshold} onChange={(e) => set({ threshold: e.target.value })} disabled={busy} required />
            </div>
            <div className="field">
              <label htmlFor={id + "window"}>Within</label>
              <select id={id + "window"} value={form.window} onChange={(e) => set({ window: e.target.value })} disabled={busy}>
                <option value="day">One UTC day</option>
                <option value="week">One week (Mon–Sun)</option>
                <option value="month">One calendar month</option>
              </select>
            </div>
          </div>
        )}
        {form.kind === "budget_pct" && (
          <div className="field">
            <label htmlFor={id + "pct"}>Percent of the key’s budget</label>
            <input id={id + "pct"} type="number" inputMode="numeric" min="1" max="1000" step="1" value={form.pct} onChange={(e) => set({ pct: e.target.value })} disabled={busy} />
          </div>
        )}
        {form.kind === "anomaly" && (
          <div className="field">
            <label htmlFor={id + "mult"}>Times the trailing 7-day daily average</label>
            <input id={id + "mult"} type="number" inputMode="decimal" min="1.1" max="100" step="0.1" value={form.multiplier} onChange={(e) => set({ multiplier: e.target.value })} disabled={busy} />
            <p className="help-text">Days under $1 never count as a spike.</p>
          </div>
        )}
        <div className="field">
          <label htmlFor={id + "key"}>Watch</label>
          <select id={id + "key"} value={form.key} onChange={(e) => set({ key: e.target.value })} disabled={busy || !management}>
            {form.kind !== "budget_pct" && management && <option value="">Whole account (every key)</option>}
            {form.kind === "budget_pct" && !options.length && <option value="">No key has a budget yet</option>}
            {options.map((k) => (
              <option key={k.hash} value={k.hash}>
                {keyName(k)} · {k.label}
                {k.limit != null ? ` · ${formatUsd(k.limit)}${k.limit_reset ? " " + k.limit_reset : ""}` : ""}
              </option>
            ))}
          </select>
          {!management && <p className="help-text">This key can only watch its own spend.</p>}
        </div>
        <div className="field">
          <label htmlFor={id + "hook"}>Webhook (optional)</label>
          <input
            id={id + "hook"}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={rule?.webhook_url ? `Saved: ${rule.webhook_url} · type to replace` : "https://hooks.example.com/…"}
            value={form.webhook}
            onChange={(e) => set({ webhook: e.target.value, removeWebhook: false })}
            disabled={busy || form.removeWebhook}
          />
          <p className="help-text">HTTPS to a public host only. Stored encrypted and shown masked. Receives a JSON summary: amounts, period and key label; never prompts or secrets.</p>
        </div>
        {editing && rule.webhook_url && (
          <label className="check-label">
            <input type="checkbox" checked={form.removeWebhook} onChange={(e) => set({ removeWebhook: e.target.checked, webhook: "" })} disabled={busy} /> Remove the saved webhook
          </label>
        )}
        <label className="check-label">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={busy} /> Enabled
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save rule" : "Create rule"}
          </Button>
          <Button type="button" secondary onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const TONE_CLASS = { ok: "delivered", wait: "waiting", bad: "failed", off: "off" };

export default function SpendWatch({ live, apiKey, ws, notify }) {
  const [period, setPeriod] = useState("30d");
  const [report, setReport] = useState(null);
  const [rules, setRules] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rulesError, setRulesError] = useState("");
  const [modal, setModal] = useState(null); // { type: "rule", rule? } | { type: "delete", rule }
  const [nonce, setNonce] = useState(0);
  const [busyRule, setBusyRule] = useState("");
  const [signingSecret, setSigningSecret] = useState(""); // V86: owner sees it once.
  useEffect(() => { setSigningSecret(""); }, [apiKey]); // V86: forget on disconnect.
  const sample = useMemo(() => (live ? null : sampleData(period, Date.now())), [live, period]);

  useEffect(() => {
    if (!live || !apiKey) return;
    const ctl = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api(`/api/v1/spend?period=${period}&group_by=model`, { key: apiKey, signal: ctl.signal }),
      api(`/api/v1/spend?period=${period}&group_by=key`, { key: apiKey, signal: ctl.signal }),
    ])
      .then(([byModel, byKey]) => setReport({ ...byModel.data, byKey: byKey.data.breakdown }))
      .catch((e) => e?.name !== "AbortError" && setError(e.message))
      .finally(() => !ctl.signal.aborted && setLoading(false));
    return () => ctl.abort();
  }, [live, apiKey, period, nonce]);

  useEffect(() => {
    if (!live || !apiKey) return;
    const ctl = new AbortController();
    setRulesError("");
    api("/api/v1/spend/alerts", { key: apiKey, signal: ctl.signal })
      .then((r) => setRules(r.data))
      .catch((e) => e?.name !== "AbortError" && setRulesError(e.message));
    return () => ctl.abort();
  }, [live, apiKey, nonce]);

  const view = live ? report : sample.report;
  const ruleList = live ? rules : sample.rules;
  const management = !!ws?.me?.management;
  const ownKey = ws?.me?.hash || "";
  const keyOptions = (ws?.keys?.length ? ws.keys : ws?.me ? [ws.me] : []).filter((k) => !k.disabled && (management || k.hash === ownKey));
  const firings = (ruleList || [])
    .flatMap((r) => r.history.map((f) => ({ ...f, rule: r })))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 20);
  const monthLabel = view ? new Date(view.range?.to + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) : "";
  const perDay = view ? view.totals.month_to_date_usd / Math.max(1, view.totals.day_of_month) : 0;
  const tag = live ? "" : "Sample · ";

  async function saveRule(body) {
    const editing = modal?.rule;
    const r = await api(editing ? "/api/v1/spend/alerts/" + encodeURIComponent(editing.id) : "/api/v1/spend/alerts", { key: apiKey, method: editing ? "PATCH" : "POST", body });
    setRules((list) => (editing ? (list || []).map((x) => (x.id === editing.id ? r.data : x)) : [...(list || []), r.data]));
    setModal(null);
    if (r.signing_secret) setSigningSecret(r.signing_secret); // V86: no browser storage.
    notify?.(editing ? "Alert rule saved." : "Alert rule created. It is checked every minute.");
  }
  async function toggleRule(rule) {
    setBusyRule(rule.id);
    setRulesError("");
    try {
      const r = await api("/api/v1/spend/alerts/" + encodeURIComponent(rule.id), { key: apiKey, method: "PATCH", body: { enabled: !rule.enabled } });
      setRules((list) => list.map((x) => (x.id === rule.id ? r.data : x)));
      notify?.(r.data.enabled ? "Alert rule enabled." : "Alert rule paused. Pending webhook retries were cancelled.");
    } catch (e) {
      setRulesError(e.message);
    } finally {
      setBusyRule("");
    }
  }
  async function deleteRule(rule) {
    setBusyRule(rule.id);
    try {
      await api("/api/v1/spend/alerts/" + encodeURIComponent(rule.id), { key: apiKey, method: "DELETE" });
      setRules((list) => list.filter((x) => x.id !== rule.id));
      setModal(null);
      notify?.("Alert rule deleted.");
    } catch (e) {
      setRulesError(e.message);
      setModal(null);
    } finally {
      setBusyRule("");
    }
  }

  const tiles = view
    ? [
        ["Today", view.totals.today_usd, `${tag}UTC day so far`],
        ["Last 7 days", view.totals.last_7d_usd, `${tag}Including today`],
        ["Month to date", view.totals.month_to_date_usd, `${tag}${monthLabel} 1–${view.totals.day_of_month}`],
        ["Projected month", view.totals.projected_month_usd, `${tag}${formatUsd(perDay)}/day × ${view.totals.days_in_month} days`],
      ]
    : [];

  return (
    <div className={styles.root}>
      {signingSecret && <Modal title="Save your signing secret" onClose={() => setSigningSecret("")}><p>This secret is shown once. Store it in your receiver. Rotate it in Webhooks if you need a replacement.</p><code style={{ display: "block", overflowWrap: "anywhere" }}>{signingSecret}</code><CopyButton text={signingSecret} label="Copy secret"/><Button onClick={() => setSigningSecret("")}>Saved</Button></Modal>} {/* V86. */}
      <p className="help-text"><a href="/dashboard/webhooks/">Manage webhook signing and event subscriptions</a> where enabled.</p> {/* V86. */}
      <div className="panel-heading">
        <div>
          <h2>{live ? "Where the money goes." : "Where the money goes (sample)."}</h2>
          <p className="help-text">
            {live
              ? view?.scope === "key"
                ? "Spend billed to this key, by UTC day. Only a management key sees the whole account."
                : "Spend billed to this account’s keys, by UTC day. Billing records only: prompts and responses are never stored."
              : "An illustration of this view with generated figures. None of it is your spend."}
          </p>
        </div>
        <div className={styles.controls}>
          <div className={styles.segmented} role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}>
                {p.replace("d", " days")}
              </button>
            ))}
          </div>
          {live && (
            <button type="button" className="text-button" onClick={() => setNonce((n) => n + 1)} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>
      </div>

      {!live && (
        <div className={styles.sampleBanner} role="note">
          <span className="badge dark">Sample data</span>
          <span>Every figure, key and alert on this tab is generated in your browser for illustration. Nothing is read from a router, and sample alerts are never sent.</span>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          Spend could not be loaded: {error}{" "}
          <button type="button" className="text-button" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}

      {!view ? (
        !error && (
          <div className="empty loading-state" role="status">
            <span className="loading-bar" aria-hidden="true" />
            Loading spend…
          </div>
        )
      ) : (
        <>
          {view.anomaly.flagged && (
            <div className={styles.anomaly} role="status">
              <span className={styles.anomalyMark} aria-hidden="true" />
              <div>
                <strong>
                  {live ? "Spend spike today" : "Sample spike"}: {formatUsd(view.anomaly.today_usd)} so far.
                </strong>
                <p>
                  {view.anomaly.ratio != null
                    ? `That is ${view.anomaly.ratio.toLocaleString("en-US", { maximumFractionDigits: 1 })}× the trailing 7-day average of ${formatUsd(view.anomaly.trailing_daily_avg_usd)} a day.`
                    : "There was no spend in the 7 days before today."}{" "}
                  Flagged at {view.anomaly.multiplier}× and at least {formatUsd(view.anomaly.min_today_usd)}.
                  {live && " An anomaly rule below can send a webhook when this happens."}
                </p>
              </div>
            </div>
          )}

          <div className={"metric-grid " + styles.tiles} data-sample={!live || undefined}>
            {tiles.map(([label, value, sub], i) => (
              <article className="metric" key={label} style={{ "--i": i }}>
                <span className="eyebrow">{label}</span>
                <strong>{formatUsd(value)}</strong>
                <span>{sub}</span>
              </article>
            ))}
          </div>

          <section className={styles.panel} aria-label="Spend by day">
            <div className={styles.panelHead}>
              <h3>Spend by day</h3>
              <span className={"badge" + (live ? "" : " dark")}>{live ? `${shortDate(view.range.from)} – ${shortDate(view.range.to)} · UTC` : "Sample data"}</span>
            </div>
            <SpendChart series={view.series} sample={!live} flagged={view.anomaly.flagged} />
            <div className={styles.legend} aria-hidden="true">
              <span><i className={styles.keyBar} /> Daily spend</span>
              <span><i className={styles.keyToday + (view.anomaly.flagged ? " " + styles.keySpike : "")} /> Today{view.anomaly.flagged ? " · spike" : " · so far"}</span>
              <span className={styles.legendTotal}>
                {formatUsd(view.totals.period_usd)} · {view.totals.period_requests.toLocaleString("en-US")} requests
              </span>
            </div>
          </section>

          <div className={styles.split}>
            <Breakdown title="By model" rows={view.breakdown} empty="No spend in this period." nameOf={(r) => r.id} note={live ? null : "Sample"} />
            <Breakdown
              title="By key"
              rows={view.byKey || []}
              empty="No spend in this period."
              nameOf={(r) => r.name || r.label || r.id.slice(0, 12) + "…"}
              subOf={(r) => (r.name ? r.label : null)}
              note={live ? (view.scope === "key" ? "This key only" : null) : "Sample"}
            />
          </div>

          <div className="panel-heading">
            <div>
              <h2>Key budgets</h2>
              <p className="help-text">Spend in each key’s current budget period. Keys without a budget are not listed; set one in API keys.</p>
            </div>
            {!live && <span className="badge dark">Sample data</span>}
          </div>
          {view.budgets.length ? (
            <Budgets budgets={view.budgets} sample={!live} />
          ) : (
            <p className={styles.quiet}>No key in view has a budget.</p>
          )}
        </>
      )}

      <div className="panel-heading">
        <div>
          <h2>Alert rules</h2>
          <p className="help-text">Checked every minute. Each rule fires at most once per period; a webhook is retried on the next two checks if it fails.</p>
        </div>
        {live ? (
          <Button onClick={() => setModal({ type: "rule" })} disabled={!rules || rules.length >= 20}>
            New rule
          </Button>
        ) : (
          <span className="badge dark">Sample rules · read only</span>
        )}
      </div>
      {rulesError && (
        <div className="error" role="alert">
          {rulesError}
        </div>
      )}
      {!ruleList ? (
        live && !rulesError && <p className={styles.quiet}>Loading rules…</p>
      ) : ruleList.length ? (
        <div className="table-wrap">
          <table className={"data-table " + styles.rulesTable}>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Watches</th>
                <th>Webhook</th>
                <th>Last fired</th>
                <th>Status</th>
                {live && <th><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {ruleList.map((r, i) => (
                <tr key={r.id} style={{ "--i": i }} data-enabled={r.enabled}>
                  <td className="cell-primary">
                    <strong>{describeRule(r)}</strong>
                  </td>
                  <td data-label="Watches">{ruleScope(r)}</td>
                  <td data-label="Webhook" className={styles.hook}>
                    {r.webhook_url ? <code>{r.webhook_url}</code> : <span className={styles.muted}>None</span>}
                  </td>
                  <td data-label="Last fired">{r.last_fired_at ? dateTime(r.last_fired_at) : <span className={styles.muted}>Not yet</span>}</td>
                  <td data-label="Status">
                    <span className={"badge" + (r.enabled ? " green" : "")}>{r.enabled ? "On" : "Paused"}</span>
                  </td>
                  {live && (
                    <td className="cell-action">
                      <span className={styles.actions}>
                        <button type="button" className="text-button" onClick={() => setModal({ type: "rule", rule: r })} disabled={busyRule === r.id}>
                          Edit
                        </button>
                        <button type="button" className="text-button" onClick={() => toggleRule(r)} disabled={busyRule === r.id}>
                          {r.enabled ? "Pause" : "Enable"}
                        </button>
                        <button type="button" className="text-button" onClick={() => setModal({ type: "delete", rule: r })} disabled={busyRule === r.id}>
                          Delete
                        </button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <h3>No alert rules yet.</h3>
          <p>Get a webhook when spend reaches an amount, a key nears its budget, or a day spikes.</p>
          {live && (
            <div className="button-row">
              <Button onClick={() => setModal({ type: "rule" })}>Create a rule</Button>
            </div>
          )}
        </div>
      )}

      <div className="panel-heading">
        <div>
          <h2>Recent alerts</h2>
          <p className="help-text">The last firings of each rule, with webhook delivery status.</p>
        </div>
        {!live && <span className="badge dark">Sample data</span>}
      </div>
      {firings.length ? (
        <div className="table-wrap">
          <table className={"data-table " + styles.firingsTable}>
            <thead>
              <tr>
                <th>When</th>
                <th>Rule</th>
                <th>What happened</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {firings.map((f, i) => {
                const d = deliveryText(f.delivery);
                return (
                  <tr key={f.id} style={{ "--i": i }}>
                    <td className="cell-primary">
                      <strong className="mono">{dateTime(f.at)}</strong>
                    </td>
                    <td data-label="Rule">
                      {describeRule(f.rule)}
                      {f.key_label && <small className="mono">{f.key_label}</small>}
                    </td>
                    <td data-label="What happened">{firingText(f)}</td>
                    <td data-label="Delivery">
                      <span className={styles.delivery} data-tone={TONE_CLASS[d.tone]}>
                        {d.text}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.quiet}>{ruleList?.length ? "No rule has fired yet." : "Alerts appear here once a rule fires."}</p>
      )}

      {modal?.type === "rule" && live && (
        <RuleForm rule={modal.rule} keyOptions={keyOptions} management={management} ownKey={ownKey} onSave={saveRule} onClose={() => setModal(null)} />
      )}
      {modal?.type === "delete" && live && (
        <Modal title="Delete alert rule?" onClose={() => setModal(null)}>
          <p>
            <strong>{describeRule(modal.rule)}</strong> · {ruleScope(modal.rule)}. Its firing history is deleted too, and pending webhook retries stop.
          </p>
          <div className="button-row">
            <Button onClick={() => deleteRule(modal.rule)} disabled={busyRule === modal.rule.id}>
              {busyRule === modal.rule.id ? "Deleting…" : "Delete rule"}
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Keep it
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
