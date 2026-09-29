"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, ApiError, api, setMode } from "../../lib/api";
import { Button, Code, CopyButton, Modal } from "../UI";
import styles from "./AgentSessions.module.css";
import { LIMITS, REFRESH_MS, TTL_PRESETS, createBody, envSnippet, formatAgo, formatDuration, formatUsd, routeOptions, sampleSessions, secondsLeft, spendShare, statusMeta, timeShare, validateForm, withDeadlines } from "./agent-sessions";

/**
 * Agent Sessions workspace tab. Props (from Dashboard): { live, apiKey, ws, status, catalog, refresh, notify, fail, navigate }.
 * A session is a short-lived, budget-capped sub-key for one agent run. live=false shows an explanatory state with
 * clearly labelled sample cards; nothing there is live data and nothing is sent to the API.
 */

const apiOrigin = () => API_BASE || (typeof window === "undefined" ? "" : window.location.origin);
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB") : "—");
const fromNow = (s, now) => (s.sample ? s.time_left_s : secondsLeft(s.deadline, now));

const endedLabel = (s) => (s.status === "expired" ? "Expired" : s.status === "budget_exhausted" ? "Budget spent" : "Ended");
const endedText = (s, now) => endedLabel(s) + " " + formatAgo(s.ended_at || s.expires_at, now);

function Meter({ s, label = "Budget used" }) {
  const share = spendShare(s.spent_usd, s.reserved_usd, s.budget_usd);
  const pct = share.spent > 0 && share.spent < 0.1 ? "<0.1" : share.spent.toFixed(share.spent < 10 && share.spent > 0 ? 1 : 0);
  return (
    <>
      <div className={styles.meter} data-level={share.spent >= 100 ? "full" : share.spent >= 85 ? "high" : "ok"} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share.spent * 10) / 10} aria-valuetext={`${formatUsd(s.spent_usd)} of ${formatUsd(s.budget_usd)} spent`}>
        <span className={styles.meterSpent} style={{ width: share.spent + "%" }} />
        {share.reserved > 0 && <span className={styles.meterHeld} style={{ left: share.spent + "%", width: share.reserved + "%" }} />}
      </div>
      <div className={styles.meterLine}>
        <span>
          <strong>{formatUsd(s.spent_usd)}</strong> of {formatUsd(s.budget_usd)}
        </span>
        <span>
          {pct}% used{s.reserved_usd > 0 ? ` · ${formatUsd(s.reserved_usd)} in flight` : ""}
        </span>
      </div>
    </>
  );
}

function StatusBadge({ status }) {
  const meta = statusMeta(status);
  return (
    <span className={"badge" + (meta.tone === "active" ? " green" : "") + " " + styles.status} data-tone={meta.tone}>
      {meta.label}
    </span>
  );
}

function SessionCard({ s, now, i, onOpen, onEnd }) {
  const active = s.status === "active";
  const left = active ? fromNow(s, now) : 0;
  const models = s.allowed_models || [];
  return (
    <article className={styles.card} data-tone={statusMeta(s.status).tone} style={{ "--i": Math.min(i, 12) }}>
      <header className={styles.cardHead}>
        <h3>{s.name || "Unnamed session"}</h3>
        <div className={styles.badges}>
          {s.sample && <span className="badge">Sample</span>}
          <StatusBadge status={s.status} />
        </div>
      </header>
      <code className={styles.keyLabel}>{s.key_label || "key unavailable"}</code>
      <Meter s={s} label={"Budget used by " + (s.name || "this session")} />
      <dl className={styles.stats}>
        <div>
          <dt>{active ? "Time left" : endedLabel(s)}</dt>
          <dd className={active && left > 0 && left < 300 ? styles.soon : undefined}>{active ? (left > 0 ? formatDuration(left) : "Expiring…") : formatAgo(s.ended_at || s.expires_at, now)}</dd>
        </div>
        <div>
          <dt>Calls</dt>
          <dd>{Number(s.calls || 0).toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>Last call</dt>
          <dd title={s.last_call_at ? when(s.last_call_at) : undefined}>{formatAgo(s.last_call_at, now)}</dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd title={models.join(", ") || undefined}>{models.length ? (models.length === 1 ? models[0].split("/").pop() : `${models.length} allowed`) : "Any model"}</dd>
        </div>
      </dl>
      <div className={"button-row " + styles.cardActions}>
        <button type="button" className="text-button" onClick={onOpen} aria-label={"Details for " + (s.name || "session " + s.id)}>
          Details →
        </button>
        {active && onEnd && (
          <button type="button" className={"text-button " + styles.danger} onClick={onEnd} disabled={s.sample} title={s.sample ? "Sample only" : undefined}>
            End session
          </button>
        )}
      </div>
      <div className="card-ramp" />
    </article>
  );
}

function Drawer({ s, detail, error, now, onClose, onEnd, onReceipts, restricted = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dlg = ref.current;
    dlg.showModal();
    return () => dlg.close();
  }, []);
  const d = { ...s, ...(detail || {}) };
  const active = d.status === "active";
  const left = active ? fromNow(s, now) : 0;
  const calls = restricted ? [] : detail?.recent_calls || (s.sample ? s.recent_calls : null);
  const meta = d.metadata && Object.keys(d.metadata).length ? Object.entries(d.metadata) : [];
  return (
    <dialog ref={ref} className={styles.drawer} onCancel={onClose} onClick={(e) => e.target === e.currentTarget && onClose()} aria-labelledby="session-drawer-title">
      <div className={styles.drawerInner}>
        <div className={styles.drawerHead}>
          <div>
            <span className="eyebrow">{s.sample ? "Sample agent session · not live data" : "Agent session"}</span>
            <h2 id="session-drawer-title">{d.name || "Unnamed session"}</h2>
          </div>
          <button type="button" aria-label="Close details" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className={styles.drawerStatus}>
          <StatusBadge status={d.status} />
          <span className="mono">{active ? (left > 0 ? formatDuration(left) + " left" : "Expiring…") : endedText(d, now)}</span>
        </div>
        <Meter s={d} />
        {active && (
          <>
            <div className={styles.timeBar} aria-hidden="true">
              <span style={{ width: timeShare(d.created_at, d.expires_at, left) + "%" }} />
            </div>
            <div className={styles.meterLine}>
              <span>Time used</span>
              <span>
                {formatDuration(left)} left of {formatDuration(Math.round((Date.parse(d.expires_at) - Date.parse(d.created_at)) / 60_000) * 60)}
              </span>
            </div>
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <dl className="detail-list">
          {[
            ["Key", <code key="k">{d.key_label || "—"}</code>],
            ["Created by", d.created_by ? <code key="c">{d.created_by}</code> : "—"],
            ["Created", when(d.created_at)],
            [active ? "Expires" : "Ended", active ? when(d.expires_at) : when(d.ended_at || d.expires_at)],
            ["Budget", formatUsd(d.budget_usd) + " USDG"],
            ["Remaining", d.remaining_usd == null ? "—" : formatUsd(d.remaining_usd) + " USDG"],
            ["Calls", Number(d.calls || 0).toLocaleString("en-US") + (d.last_call_at ? " · last " + formatAgo(d.last_call_at, now) : "")],
            ["Models", d.allowed_models?.length ? d.allowed_models.join(", ") : "Any model (no allowlist)"],
            ...(meta.length ? [["Metadata", meta.map(([k, v]) => `${k}: ${v}`).join(" · ")]] : []),
          ].map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.timelineHead}>
          <h3>Call timeline</h3>
          <span className="eyebrow">{restricted ? "Owner and admin keys" : calls ? (calls.length ? `Latest ${calls.length}` : "No calls") : "Loading…"}</span>
        </div>
        {calls && calls.length > 0 ? (
          <ol className={styles.timeline}>
            {calls.map((g) => (
              <li key={g.id}>
                <time dateTime={g.ts} title={when(g.ts)}>
                  {new Date(g.ts).toLocaleTimeString("en-GB")}
                </time>
                <div className={styles.callMain}>
                  <strong>{g.model}</strong>
                  <small>
                    {g.provider} · {Number(g.tokens_in).toLocaleString("en-US")} in / {Number(g.tokens_out).toLocaleString("en-US")} out
                    {g.latency_ms != null ? ` · ${g.latency_ms} ms` : ""}
                  </small>
                </div>
                <div className={styles.callSide}>
                  <span className="mono">{formatUsd(g.cost_usd)}</span>
                  <span className={styles.receipt} data-state={s.sample ? "sample" : g.receipt ? (g.anchored ? "anchored" : "signed") : "none"}>
                    {s.sample ? "Sample" : g.receipt ? (g.anchored ? "Signed · anchored" : "Signed") : "No receipt"}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : calls ? (
          <p className={styles.quiet}>{restricted ? "A session key sees its own budget and time; its call timeline is visible to owner and admin keys." : s.sample ? "This sample session has no calls." : active ? `No calls yet. The agent’s calls appear here within ${REFRESH_MS / 1000} seconds.` : "This session made no calls."}</p>
        ) : null}
        <p className="help-text">Metadata only: model, provider, tokens, cost and latency. Prompts and responses are never stored.</p>
        <div className="button-row">
          {!s.sample && onReceipts && (
            <button type="button" className="text-button" onClick={onReceipts}>
              Open receipts →
            </button>
          )}
          {active && onEnd && (
            <button type="button" className={"text-button " + styles.danger} onClick={onEnd} disabled={s.sample} title={s.sample ? "Sample only" : undefined}>
              End session
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function ModelPicker({ catalog, routes, value, onChange, disabled }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const match = (id, name = "") => !q || id.toLowerCase().includes(q) || String(name).toLowerCase().includes(q);
  const models = catalog.filter((m) => match(m.id, m.name));
  const shown = models.slice(0, 80);
  const shownRoutes = routes.filter((r) => match(r.id, r.name));
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.length >= LIMITS.maxModels ? value : [...value, id]);
  return (
    <fieldset className={styles.picker} disabled={disabled}>
      <legend>Model allowlist</legend>
      <p className={styles.pickerHelp}>{value.length ? `${value.length} selected. The key may call only these.` : "None selected: the session may use any model the creating key may use."}</p>
      {value.length > 0 && (
        <ul className={styles.chips} aria-label="Selected models">
          {value.map((id) => (
            <li key={id}>
              <span>{id}</span>
              <button type="button" aria-label={"Remove " + id} onClick={() => toggle(id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input type="search" className="search-field" aria-label="Filter models" placeholder={catalog.length ? "Filter models and saved routes…" : "Model catalog unavailable"} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className={styles.options}>
        {shownRoutes.length > 0 && (
          <div role="group" aria-label="Saved routes">
            <span className={styles.groupLabel}>Saved routes</span>
            {shownRoutes.map((r) => (
              <label key={r.id} className={styles.option}>
                <input type="checkbox" checked={value.includes(r.id)} onChange={() => toggle(r.id)} />
                <span className="mono">{r.id}</span>
                <small>{r.name}</small>
              </label>
            ))}
          </div>
        )}
        <div role="group" aria-label="Models">
          <span className={styles.groupLabel}>Models</span>
          {shown.map((m) => (
            <label key={m.id} className={styles.option}>
              <input type="checkbox" checked={value.includes(m.id)} onChange={() => toggle(m.id)} />
              <span className="mono">{m.id}</span>
              <small>{m.type}</small>
            </label>
          ))}
          {!shown.length && <p className={styles.quiet}>{catalog.length ? "No model matches this filter." : "The model catalog could not be loaded. Leave the allowlist empty or retry later."}</p>}
          {models.length > shown.length && <p className={styles.quiet}>{models.length - shown.length} more; refine the filter to see them.</p>}
        </div>
      </div>
    </fieldset>
  );
}

function CreateForm({ catalog, routes, onCreate }) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("1");
  const [ttl, setTtl] = useState(String(LIMITS.defaultTtl));
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className={"control-panel " + styles.form}
      onSubmit={async (e) => {
        e.preventDefault();
        const problem = validateForm({ name, budget, ttl });
        if (problem) return setError(problem);
        setError("");
        setBusy(true);
        try {
          await onCreate({ name, budget, ttl, models });
          setName("");
          setModels([]);
        } catch (err) {
          setError(err?.message || String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="eyebrow">New session</span>
      <h3 className={styles.formTitle}>One key for one run.</h3>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="field">
        <label htmlFor="as-name">Name</label>
        <input id="as-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.maxName} placeholder="e.g. Repo refactor agent" disabled={busy} />
      </div>
      <div className={styles.pair}>
        <div className="field">
          <label htmlFor="as-budget">Budget / USDG</label>
          <input id="as-budget" type="number" inputMode="decimal" min="0.000001" max={LIMITS.maxBudget} step="any" value={budget} onChange={(e) => setBudget(e.target.value)} required disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="as-ttl">Time limit / minutes</label>
          <input id="as-ttl" type="number" inputMode="numeric" min={LIMITS.minTtl} max={LIMITS.maxTtl} step="1" value={ttl} onChange={(e) => setTtl(e.target.value)} required disabled={busy} />
        </div>
      </div>
      <div className={styles.presets} role="group" aria-label="Time limit presets">
        {TTL_PRESETS.map(([m, label]) => (
          <button type="button" key={m} aria-pressed={String(m) === ttl} onClick={() => setTtl(String(m))} disabled={busy}>
            {label}
          </button>
        ))}
      </div>
      <ModelPicker catalog={catalog} routes={routes} value={models} onChange={setModels} disabled={busy} />
      <p className="help-text">The key shares this workspace’s balance, stops at its budget or time limit, and can be ended any time. Its secret is shown once.</p>
      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create session"}
      </Button>
    </form>
  );
}

function SecretReveal({ created, onClose }) {
  const env = envSnippet(created.key, apiOrigin());
  return (
    <Modal title="Your agent session key" onClose={onClose}>
      <p>Copy this key now. It is shown once; the router stores only its hash. Hand it to the agent for this run only.</p>
      <Code label="Session key">{created.key}</Code>
      <div className="code-panel">
        <div className="code-bar">
          <span>Environment</span>
          <CopyButton text={env} />
        </div>
        <pre>
          <code>{env}</code>
        </pre>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Session</dt>
          <dd>{created.name || created.id}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>{formatUsd(created.budget_usd)} USDG, no reset</dd>
        </div>
        <div>
          <dt>Stops at</dt>
          <dd>{when(created.expires_at)}</dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>{created.allowed_models?.length ? created.allowed_models.join(", ") : "Any model (no allowlist)"}</dd>
        </div>
      </dl>
      <p className="help-text">The agent can check what it has left with GET /api/v1/sessions/current using this key.</p>
      <div className="button-row modal-actions">
        <Button onClick={onClose}>I saved it</Button>
      </div>
    </Modal>
  );
}

function Metrics({ sessions, now }) {
  const active = sessions.filter((s) => s.status === "active");
  const next = active.length ? Math.min(...active.map((s) => fromNow(s, now))) : null;
  const items = [
    ["Active sessions", String(active.length), `${sessions.length} in this list`],
    ["Spent · active", formatUsd(active.reduce((a, s) => a + (s.spent_usd || 0), 0)), `of ${formatUsd(active.reduce((a, s) => a + (s.budget_usd || 0), 0))} budgeted`],
    ["Next to expire", next == null ? "—" : formatDuration(next), next == null ? "No active session" : "time left on the soonest"],
  ];
  return (
    <div className={styles.metrics}>
      {items.map(([label, value, sub]) => (
        <div key={label} className={styles.metric}>
          <span className="eyebrow">{label}</span>
          <strong>{value}</strong>
          <span>{sub}</span>
        </div>
      ))}
    </div>
  );
}

const FILTERS = [
  ["all", "All"],
  ["active", "Active"],
  ["done", "Ended"],
];

function SampleView() {
  const [mountedAt] = useState(() => Date.now());
  const [samples] = useState(() => sampleSessions(mountedAt));
  const [open, setOpen] = useState(null);
  return (
    <>
      <div className="panel-heading">
        <div>
          <h2>Agent Sessions</h2>
          <p className="help-text">A short-lived, budget-capped key for one agent run.</p>
        </div>
        <span className="badge">Sample workspace</span>
      </div>
      <section className={styles.explain} aria-labelledby="as-sample-title">
        <div>
          <span className="eyebrow">How it works</span>
          <h3 id="as-sample-title">Give each agent run its own key, budget and clock.</h3>
          <ol className={styles.steps}>
            <li>
              <strong>Create a session</strong> with a budget in USDG, a time limit (1 minute to 24 hours) and, optionally, the models it may call.
            </li>
            <li>
              <strong>Hand the key to the agent.</strong> It works like any Anyroute key and can check its own remaining budget and time.
            </li>
            <li>
              <strong>It stops by itself</strong> when the budget is spent or the time runs out, or when you end it. Every call keeps its receipt.
            </li>
          </ol>
          <div className="button-row">
            <Button
              onClick={() => {
                setMode("live");
                window.location.reload();
              }}
            >
              Use your live workspace
            </Button>
          </div>
        </div>
        <Code label="What the agent receives">{"ANYROUTE_API_KEY=<shown once when you create a session>\nANYROUTE_BASE_URL=<this router>/api/v1"}</Code>
      </section>
      <div className="note">Sessions are real keys the router enforces, so they are created only in your live workspace. The cards below are labelled sample illustrations: fixed figures, not live data, and nothing is sent anywhere.</div>
      <div className={styles.cards}>
        {samples.map((s, i) => (
          <SessionCard key={s.id} s={s} now={mountedAt} i={i} onOpen={() => setOpen(s)} onEnd={() => {}} />
        ))}
      </div>
      {open && <Drawer s={open} detail={null} error="" now={mountedAt} onClose={() => setOpen(null)} onEnd={() => {}} onReceipts={() => {}} />}
    </>
  );
}

export default function AgentSessions({ live, apiKey, catalog = [], refresh, notify, navigate }) {
  const [sessions, setSessions] = useState(null); // null while the first page loads
  const [self, setSelf] = useState(null); // signed in with a session key: its own session only
  const [listError, setListError] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState("all");
  const [routes, setRoutes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [created, setCreated] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState("");
  const inflight = useRef(false);
  const selectedRef = useRef(null);
  const selfIdRef = useRef(null);
  selectedRef.current = selected;
  selfIdRef.current = self?.id ?? null;

  const load = useCallback(async () => {
    if (inflight.current || !apiKey) return;
    inflight.current = true;
    try {
      const r = await api("/api/v1/sessions?limit=100", { key: apiKey });
      setSessions(withDeadlines(r.data));
      setSelf(null);
      setListError("");
      setLoadedAt(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        const me = await api("/api/v1/sessions/current", { key: apiKey }).catch(() => null);
        if (me?.data) {
          setSelf(withDeadlines([me.data])[0]);
          setSessions([]);
          setListError("");
          setLoadedAt(Date.now());
          return;
        }
      }
      setListError(e.message);
      setSessions((s) => s || []);
    } finally {
      inflight.current = false;
    }
  }, [apiKey]);

  const loadDetail = useCallback(
    async (id) => {
      try {
        const r = await api("/api/v1/sessions/" + encodeURIComponent(id) + "?limit=100", { key: apiKey });
        if (selectedRef.current === id) {
          setDetail(r.data);
          setDetailError("");
        }
      } catch (e) {
        if (selectedRef.current === id) setDetailError(e.message);
      }
    },
    [apiKey],
  );

  // Live list: load now, then every 5 s while this tab is on screen; catch up as soon as it is shown again.
  useEffect(() => {
    if (!live || !apiKey) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      load();
      if (selectedRef.current && selectedRef.current !== selfIdRef.current) loadDetail(selectedRef.current);
    };
    load();
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [live, apiKey, load, loadDetail]);

  // Countdown clock (local; deadlines come from the server's time_left_s, so device clock skew does not matter).
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => document.visibilityState === "visible" && setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  // Saved routes are optional: a router without them answers 404, and the picker simply omits the group.
  useEffect(() => {
    if (!live || !apiKey) return;
    let gone = false;
    api("/api/v1/routes", { key: apiKey })
      .then((r) => !gone && setRoutes(routeOptions(r)))
      .catch(() => !gone && setRoutes([]));
    return () => {
      gone = true;
    };
  }, [live, apiKey]);

  if (!live) return <SampleView />;

  async function create(values) {
    const r = await api("/api/v1/sessions", { key: apiKey, method: "POST", body: createBody(values) });
    setCreated(r.data);
    notify?.(`Agent session ${r.data.name ? "“" + r.data.name + "” " : ""}created. Copy its key now; it is shown once.`);
    load();
    Promise.resolve()
      .then(() => refresh?.())
      .catch(() => {});
  }
  function open(s) {
    setSelected(s.id);
    setDetail(null);
    setDetailError("");
    if (s.id !== self?.id) loadDetail(s.id);
  }
  async function end(s) {
    setEnding(true);
    try {
      const r = await api("/api/v1/sessions/" + encodeURIComponent(s.id), { key: apiKey, method: "DELETE" });
      notify?.(r.data.status === "ended" ? `Session ${s.name ? "“" + s.name + "” " : ""}ended. Its key stopped working immediately.` : `Session already ${statusMeta(r.data.status).label.toLowerCase()}; its key is now disabled too.`);
      setError("");
      load();
      if (selectedRef.current === s.id) loadDetail(s.id);
      Promise.resolve()
      .then(() => refresh?.())
      .catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setEnding(false);
      setConfirm(null);
    }
  }

  const list = sessions || [];
  const shown = list.filter((s) => filter === "all" || (filter === "active" ? s.status === "active" : s.status !== "active"));
  const current = selected ? [...list, ...(self ? [self] : [])].find((s) => s.id === selected) : null;
  const age = loadedAt ? Math.max(0, Math.round((now - loadedAt) / 1000)) : null;

  return (
    <>
      <div className="panel-heading">
        <div>
          <h2>Agent Sessions</h2>
          <p className="help-text">A short-lived, budget-capped key for one agent run. It stops at its budget, at its time limit, or when you end it.</p>
        </div>
        <span className="badge">Live · refreshes every {REFRESH_MS / 1000} s</span>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {self ? (
        <>
          <div className="note">You are signed in with an Agent Session key. It can see only its own session; sign in with an owner or admin key to create and manage sessions.</div>
          <div className={styles.cards}>
            <SessionCard s={self} now={now} i={0} onOpen={() => open(self)} />
          </div>
        </>
      ) : (
        <div className={styles.layout}>
          <CreateForm catalog={catalog} routes={routes} onCreate={create} />
          <section className={styles.listPanel} aria-labelledby="as-list-title">
            {list.length > 0 && <Metrics sessions={list} now={now} />}
            <div className={styles.toolbar}>
              <h3 id="as-list-title">Sessions</h3>
              <div className={styles.segmented} role="group" aria-label="Filter sessions">
                {FILTERS.map(([v, label]) => (
                  <button type="button" key={v} aria-pressed={filter === v} onClick={() => setFilter(v)}>
                    {label}
                    <span>{v === "all" ? list.length : list.filter((s) => (v === "active" ? s.status === "active" : s.status !== "active")).length}</span>
                  </button>
                ))}
              </div>
            </div>
            <p className={styles.freshness} role="status">
              {listError ? `Refresh failed: ${listError} Retrying every ${REFRESH_MS / 1000} s.` : age == null ? "Loading sessions…" : age < 2 ? "Updated just now" : `Updated ${age}s ago`}
            </p>
            {sessions === null ? (
              <div className="empty loading-state" role="status">
                <span className="loading-bar" aria-hidden="true" />
                Loading sessions…
              </div>
            ) : shown.length ? (
              <div className={styles.cards}>
                {shown.map((s, i) => (
                  <SessionCard key={s.id} s={s} now={now} i={i} onOpen={() => open(s)} onEnd={() => setConfirm(s)} />
                ))}
              </div>
            ) : (
              <div className="empty">
                <h3>{list.length ? "No sessions match this filter." : "No agent sessions yet."}</h3>
                <p>{list.length ? "Choose another filter to see the rest." : "Create one with a budget and a time limit, then hand its key to the agent."}</p>
              </div>
            )}
          </section>
        </div>
      )}
      {current && (
        <Drawer
          s={current}
          detail={detail}
          error={detailError}
          now={now}
          onClose={() => setSelected(null)}
          restricted={current.id === self?.id}
          onEnd={current.id === self?.id ? undefined : () => setConfirm(current)}
          onReceipts={
            current.id === self?.id
              ? undefined
              : () => {
                  setSelected(null);
                  navigate?.("Receipts");
                }
          }
        />
      )}
      {confirm && (
        <Modal title="End this session?" onClose={() => !ending && setConfirm(null)}>
          <p>
            The key for <strong>{confirm.name || "this session"}</strong> stops working immediately and the session is recorded as ended. Calls already made keep their receipts; {formatUsd(confirm.spent_usd)} of {formatUsd(confirm.budget_usd)} was spent.
          </p>
          <div className="button-row modal-actions">
            <Button onClick={() => end(confirm)} disabled={ending}>
              {ending ? "Ending…" : "End session"}
            </Button>
            <Button secondary onClick={() => setConfirm(null)} disabled={ending}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {created && <SecretReveal created={created} onClose={() => setCreated(null)} />}
    </>
  );
}
