"use client";
import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { models as sampleModels, money } from "../../lib/demo";
import {
  ATTESTED_LANE, BatchRunner, CONCURRENCY, MAX_INPUT_CHARS, MAX_RETRIES, MAX_ROWS, buildDefaults, checkFunds, clampConcurrency, countFailedClosed, estimateBatch, failClosed, makeSender,
  modelsOnLane, normalizeRoutes, parseBatch, priceIndex, responseText, restoreStates, routesOnLane, rowsOffLane, summarize, toCSV, toJSONL,
  SERVER_DISCOUNT_BPS, SERVER_POLL_MS, checkServerBatch, estimateServerBatch, newState, parseServerResults, serverBatchDone, serverLineErrors, serverProgress, toServerRequests,
} from "../../lib/batch";
import { Button, CopyButton, Modal } from "../UI";
import styles from "./BatchStudio.module.css";

/**
 * Batch Studio workspace tab. Props (from Dashboard): { live, apiKey, ws, status, catalog, refresh, notify, fail, navigate }.
 * Runs many chat completions from this browser: one non-streaming request per row with the visitor's key.
 * The router never stores prompts or completions; the batch lives in this page and in this browser's IndexedDB.
 * live=false (sample workspace): input and validation work, running is disabled, and no results are ever shown.
 */

// ---------------------------------------------------------------- browser-side batch store
// The batch lives outside React so it keeps running while another dashboard section is open (the Dashboard
// remounts tabs), and in IndexedDB so a reload can resume it. Nothing is stored anywhere else.

const DB_NAME = "anyroute-batch-studio";
const DB_STORE = "batches";
const PAGE = 25;
const EDITABLE_CHARS = 200_000; // larger inputs are summarised instead of shown in the text box

const store = { version: 0, listeners: new Set(), notifyTimer: null, saveTimer: null, keyHash: "", loaded: false, persisted: null, draft: null, run: null, lastStatus: null, hooks: {} };

const subscribe = (fn) => {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
};
const getVersion = () => store.version;
function bump() {
  clearTimeout(store.notifyTimer);
  store.notifyTimer = null;
  store.version++;
  store.listeners.forEach((fn) => fn());
}
/** Re-render at most five times a second while rows stream in. */
function changed() {
  if (!store.notifyTimer) store.notifyTimer = setTimeout(bump, 200);
}

async function idb(mode, fn) {
  if (typeof indexedDB === "undefined") return { ok: false };
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB is blocked."));
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve({ ok: true, value: req.result });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    return { ok: false };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
const recordKey = (hash) => "batch:" + hash;

function saveNow() {
  clearTimeout(store.saveTimer);
  store.saveTimer = null;
  if (!store.keyHash) return;
  const r = store.run;
  const record = {
    v: 1,
    savedAt: Date.now(),
    draft: store.draft,
    run:
      r &&
      (r.server
        ? { server: true, id: r.id, createdAt: r.createdAt, endedAt: r.endedAt, rows: r.rows, states: r.states, batch: r.batch, results: r.results === "loading" ? "none" : r.results, sourceName: r.sourceName, model: r.model, lane: r.lane, estimate: r.estimate, skipped: r.skipped }
        : { id: r.id, createdAt: r.createdAt, endedAt: r.endedAt, rows: r.rows, states: r.runner.states, status: r.runner.status, concurrency: r.runner.concurrency, sourceName: r.sourceName, model: r.model, lane: r.lane, estimate: r.estimate, skipped: r.skipped }),
  };
  const hash = store.keyHash;
  idb("readwrite", (s) => s.put(record, recordKey(hash))).then(({ ok }) => {
    if (ok !== store.persisted) {
      store.persisted = ok;
      changed();
    }
  });
}
function scheduleSave(ms = 2000) {
  if (store.keyHash && !store.saveTimer) store.saveTimer = setTimeout(saveNow, ms);
}

// One chat completion per row. On a lane the response headers are kept per row and an answer that does not state the lane is refused.
const sendWith = (key, lane) => makeSender((body, opts) => api("/api/v1/chat/completions", { key, method: "POST", body, ...opts }), { lane });

function onRunnerChange() {
  const r = store.run;
  if (!r) return;
  const status = r.runner.status;
  if (status === store.lastStatus) {
    changed();
    scheduleSave();
    return;
  }
  store.lastStatus = status;
  r.endedAt = status === "completed" || status === "cancelled" ? Date.now() : null;
  if (r.endedAt) {
    const s = summarize(r.runner.states);
    const closed = countFailedClosed(r.runner.states);
    store.hooks.notify?.(`Batch ${status === "completed" ? "finished" : "cancelled"}: ${int(s.done)} succeeded, ${int(s.failed)} failed${closed ? ` (${int(closed)} failed closed)` : ""}${s.cancelled ? `, ${int(s.cancelled)} cancelled` : ""}. Download the results in Batch Studio.`);
    Promise.resolve()
      .then(() => store.hooks.refresh?.())
      .catch(() => {});
  }
  saveNow();
  bump();
}

let guarded = false;
function guardUnload() {
  if (guarded || typeof window === "undefined") return;
  guarded = true;
  window.addEventListener("beforeunload", (e) => {
    const r = store.run?.runner;
    if (r && (r.status === "running" || r.inflight.size)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  const flush = () => store.keyHash && saveNow();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
}

function attachRun(meta, key) {
  const lane = meta.lane === ATTESTED_LANE ? ATTESTED_LANE : null;
  const runner = new BatchRunner({ rows: meta.rows, states: meta.states || undefined, send: sendWith(key, lane), concurrency: meta.concurrency, onChange: onRunnerChange });
  store.run = { id: meta.id, createdAt: meta.createdAt, endedAt: meta.endedAt ?? null, rows: meta.rows, sourceName: meta.sourceName, model: meta.model, lane, estimate: meta.estimate, skipped: meta.skipped || 0, runner };
  guardUnload();
  return runner;
}

// ---------------------------------------------------------------- server batches
// A batch sent to POST /api/v1/batches runs on the router's worker, so it goes on when this tab closes. The page polls the
// Batch object and, once the batch has finished, reads its output and errors files into the row states a browser batch keeps.
// The key stays in memory with the run; it is never saved.

const batchPath = (id, rest = "") => "/api/v1/batches/" + encodeURIComponent(id) + rest;

function attachServerRun(meta, key) {
  const run = {
    server: true,
    id: meta.id,
    createdAt: meta.createdAt,
    endedAt: meta.endedAt ?? null,
    rows: meta.rows,
    states: meta.states || meta.rows.map(newState),
    batch: meta.batch,
    results: meta.results || "none", // none | loading | ready | expired | error
    resultsError: null,
    pollError: null,
    sourceName: meta.sourceName,
    model: meta.model,
    lane: meta.lane === ATTESTED_LANE ? ATTESTED_LANE : null,
    estimate: meta.estimate,
    skipped: meta.skipped || 0,
    key,
    timer: null,
  };
  store.run = run;
  store.lastStatus = null;
  return run;
}

/** The next look at an unfinished batch, or its results once it has finished. */
function watchServer(run) {
  clearTimeout(run.timer);
  run.timer = null;
  if (store.run !== run) return;
  if (!serverBatchDone(run.batch)) run.timer = setTimeout(() => pollServer(run), run.pollError ? SERVER_POLL_MS * 4 : SERVER_POLL_MS);
  else if (run.results === "none") loadServerResults(run);
}

async function pollServer(run) {
  if (store.run !== run) return;
  try {
    const b = await api(batchPath(run.batch.id), { key: run.key });
    if (store.run !== run) return;
    if (b?.id) run.batch = b;
    run.pollError = null;
  } catch (e) {
    if (store.run !== run) return;
    run.pollError = e?.message || "The batch could not be checked.";
  }
  if (serverBatchDone(run.batch)) run.endedAt ||= Date.now();
  scheduleSave();
  bump();
  watchServer(run);
}

async function cancelServer(run) {
  run.cancelError = null;
  try {
    const b = await api(batchPath(run.batch.id, "/cancel"), { key: run.key, method: "POST" });
    if (store.run !== run) return;
    if (b?.id) run.batch = b;
  } catch (e) {
    if (store.run !== run) return;
    run.cancelError = e?.message || "The batch could not be cancelled.";
  }
  if (serverBatchDone(run.batch)) run.endedAt ||= Date.now();
  saveNow();
  bump();
  watchServer(run);
}

const SERVER_ENDED = { completed: "finished", failed: "failed", expired: "expired", cancelled: "cancelled" };

async function loadServerResults(run) {
  if (store.run !== run || run.results === "loading") return;
  run.results = "loading";
  run.resultsError = null;
  bump();
  try {
    const [output, errors] = await Promise.all([api(batchPath(run.batch.id, "/output"), { key: run.key, raw: true }), api(batchPath(run.batch.id, "/errors"), { key: run.key, raw: true })]);
    if (store.run !== run) return;
    run.states = parseServerResults(output, errors, run.rows, { lane: run.lane === ATTESTED_LANE }).states;
    run.results = "ready";
  } catch (e) {
    if (store.run !== run) return;
    run.results = e?.status === 410 ? "expired" : "error";
    run.resultsError = e?.message || "The results could not be read.";
  }
  const p = serverProgress(run.batch);
  store.hooks.notify?.(`Server batch ${SERVER_ENDED[p.status] || "ended"}: ${int(p.completed)} succeeded, ${int(p.failed)} failed.${run.results === "ready" ? " Download the results in Batch Studio." : ""}`);
  Promise.resolve()
    .then(() => store.hooks.refresh?.())
    .catch(() => {});
  saveNow();
  bump();
}

/** A reload pauses the batch: rows that were in flight fail as interrupted (never sent twice), the rest wait for Resume. */
async function loadSaved(hash, key) {
  const { ok, value } = await idb("readonly", (s) => s.get(recordKey(hash)));
  if (store.keyHash !== hash) return;
  store.persisted = ok;
  store.loaded = true;
  const rec = value?.v === 1 ? value : null;
  if (rec?.draft && typeof rec.draft === "object") store.draft = rec.draft;
  const saved = rec?.run;
  if (saved?.server) {
    // A server batch went on without this page: look at it again (or read its results) instead of resuming anything here.
    if (saved.batch?.id && Array.isArray(saved.rows) && saved.rows.length) {
      const run = attachServerRun({ ...saved, states: Array.isArray(saved.states) && saved.states.length === saved.rows.length ? saved.states : undefined }, key);
      if (serverBatchDone(run.batch)) watchServer(run);
      else pollServer(run);
    }
  } else if (saved && Array.isArray(saved.rows) && Array.isArray(saved.states) && saved.rows.length && saved.rows.length === saved.states.length) {
    const interrupted = saved.states.filter((s) => s?.status === "running").length;
    const runner = attachRun({ ...saved, states: restoreStates(saved.states) }, key);
    if (runner.pending.length || runner.waiting.size) runner.pause({ kind: "reload", interrupted });
    else runner.status = saved.status === "cancelled" ? "cancelled" : "completed";
    store.lastStatus = runner.status;
  }
  bump();
}

function discardRun() {
  const r = store.run;
  if (!r) return;
  store.run = null;
  store.lastStatus = null;
  if (r.server) clearTimeout(r.timer); // a server batch is only forgotten here; it is never cancelled by a discard
  else r.runner.cancel();
  saveNow();
  bump();
}

// ---------------------------------------------------------------- formatting

const int = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const time = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STATUS = { pending: "Queued", running: "Running", waiting: "Retrying", done: "Done", failed: "Failed", cancelled: "Cancelled" };
/** A row the router refused or withheld on the attested lane reads "Failed closed", not just "Failed". */
const statusLabel = (st) => (failClosed(st) ? "Failed closed" : STATUS[st.status]);
const statusKey = (st) => (failClosed(st) ? "closed" : st.status);
const closedNote = (st) =>
  failClosed(st) === "refused"
    ? "Refused before anything was sent: no attested provider could serve this row, and nothing was charged."
    : "The answer was withheld because it could not be shown to come from attested hardware. The call may have been billed; see its receipt.";
const FILTERS = [
  ["all", "All rows"],
  ["pending", "Queued"],
  ["running", "Running"],
  ["waiting", "Retrying"],
  ["done", "Done"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

const EXAMPLE_JSONL = [
  '{"custom_id": "summary-1", "prompt": "Summarize in one sentence: a signed receipt records the model, provider, tokens and cost of one call."}',
  '{"custom_id": "classify-1", "prompt": "Classify the sentiment as positive, neutral or negative: The deploy went smoothly."}',
  '{"custom_id": "batch-style-1", "method": "POST", "url": "/v1/chat/completions", "body": {"messages": [{"role": "system", "content": "Answer in five words or fewer."}, {"role": "user", "content": "What does an inference router do?"}], "max_tokens": 32}}',
].join("\n");
const EXAMPLE_CSV = [
  "custom_id,prompt",
  'summary-1,"Summarize in one sentence: a signed receipt records the model, provider, tokens and cost of one call."',
  'classify-1,"Classify the sentiment as positive, neutral or negative: The deploy went smoothly."',
].join("\n");

// ---------------------------------------------------------------- pieces

function Field({ label, id, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

function Figure({ label, value, sub }) {
  return (
    <div className={styles.figure}>
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      <span>{sub}</span>
    </div>
  );
}

function Concurrency({ id, value, onChange, disabled }) {
  return (
    <div className={styles.slider}>
      <label htmlFor={id}>Concurrency</label>
      <input id={id} type="range" min={CONCURRENCY.min} max={CONCURRENCY.max} step={1} value={value} disabled={disabled} onChange={(e) => onChange(clampConcurrency(e.target.value))} aria-valuetext={`${value} request${value === 1 ? "" : "s"} at once`} />
      <output htmlFor={id} aria-hidden="true">
        {value}
      </output>
      <small>Requests in flight at once ({CONCURRENCY.min}–{CONCURRENCY.max}). A 429 holds the whole batch until the router’s Retry-After passes.</small>
    </div>
  );
}

// ---------------------------------------------------------------- tab

export default function BatchStudio({ live, apiKey, ws, catalog, refresh, notify, navigate }) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  store.hooks = { notify, refresh };
  const keyHash = live ? ws?.me?.hash || "" : "";
  const [ready, setReady] = useState(() => !live || (store.loaded && store.keyHash === keyHash));
  const [routes, setRoutes] = useState({ list: [], state: live ? "loading" : "off" });

  useEffect(() => {
    if (!live) return setReady(true);
    if (!keyHash) return;
    if (store.keyHash === keyHash && store.loaded) return setReady(true);
    if (store.run) {
      // Another key's batch: stop starting its rows (or stop watching a server batch). It stays saved in this browser under that key.
      if (store.run.server) clearTimeout(store.run.timer);
      else store.run.runner.pause({ kind: "key" });
      saveNow();
      store.run = null;
    }
    Object.assign(store, { keyHash, loaded: false, persisted: null, draft: null, lastStatus: null });
    setReady(false);
    loadSaved(keyHash, apiKey).finally(() => setReady(true));
  }, [live, keyHash, apiKey]);

  // Saved routes are optional: a router without them (404) or an empty list simply shows models only.
  useEffect(() => {
    if (!live || !apiKey) return;
    let alive = true;
    api("/api/v1/routes", { key: apiKey })
      .then((r) => alive && setRoutes({ list: normalizeRoutes(r), state: "ok" }))
      .catch((e) => alive && setRoutes({ list: [], state: e?.status === 404 || e?.status === 405 ? "none" : "error" }));
    return () => {
      alive = false;
    };
  }, [live, apiKey]);

  const models = useMemo(() => (live ? (catalog || []).filter((m) => m.type !== "Embeddings") : sampleModels), [live, catalog]);
  const priceOf = useMemo(() => priceIndex(models, routes.list), [models, routes.list]);
  const run = store.run;

  return (
    <>
      <div className="panel-heading">
        <div>
          <h2>{live ? "Run many calls at once." : "Try the batch format."}</h2>
          <p className="help-text">Upload JSONL or CSV, check the estimate, then send every row from this browser and download the results.</p>
        </div>
        <span className="badge">{!live ? "Sample workspace · nothing is sent" : run?.server ? "Runs on the server" : "Runs in this browser"}</span>
      </div>
      {run?.server && live ? (
        <div className={"note " + styles.privacy}>
          <strong>This batch runs on the server.</strong> The router keeps its rows and answers sealed (encrypted) outside the database until the results expire, then deletes them; the database keeps only counts, costs, statuses and receipt ids.
          This browser keeps its copy of the input and the results (IndexedDB).
        </div>
      ) : (
        <div className={"note " + styles.privacy}>
          <strong>Batches run from this browser.</strong> Rows are sent to the router one request at a time and are not stored on Anyroute’s servers.{" "}
          {live ? "Input and progress are kept in this browser (IndexedDB) so a reload can resume." : "In the sample workspace nothing is sent and no results are produced."}
        </div>
      )}
      {!ready ? (
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Loading saved batch…
        </div>
      ) : run && live ? (
        run.server ? (
          <ServerRunView run={run} navigate={navigate} />
        ) : (
          <RunView run={run} navigate={navigate} />
        )
      ) : (
        <Composer live={live} apiKey={apiKey} ws={ws} models={models} routes={routes} priceOf={priceOf} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- input, defaults and pre-flight

function Composer({ live, apiKey, ws, models, routes, priceOf }) {
  const d = store.draft || {};
  const [text, setText] = useState(d.text || "");
  const [fileName, setFileName] = useState(d.fileName || "");
  const [format, setFormat] = useState(d.format || "auto");
  const [model, setModel] = useState(d.model ?? null); // null: not chosen yet, "": rows set their own
  const [attested, setAttested] = useState(live && d.attested === true); // run every row on the attested lane
  const [laneList, setLaneList] = useState({ state: "idle", ids: new Set() }); // models with a live attested provider
  const [maxTokens, setMaxTokens] = useState(d.maxTokens ?? "512");
  const [temperature, setTemperature] = useState(d.temperature ?? "");
  const [extra, setExtra] = useState(d.extra || "");
  const [concurrency, setConcurrency] = useState(clampConcurrency(d.concurrency ?? CONCURRENCY.default));
  const [server, setServer] = useState(live && d.server === true); // run on the router's Batch API instead of this browser
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [fileError, setFileError] = useState("");
  const [drag, setDrag] = useState(false);
  const [modal, setModal] = useState(null);
  const [funds, setFunds] = useState(null);
  const [submit, setSubmit] = useState(null); // a server batch being sent: { busy } or { error, lines }

  // The attested lane limits the pickers to what the router lists for it (GET /api/v1/models?lane=attested).
  useEffect(() => {
    if (!attested || !live) return;
    let alive = true;
    setLaneList({ state: "loading", ids: new Set() });
    api("/api/v1/models?lane=attested", { key: apiKey })
      .then((r) => alive && setLaneList({ state: "ok", ids: new Set((r?.data || []).map((m) => m.id)) }))
      .catch(() => alive && setLaneList({ state: "error", ids: new Set() }));
    return () => {
      alive = false;
    };
  }, [attested, live, apiKey]);
  const laneReady = attested && laneList.state === "ok";
  const pickModels = useMemo(() => (!attested ? models : laneReady ? modelsOnLane(models, laneList.ids) : []), [attested, laneReady, laneList, models]);
  const pickRoutes = useMemo(() => (!attested ? routes.list : laneReady ? routesOnLane(routes.list, laneList.ids) : []), [attested, laneReady, laneList, routes.list]);

  useEffect(() => {
    if (model === null && pickModels.length) setModel(pickModels[0].id);
  }, [model, pickModels]);
  // Turning the lane on drops a default that has no attested provider instead of leaving it to be refused row by row.
  useEffect(() => {
    if (!laneReady || !model) return;
    if (!pickModels.some((m) => m.id === model) && !pickRoutes.some((r) => "@route/" + r.slug === model)) setModel(pickModels[0]?.id ?? "");
  }, [laneReady, model, pickModels, pickRoutes]);
  useEffect(() => {
    store.draft = { text, fileName, format, model, maxTokens, temperature, extra, concurrency, attested, server };
    scheduleSave(1000);
  }, [text, fileName, format, model, maxTokens, temperature, extra, concurrency, attested, server]);

  const lane = attested ? ATTESTED_LANE : null;
  const { defaults, error: defaultsError } = useMemo(() => buildDefaults({ model: model || "", maxTokens, temperature, extra, lane }), [model, maxTokens, temperature, extra, lane]);
  const source = useDeferredValue(text);
  const parsed = useMemo(() => parseBatch(source, { format, fileName, defaults }), [source, format, fileName, defaults]);
  const browserEstimate = useMemo(() => estimateBatch(parsed.rows, priceOf), [parsed, priceOf]);
  const serverEstimate = useMemo(() => (server ? estimateServerBatch(parsed.rows, priceOf) : null), [server, parsed, priceOf]);
  const estimate = serverEstimate || browserEstimate; // a server batch is billed at the batch discount
  const requests = useMemo(() => (server ? toServerRequests(parsed.rows) : null), [server, parsed]);
  const serverCheck = useMemo(() => (requests ? checkServerBatch(requests) : null), [requests]);
  const checking = source !== text;
  const fundsNow = live ? checkFunds(estimate.maxCost, { available: ws?.credits?.available, budgetRemaining: ws?.me?.limit_remaining }) : null;
  const rpm = ws?.me?.rate_limit?.requests;
  const hasInvalid = parsed.invalid > 0 || (parsed.errors.length > 0 && !parsed.rows.length);
  const offLane = laneReady ? rowsOffLane(parsed.rows, laneList.ids, routes.list) : null;
  const hint = (() => {
    if (attested && laneList.state === "error") return "The attested model list did not load. Turn the option off, or reload and try again.";
    if (attested && !laneReady) return "Loading the models on the attested lane…";
    if (laneReady && !laneList.ids.size) return "No model has a live attested provider right now.";
    if (!text.trim()) return "Add rows to see the estimate.";
    if (checking) return "Checking rows…";
    if (parsed.tooMany) return `Batches hold up to ${int(MAX_ROWS)} rows.`;
    if (!parsed.rows.length) return "No valid rows yet.";
    if (defaultsError) return "Fix the default parameters first.";
    if (parsed.invalid && !skipInvalid) return "Fix the invalid rows, or choose to skip them.";
    if (serverCheck?.error) return serverCheck.error;
    return "";
  })();
  const canStart = live && !hint;
  const knownModel = !model || pickModels.some((m) => m.id === model) || pickRoutes.some((r) => "@route/" + r.slug === model);

  async function loadFile(file) {
    setFileError("");
    if (!file) return;
    if (file.size > MAX_INPUT_CHARS) return setFileError(`${file.name} is ${size(file.size)}. Batch Studio reads files up to ${size(MAX_INPUT_CHARS)}; split it into smaller files.`);
    try {
      const content = await file.text();
      setFileName(file.name);
      setText(content);
      setSkipInvalid(false);
    } catch {
      setFileError("This file could not be read.");
    }
  }
  function loadExample(kind) {
    setFileName("");
    setFormat("auto");
    setText(kind === "csv" ? EXAMPLE_CSV : EXAMPLE_JSONL);
    setSkipInvalid(false);
  }
  function clear() {
    setText("");
    setFileName("");
    setFileError("");
    setSkipInvalid(false);
  }
  async function review() {
    setModal("start");
    setSubmit(null);
    setFunds({ loading: true });
    try {
      const [c, k] = await Promise.all([api("/api/v1/credits", { key: apiKey }), api("/api/v1/key", { key: apiKey })]);
      setFunds({ available: c?.data?.available, budgetRemaining: k?.data?.limit_remaining ?? null, rpm: k?.data?.rate_limit?.requests ?? null });
    } catch (e) {
      setFunds({ available: ws?.credits?.available, budgetRemaining: ws?.me?.limit_remaining ?? null, rpm: rpm ?? null, stale: e?.message || "The balance could not be refreshed." });
    }
  }
  async function startServer() {
    setSubmit({ busy: true });
    try {
      const batch = await api("/api/v1/batches", { key: apiKey, method: "POST", body: { requests, completion_window: "24h" } });
      if (!batch?.id) throw new Error("The router did not return a batch id.");
      setModal(null);
      setSubmit(null);
      const run = attachServerRun(
        {
          id: batch.id,
          createdAt: Date.now(),
          rows: parsed.rows,
          batch,
          sourceName: fileName || "Pasted rows",
          model: model || "",
          lane,
          estimate: { input: estimate.input, output: estimate.output, maxCost: estimate.maxCost, listMaxCost: estimate.listMaxCost, unpriced: estimate.unpriced },
          skipped: parsed.invalid,
        },
        apiKey,
      );
      saveNow();
      bump();
      watchServer(run);
    } catch (e) {
      setSubmit({ error: e?.message || "The batch could not be sent.", lines: serverLineErrors(e, parsed.rows) });
    }
  }
  function start() {
    if (server) return startServer();
    setModal(null);
    const runner = attachRun(
      {
        id: Date.now().toString(36),
        createdAt: Date.now(),
        rows: parsed.rows,
        concurrency,
        sourceName: fileName || "Pasted rows",
        model: model || "",
        lane,
        estimate: { input: estimate.input, output: estimate.output, maxCost: estimate.maxCost, unpriced: estimate.unpriced },
        skipped: parsed.invalid,
      },
      apiKey,
    );
    store.lastStatus = null;
    runner.start();
  }

  const editable = text.length <= EDITABLE_CHARS;
  const check = funds && !funds.loading ? checkFunds(estimate.maxCost, funds) : null;
  const detected = parsed.format === "csv" ? "CSV" : "JSONL";

  return (
    <div className={styles.grid}>
      <section
        className={styles.panel + (drag ? " " + styles.drop : "")}
        aria-labelledby="batch-input-title"
        onDragOver={(e) => {
          if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          setDrag(false);
          loadFile(e.dataTransfer.files[0]);
        }}
      >
        <h3 id="batch-input-title">Input</h3>
        <div className={styles.fileRow}>
          <div className={"field " + styles.fileField}>
            <label htmlFor="batch-file">Upload JSONL or CSV</label>
            <input
              id="batch-file"
              className={styles.fileInput}
              type="file"
              accept=".jsonl,.ndjson,.json,.csv,text/csv,application/json,application/x-ndjson"
              onChange={(e) => {
                loadFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          <div className={"field " + styles.formatField}>
            <label htmlFor="batch-format">Format</label>
            <select id="batch-format" value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="auto">Auto-detect{text.trim() ? ` (${detected})` : ""}</option>
              <option value="jsonl">JSONL</option>
              <option value="csv">CSV</option>
            </select>
          </div>
        </div>
        {fileError && (
          <div className="error" role="alert">
            {fileError}
          </div>
        )}
        {(fileName || !editable) && (
          <div className={styles.source}>
            <span>
              <strong>{fileName || "Pasted rows"}</strong> · {size(text.length)} · {detected}
            </span>
            <button type="button" className="text-button" onClick={clear}>
              Clear input
            </button>
          </div>
        )}
        {editable ? (
          <div className={styles.input}>
            <Field label={fileName ? "Rows (edit before running)" : "Or paste rows"} id="batch-text">
              <textarea
                id="batch-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                aria-describedby="batch-format-help"
                placeholder={'{"custom_id": "q1", "prompt": "Summarize this paragraph…"}\n{"custom_id": "q2", "body": {"model": "…", "messages": [{"role": "user", "content": "…"}]}}'}
              />
            </Field>
          </div>
        ) : (
          <p className="help-text">This input is too large to edit here. Fix it in your editor and upload it again, or clear it.</p>
        )}
        <div className={styles.examples}>
          <span>Examples</span>
          <button type="button" className="text-button" onClick={() => loadExample("jsonl")}>
            JSONL
          </button>
          <button type="button" className="text-button" onClick={() => loadExample("csv")}>
            CSV
          </button>
          {text && editable && !fileName && (
            <button type="button" className="text-button" onClick={clear}>
              Clear
            </button>
          )}
        </div>
        <p className="help-text" id="batch-format-help">
          JSONL: one object per line, either an OpenAI batch line {'{"custom_id", "body": {"model", "messages", …}}'} or a simple line {'{"custom_id"?, "prompt", "model"?}'}. CSV: a header row with a
          prompt column and optional custom_id and model columns. Up to {int(MAX_ROWS)} rows; streaming is turned off for every row.
        </p>

        <div className={styles.subhead}>Defaults for rows that don’t set them</div>
        <label className="check-label">
          <input type="checkbox" checked={attested} disabled={!live} onChange={(e) => setAttested(e.target.checked)} /> Run on the attested lane
        </label>
        <p className="help-text" id="batch-lane-help">
          {live
            ? 'Sends provider.lane "attested" with every row. The router serves a row only from a provider with a fresh, verified attestation, or refuses it; it never falls back to a provider that is not attested. Results show the lane and receipt id of each row, and a refused or withheld row is marked failed closed.'
            : "Running on the attested lane needs a live key."}
        </p>
        <Field label={attested ? "Model or saved route on the attested lane" : "Model or saved route"} id="batch-model">
          <select id="batch-model" value={model ?? ""} disabled={attested && !laneReady} aria-describedby={attested ? "batch-lane-help" : undefined} onChange={(e) => setModel(e.target.value)}>
            <option value="">{attested && !laneReady ? (laneList.state === "error" ? "The attested model list did not load" : "Loading attested models…") : "No default: every row sets its model"}</option>
            {!knownModel && <option value={model}>{model}</option>}
            {pickRoutes.length > 0 && (
              <optgroup label="Saved routes">
                {pickRoutes.map((r) => (
                  <option key={r.slug} value={"@route/" + r.slug}>
                    {r.name} · @route/{r.slug}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={attested ? "Models with an attested provider" : live ? "Models" : "Sample models"}>
              {pickModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {live ? m.id : m.name}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        {live && routes.state === "error" && <p className="help-text">Saved routes could not be loaded; models are still available.</p>}
        <div className={styles.pair}>
          <Field label="Max tokens" id="batch-max-tokens">
            <input id="batch-max-tokens" type="number" inputMode="numeric" min="1" step="1" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="Router default" />
          </Field>
          <Field label="Temperature" id="batch-temperature">
            <input id="batch-temperature" type="number" inputMode="decimal" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="Model default" />
          </Field>
        </div>
        <details className={styles.more} open={!!extra}>
          <summary>More default parameters (JSON)</summary>
          <Field label="Extra parameters" id="batch-extra">
            <textarea id="batch-extra" value={extra} onChange={(e) => setExtra(e.target.value)} spellCheck={false} placeholder={'{"top_p": 0.9, "provider": {"private": true}}'} />
          </Field>
        </details>
        {defaultsError && (
          <p className={styles.fieldError} role="alert">
            {defaultsError}
          </p>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="batch-preflight-title">
        <h3 id="batch-preflight-title">Pre-flight</h3>
        <div className={styles.figures} aria-live="polite" aria-busy={checking || undefined}>
          <Figure label="Rows" value={int(parsed.rows.length)} sub={parsed.invalid ? `${int(parsed.invalid)} invalid · ${int(parsed.total)} read` : `Up to ${int(MAX_ROWS)}`} />
          <Figure label="Input tokens" value={"≈ " + int(estimate.input)} sub="Prompt characters ÷ 4" />
          <Figure label="Output tokens" value={"≤ " + int(estimate.output)} sub="max_tokens per row" />
          <Figure label="Max cost / USDG" value={money(estimate.maxCost, 6)} sub={server ? `50% off ${money(estimate.listMaxCost, 6)} list` : live ? "From catalog prices" : "Sample prices"} />
        </div>
        {estimate.unpriced > 0 && (
          <div className={styles.check + " " + styles.warn}>
            <span>
              <b>{int(estimate.unpriced)} rows</b> use a model or route without a catalog price ({estimate.unpricedModels.slice(0, 3).join(", ")}
              {estimate.unpricedModels.length > 3 ? ", …" : ""}). They are not in the maximum above.
            </span>
          </div>
        )}
        {offLane?.count > 0 && (
          <div className={styles.check + " " + styles.warn}>
            <span>
              <b>{int(offLane.count)} rows</b> use a model without a live attested provider ({offLane.models.join(", ")}). The router refuses these rows and charges nothing; they are listed as failed closed.
            </span>
          </div>
        )}
        {!live ? (
          <div className={styles.check + " " + styles.muted}>Balance check needs a live key.</div>
        ) : !fundsNow.known ? null : fundsNow.enough ? (
          <div className={styles.check}>
            <span>
              Within your {fundsNow.source === "budget" ? "key’s remaining budget" : "available balance"}: <b>{money(fundsNow.limit, 6)} USDG</b>.
            </span>
          </div>
        ) : (
          <div className={styles.check + " " + styles.warn}>
            <span>
              The maximum is above your {fundsNow.source === "budget" ? "key’s remaining budget" : "available balance"} (<b>{money(fundsNow.limit, 6)} USDG</b>). Actual cost is usually lower;{" "}
              {server
                ? "if the money runs out, the rows the router cannot pay for fail with insufficient_credits and are not charged."
                : "if the money runs out, the router declines rows with 402 and the batch pauses so you can add funds and resume."}
            </span>
          </div>
        )}
        {serverCheck?.warnings.map((w) => (
          <div key={w} className={styles.check + " " + styles.warn}>
            <span>{w}</span>
          </div>
        ))}
        {live && rpm ? <p className="help-text">This key allows {int(rpm)} requests per minute. Rate-limited rows wait and retry automatically.</p> : null}
        {parsed.ignoredColumns.length > 0 && <p className="help-text">Ignored CSV columns: {parsed.ignoredColumns.join(", ")}.</p>}
        {parsed.errors.length > 0 && (
          <div className={styles.issues} role="region" aria-labelledby="batch-issues-title">
            <h4 id="batch-issues-title">
              {int(parsed.errors.length)} problem{parsed.errors.length === 1 ? "" : "s"} found
            </h4>
            <ul tabIndex={0} aria-label="Rows with problems">
              {parsed.errors.slice(0, 100).map((e, k) => (
                <li key={k}>
                  <b>{e.line ? "Line " + e.line : "Input"}</b>
                  <span>
                    {e.custom_id && <code>{e.custom_id}</code>}
                    {e.message}
                  </span>
                </li>
              ))}
            </ul>
            {parsed.errors.length > 100 && <p>…and {int(parsed.errors.length - 100)} more. Fix these and check again.</p>}
          </div>
        )}
        {parsed.invalid > 0 && parsed.rows.length > 0 && !parsed.tooMany && (
          <label className="check-label">
            <input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} /> Skip the {int(parsed.invalid)} invalid row{parsed.invalid === 1 ? "" : "s"} and run the {int(parsed.rows.length)} valid ones
          </label>
        )}
        <div className={styles.runOn} role="radiogroup" aria-label="Where the batch runs" aria-describedby={server ? "batch-run-on-help" : undefined}>
          <label className="check-label">
            <input type="radio" name="batch-run-on" checked={!server} onChange={() => setServer(false)} /> Run in this browser
          </label>
          <label className="check-label">
            <input type="radio" name="batch-run-on" checked={server} disabled={!live} onChange={() => setServer(true)} /> Run on the server (50% off)
          </label>
        </div>
        {server ? (
          <p className={styles.runOnHelp} id="batch-run-on-help">
            The router runs the rows in the background, in spare capacity, at half the normal price; failed rows are not charged. It can take minutes, and rows not run within 24 hours expire unbilled. You can close this tab. The router keeps the rows and answers
            sealed until the results expire, 24 hours after the batch finishes by default.
          </p>
        ) : (
          <Concurrency id="batch-concurrency" value={concurrency} onChange={setConcurrency} />
        )}
        <div className={styles.startRow}>
          <Button onClick={review} disabled={!canStart} aria-describedby="batch-start-hint">
            {live ? "Review and start" : "Run batch"}
          </Button>
          <span className={styles.locked} id="batch-start-hint">
            {!live ? "Connect a live key to run batches." : hint || (hasInvalid ? "Invalid rows will be skipped." : `${int(parsed.rows.length)} rows ready.`)}
          </span>
        </div>
      </section>

      {modal === "start" && (
        <Modal title={server ? "Send this batch to the server?" : "Start this batch?"} onClose={() => setModal(null)}>
          {server ? (
            <p>
              {int(parsed.rows.length)} rows go to the router’s Batch API and run there in the background. Each row is billed at {100 - SERVER_DISCOUNT_BPS / 100}% of the normal price, a failed row is not charged, and every answered row gets its own signed receipt.
            </p>
          ) : (
            <p>
              {int(parsed.rows.length)} rows go to the router from this browser, {concurrency} at a time. Each row is billed like a normal call and gets its own signed receipt.
            </p>
          )}
          <dl className="detail-list">
            <div>
              <dt>Rows</dt>
              <dd>
                {int(parsed.rows.length)}
                {parsed.invalid ? ` · ${int(parsed.invalid)} invalid skipped` : ""}
              </dd>
            </div>
            <div>
              <dt>Default model</dt>
              <dd className="mono">{model || "Set on every row"}</dd>
            </div>
            <div>
              <dt>Lane</dt>
              <dd>{attested ? "Attested: rows the router cannot serve there fail closed" : "Public, the default"}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>
                ≈ {int(estimate.input)} in · up to {int(estimate.output)} out
              </dd>
            </div>
            <div>
              <dt>Max cost</dt>
              <dd>
                {money(estimate.maxCost, 6)} USDG{server ? ` (50% off ${money(estimate.listMaxCost, 6)})` : ""}
                {estimate.unpriced ? ` · plus ${int(estimate.unpriced)} unpriced rows` : ""}
              </dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{funds?.loading ? "Checking…" : funds?.available != null ? money(funds.available, 6) + " USDG" : "Unknown"}</dd>
            </div>
            <div>
              <dt>Key budget left</dt>
              <dd>{funds?.loading ? "Checking…" : funds?.budgetRemaining == null ? "No budget limit" : money(funds.budgetRemaining, 6) + " USDG"}</dd>
            </div>
            {server ? (
              <div>
                <dt>Runs</dt>
                <dd>
                  On the server, within 24 hours{funds?.rpm ? ` · key limit ${int(funds.rpm)} requests/min` : ""}
                </dd>
              </div>
            ) : (
              <div>
                <dt>Concurrency</dt>
                <dd>
                  {concurrency} at once{funds?.rpm ? ` · key limit ${int(funds.rpm)} requests/min` : ""}
                </dd>
              </div>
            )}
          </dl>
          {funds?.stale && <p className="help-text">Showing the last known balance: {funds.stale}</p>}
          {check?.known && !check.enough && (
            <div className="error" role="alert">
              The maximum is {money(check.shortfall, 6)} USDG above your {check.source === "budget" ? "key’s remaining budget" : "available balance"}.{" "}
              {server ? "Rows the router cannot pay for fail and are not charged." : "The batch pauses if the router declines a row for lack of funds."}
            </div>
          )}
          {server ? (
            <div className="note">You can close this tab once the batch is sent: it runs on the router. Come back to Batch Studio for its progress and results; the router keeps the results for 24 hours after the batch finishes.</div>
          ) : (
            <div className="note">Keep this tab open until the batch finishes. Other dashboard sections are fine; closing or reloading the page pauses the batch, and you can resume it here.</div>
          )}
          {submit?.error && (
            <div className="error" role="alert">
              {submit.error}
              {submit.lines?.length > 0 && (
                <ul className={styles.lineErrors}>
                  {submit.lines.slice(0, 20).map((e, k) => (
                    <li key={k}>
                      {e.line ? `Line ${e.line}` : "Input"}
                      {e.custom_id ? ` (${e.custom_id})` : ""}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="button-row modal-actions">
            <Button onClick={start} disabled={!!funds?.loading || !!submit?.busy}>
              {server ? (submit?.busy ? "Sending…" : check?.known && !check.enough ? "Send anyway" : "Send batch") : check?.known && !check.enough ? "Start anyway" : "Start batch"}
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Back
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- run, progress and results

function PauseReason({ runner, remaining, navigate }) {
  const reason = runner.reason || {};
  if (reason.kind === "funds")
    return (
      <div className="error" role="alert">
        Paused: {reason.message} The row the router declined is first in line when you resume.{" "}
        <button type="button" className="text-button" onClick={() => navigate(reason.type === "key_budget_exceeded" ? "API keys" : "Payments")}>
          {reason.type === "key_budget_exceeded" ? "Raise the key’s budget →" : "Add funds →"}
        </button>
      </div>
    );
  if (reason.kind === "auth")
    return (
      <div className="error" role="alert">
        Paused: the router rejected this key ({reason.message}). Resume once the key works again.
      </div>
    );
  if (reason.kind === "reload")
    return (
      <div className="note">
        Restored from this browser after the page closed.{" "}
        {reason.interrupted
          ? `${int(reason.interrupted)} row${reason.interrupted === 1 ? " was" : "s were"} in flight and ${reason.interrupted === 1 ? "is" : "are"} marked failed as interrupted: ${reason.interrupted === 1 ? "it" : "they"} may have completed and been billed, so check Receipts before retrying. `
          : ""}
        Resume to run the remaining {int(remaining)} rows.
      </div>
    );
  return <div className="note">Paused. Requests already in flight finish; no new rows start until you resume.</div>;
}

function RunView({ run, navigate }) {
  const r = run.runner;
  const laneRun = run.lane === ATTESTED_LANE;
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [modal, setModal] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = r.status === "running" || r.inflight.size > 0;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const s = summarize(r.states);
  const total = r.rows.length;
  const answered = s.done + s.failed; // cancelled rows are not progress
  const remaining = s.pending + s.waiting + s.running;
  const pct = total ? Math.floor((answered / total) * 100) : 0;
  const rpm = r.status === "running" ? r.rowsPerMinute() : null;
  const ended = r.status === "completed" || r.status === "cancelled";
  const retryable = s.failed + s.cancelled;
  const label = r.status === "running" ? "Running" : r.status === "paused" ? (r.inflight.size ? "Pausing" : "Paused") : r.status === "completed" ? "Finished" : "Cancelled";
  const pill = { running: "running", paused: "waiting", completed: "done", cancelled: "cancelled" }[r.status] || "pending";
  const closed = countFailedClosed(r.states);

  const note = (st) => {
    if (st.status === "waiting") {
      const wait = Math.max(0, Math.ceil((st.nextAt - now) / 1000));
      return st.error?.status === 429 ? `Rate limited · retrying in ${wait} s` : `Retry ${st.retries} of ${MAX_RETRIES} in ${wait} s · ${st.error?.message || "request failed"}`;
    }
    if (st.status === "failed") return st.error?.message;
    return "";
  };
  const setConcurrency = (n) => {
    r.setConcurrency(n);
    scheduleSave();
    bump();
  };

  return (
    <>
      <p className="sr-only" role="status">
        Batch {label.toLowerCase()}.{r.status === "paused" && r.reason?.message ? " " + r.reason.message : ""}
      </p>
      <div className="panel-heading">
        <div>
          <h2>{{ Running: "Batch running.", Pausing: "Pausing the batch.", Paused: "Batch paused.", Finished: "Batch finished.", Cancelled: "Batch cancelled." }[label]}</h2>
          <p className="help-text">
            {run.sourceName} · {int(total)} rows{run.skipped ? ` (${int(run.skipped)} invalid skipped)` : ""} · default {run.model || "set per row"}{laneRun ? " · attested lane" : ""} · started {time(run.createdAt)}
          </p>
        </div>
        <span className={styles.pill} data-status={pill}>
          {label}
        </span>
      </div>
      {r.status === "paused" && !r.inflight.size && <PauseReason runner={r} remaining={remaining} navigate={navigate} />}
      {laneRun && (
        <div className="note">
          <strong>Attested lane.</strong> Every row asked for provider.lane attested. A row is answered only by an attested provider, and this page keeps an answer only when the response states that lane. A row the router refuses or withholds is marked failed closed; it is never answered from another provider.
        </div>
      )}
      {store.persisted === false && <div className="note">This browser could not save progress (private browsing or blocked storage). Keep the tab open: a reload cannot resume this batch.</div>}

      <section className={styles.panel} aria-labelledby="batch-progress-title">
        <h3 id="batch-progress-title">Progress</h3>
        <div className={styles.progressHead}>
          <strong>
            {int(answered)} of {int(total)} rows
          </strong>
          <span>
            {pct}% · {int(remaining)} left{s.cancelled ? ` · ${int(s.cancelled)} cancelled` : ""}
          </span>
        </div>
        <progress className={styles.progress} max={total || 1} value={answered} aria-label={`Batch progress: ${int(answered)} of ${int(total)} rows answered`} />
        <div className={styles.figures + " " + styles.wide}>
          <Figure label="Succeeded" value={int(s.done)} sub="HTTP 200" />
          <Figure label="Failed" value={int(s.failed)} sub={closed ? `${int(closed)} failed closed` : s.cancelled ? `${int(s.cancelled)} cancelled` : "After retries"} />
          <Figure label="In flight" value={int(r.inflight.size)} sub={s.waiting ? `${int(s.waiting)} waiting to retry` : `of ${r.concurrency} at once`} />
          <Figure label="Rows / min" value={rpm == null ? "—" : int(rpm)} sub={r.status === "running" ? "Last minute" : "While running"} />
          <Figure label="Spend so far" value={money(s.cost, 6)} sub="USDG · usage.cost" />
          <Figure label="Elapsed" value={duration((run.endedAt || now) - run.createdAt)} sub={"Since " + time(run.createdAt)} />
        </div>
        <div className={styles.controls}>
          <div className="button-row">
            {r.status === "running" && <Button onClick={() => r.pause()}>Pause</Button>}
            {r.status === "paused" && <Button onClick={() => r.resume()}>Resume</Button>}
            {(r.status === "running" || r.status === "paused") && (
              <Button secondary onClick={() => setModal({ type: "cancel" })}>
                Cancel batch
              </Button>
            )}
            {ended && retryable > 0 && (
              <Button onClick={() => r.retry() && (setFilter("all"), setPage(0))} disabled={r.inflight.size > 0}>
                {s.cancelled ? `Retry failed and cancelled rows (${int(retryable)})` : `Retry failed rows (${int(retryable)})`}
              </Button>
            )}
            {ended && (
              <Button secondary onClick={() => setModal({ type: "discard" })}>
                New batch
              </Button>
            )}
            {r.status === "paused" && (
              <button type="button" className="text-button" onClick={() => setModal({ type: "discard" })}>
                Discard batch
              </button>
            )}
          </div>
          <Concurrency id="batch-run-concurrency" value={r.concurrency} onChange={setConcurrency} disabled={ended} />
        </div>
        {!ended && <p className={styles.keepOpen}>Keep this tab open until the batch finishes. Other dashboard sections are fine; closing or reloading the page pauses the batch.</p>}
      </section>

      <Results
        rows={r.rows}
        states={r.states}
        laneRun={laneRun}
        intro={"Built in this browser from the router’s responses. " + (ended ? "" : "Rows that have not run yet are included with the error code not_run.")}
        fileBase={`anyroute-batch-${run.id}`}
        estimate={run.estimate}
        note={note}
        view={{ filter, setFilter, query, setQuery, page, setPage }}
        onInspect={(i) => setModal({ type: "row", index: i })}
      />

      {modal?.type === "row" && <RowDetails row={r.rows[modal.index]} st={r.states[modal.index]} laneRun={laneRun} navigate={navigate} onClose={() => setModal(null)} />}
      {modal?.type === "cancel" && (
        <Modal title="Cancel this batch?" onClose={() => setModal(null)}>
          <p>Requests in flight are stopped and no new rows start. A provider may already have done, and the router billed, work for requests in flight. Finished rows stay available to download.</p>
          <div className="button-row modal-actions">
            <Button
              onClick={() => {
                setModal(null);
                r.cancel();
              }}
            >
              Cancel batch
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Keep running
            </Button>
          </div>
        </Modal>
      )}
      {modal?.type === "discard" && (
        <Modal title={ended ? "Start a new batch?" : "Discard this batch?"} onClose={() => setModal(null)}>
          <p>This clears the batch and its results from this browser. Download the results first if you need them. Your input stays in the editor.</p>
          <div className="button-row modal-actions">
            <Button
              onClick={() => {
                setModal(null);
                discardRun();
              }}
            >
              {ended ? "Clear and start over" : "Discard batch"}
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Keep it
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** The results of a batch, from this browser or from the server: downloads, totals, and the rows by status, page by page. */
function Results({ rows, states, laneRun, intro, fileBase, estimate, note, view, onInspect }) {
  const { filter, setFilter, query, setQuery, page, setPage } = view;
  const s = summarize(states);
  const total = rows.length;
  const answered = s.done + s.failed;
  const q = query.trim().toLowerCase();
  const list = [];
  const inFilter = (st) => filter === "all" || (filter === "closed" ? !!failClosed(st) : st.status === filter);
  for (let i = 0; i < total; i++) if (inFilter(states[i]) && (!q || rows[i].custom_id.toLowerCase().includes(q))) list.push(i);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const pg = Math.min(page, pages - 1);
  const shown = list.slice(pg * PAGE, pg * PAGE + PAGE);
  const closed = countFailedClosed(states);
  const counts = { all: total, ...s, closed };
  const filters = laneRun ? [...FILTERS, ["closed", "Failed closed"]] : FILTERS;

  return (
    <>
      <div className="panel-heading">
        <div>
          <h2>Results</h2>
          <p className="help-text">{intro}</p>
        </div>
        <div className={styles.results}>
          <Button onClick={() => download(toJSONL(rows, states, { lane: laneRun }), `${fileBase}.jsonl`, "application/jsonl")} disabled={!answered && !s.cancelled}>
            Download JSONL
          </Button>
          <Button secondary onClick={() => download(toCSV(rows, states, { lane: laneRun }), `${fileBase}.csv`, "text/csv")} disabled={!answered && !s.cancelled}>
            Download CSV
          </Button>
        </div>
      </div>
      <div className={styles.figures + " " + styles.four}>
        <Figure label="Succeeded" value={int(s.done)} sub={`of ${int(total)} rows`} />
        <Figure label="Failed" value={int(s.failed)} sub={closed ? `${int(closed)} failed closed${s.cancelled ? ` · plus ${int(s.cancelled)} cancelled` : ""}` : s.cancelled ? `Plus ${int(s.cancelled)} cancelled` : "Errors are in the download"} />
        <Figure label="Tokens" value={int(s.promptTokens + s.completionTokens)} sub={`${int(s.promptTokens)} in · ${int(s.completionTokens)} out`} />
        <Figure label="Actual cost / USDG" value={money(s.cost, 6)} sub={estimate ? `Estimated max ${money(estimate.maxCost, 6)}` : "From usage.cost"} />
      </div>

      <div className={styles.tools}>
        <input className="search-field" aria-label="Search rows by custom_id" placeholder="Search custom_id…" value={query} onChange={(e) => (setQuery(e.target.value), setPage(0))} />
        <select className="search-field" aria-label="Filter rows by status" value={filter} onChange={(e) => (setFilter(e.target.value), setPage(0))}>
          {filters.map(([value, name]) => (
            <option key={value} value={value}>
              {name} ({int(counts[value] || 0)})
            </option>
          ))}
        </select>
      </div>
      {shown.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Batch rows, page {pg + 1} of {pages}</caption>
            <thead>
              <tr>
                <th>Row</th>
                <th>Status</th>
                {laneRun && <th>Lane · receipt</th>}
                <th className="num">Tokens</th>
                <th className="num">Cost / USDG</th>
                <th>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const row = rows[i];
                const st = states[i];
                const u = st.status === "done" ? st.response?.body?.usage : null;
                const why = note(st);
                return (
                  <tr key={i}>
                    <td className="cell-primary">
                      <strong className="mono">{row.custom_id}</strong>
                      <small>
                        Line {row.line}
                        {st.attempts > 1 ? ` · ${st.attempts} attempts` : ""}
                      </small>
                    </td>
                    <td data-label="Status">
                      <span className={styles.pill} data-status={statusKey(st)}>
                        {statusLabel(st)}
                      </span>
                      {why && <small className={styles.rowNote}>{why}</small>}
                    </td>
                    {laneRun && (
                      <td data-label="Lane · receipt">
                        <span className={styles.lane} data-lane={st.served?.lane || "none"}>
                          {st.served?.lane || "—"}
                        </span>
                        {st.served?.receipt_id && (
                          <small className={styles.receipt} title={st.served.receipt_id}>
                            {st.served.receipt_id}
                          </small>
                        )}
                      </td>
                    )}
                    <td className="num" data-label="Tokens">
                      {u?.total_tokens != null ? int(u.total_tokens) : "—"}
                    </td>
                    <td className="num" data-label="Cost / USDG">
                      {u?.cost != null ? money(u.cost, 6) : "—"}
                    </td>
                    <td className="cell-action">
                      <button type="button" className="text-button" onClick={() => onInspect(i)} aria-label={"Inspect row " + row.custom_id}>
                        Inspect →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <h3>No rows match.</h3>
          <p>Try another status or search.</p>
        </div>
      )}
      {list.length > PAGE && (
        <div className={styles.pager}>
          <span>
            Rows {int(pg * PAGE + 1)}–{int(Math.min(list.length, (pg + 1) * PAGE))} of {int(list.length)}
          </span>
          <div className="button-row">
            <button type="button" className="text-button" disabled={pg === 0} onClick={() => setPage(pg - 1)}>
              ← Previous
            </button>
            <button type="button" className="text-button" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>
              Next →
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- a batch on the server

const SERVER_STATUS = {
  validating: ["Queued", "pending", "Batch queued on the server."],
  in_progress: ["Running", "running", "Batch running on the server."],
  cancelling: ["Cancelling", "waiting", "Cancelling the batch."],
  completed: ["Finished", "done", "Batch finished."],
  failed: ["Failed", "failed", "Batch failed."],
  expired: ["Expired", "cancelled", "Batch expired."],
  cancelled: ["Cancelled", "cancelled", "Batch cancelled."],
};
const unix = (s) => (Number.isFinite(Number(s)) && s != null ? Number(s) * 1000 : null);
const serverNote = (st) => (st.status === "failed" || st.status === "cancelled" ? st.error?.message : "");

function ServerRunView({ run, navigate }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [modal, setModal] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const b = run.batch || {};
  const p = serverProgress(b);
  const laneRun = run.lane === ATTESTED_LANE;
  const [label, pill, heading] = SERVER_STATUS[p.status];
  useEffect(() => {
    if (p.done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [p.done]);
  const started = unix(b.created_at) ?? run.createdAt;
  const ended = unix(b.completed_at ?? b.failed_at ?? b.expired_at ?? b.cancelled_at) ?? run.endedAt;
  const expires = unix(b.results_expire_at);
  const canCancel = !p.done && p.status !== "cancelling";

  return (
    <>
      <p className="sr-only" role="status">
        Server batch {label.toLowerCase()}.
      </p>
      <div className="panel-heading">
        <div>
          <h2>{heading}</h2>
          <p className="help-text">
            {run.sourceName} · {int(run.rows.length)} rows{run.skipped ? ` (${int(run.skipped)} invalid skipped)` : ""} · default {run.model || "set per row"}
            {laneRun ? " · attested lane" : ""} · started {time(started)} · <span className="mono">{b.id}</span>
          </p>
        </div>
        <span className={styles.pill} data-status={pill}>
          {label}
        </span>
      </div>
      {run.pollError && !p.done && <div className="error">The batch could not be checked just now ({run.pollError}). This page tries again shortly.</div>}
      {run.cancelError && <div className="error">{run.cancelError}</div>}

      <section className={styles.panel} aria-labelledby="batch-server-progress-title">
        <h3 id="batch-server-progress-title">Progress</h3>
        <div className={styles.progressHead}>
          <strong>
            {int(p.finished)} of {int(p.total)} rows
          </strong>
          <span>
            {p.pct}% · {int(p.remaining)} left
          </span>
        </div>
        <progress className={styles.progress} max={p.total || 1} value={p.finished} aria-label={`Batch progress: ${int(p.finished)} of ${int(p.total)} rows answered`} />
        <div className={styles.figures + " " + styles.wide}>
          <Figure label="Succeeded" value={int(p.completed)} sub="Billed at 50% off" />
          <Figure label="Failed" value={int(p.failed)} sub="Not charged" />
          <Figure label="Left" value={int(p.remaining)} sub={p.done ? "Not run, not charged" : "Waiting for the worker"} />
          <Figure label="Cost so far" value={money(p.cost, 6)} sub="USDG · batch price" />
          <Figure label="Saved" value={money(p.saved, 6)} sub={`USDG · list ${money(p.listCost, 6)}`} />
          <Figure label="Elapsed" value={duration((ended || now) - started)} sub={"Since " + time(started)} />
        </div>
        <div className={styles.controls}>
          <div className="button-row">
            {canCancel && (
              <Button secondary onClick={() => setModal({ type: "cancel" })}>
                Cancel batch
              </Button>
            )}
            {p.done && (
              <Button secondary onClick={() => setModal({ type: "discard" })}>
                New batch
              </Button>
            )}
          </div>
        </div>
        {!p.done && <p className={styles.serverNote}>The batch runs on the router, so you can close this tab. This page checks it every few seconds and reads the results when it finishes.</p>}
      </section>

      {run.results === "ready" ? (
        <Results
          rows={run.rows}
          states={run.states}
          laneRun={laneRun}
          intro={`Built from the batch’s output and errors files.${expires ? ` The router deletes them at ${new Date(expires).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}; this browser keeps its copy.` : ""}`}
          fileBase={`anyroute-${b.id || "batch-" + run.id}`}
          estimate={run.estimate}
          note={serverNote}
          view={{ filter, setFilter, query, setQuery, page, setPage }}
          onInspect={(i) => setModal({ type: "row", index: i })}
        />
      ) : run.results === "loading" ? (
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Reading the results…
        </div>
      ) : run.results === "expired" ? (
        <div className="note">The router has deleted this batch’s results: it keeps them for 24 hours after a batch finishes. The receipts of the answered rows are still in Receipts.</div>
      ) : run.results === "error" ? (
        <div className="error" role="alert">
          The results could not be read ({run.resultsError}).{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              run.results = "none";
              watchServer(run);
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <p className="help-text">The results appear here when the batch finishes.</p>
      )}

      {modal?.type === "row" && <RowDetails row={run.rows[modal.index]} st={run.states[modal.index]} laneRun={laneRun} navigate={navigate} onClose={() => setModal(null)} />}
      {modal?.type === "cancel" && (
        <Modal title="Cancel this batch?" onClose={() => setModal(null)}>
          <p>Rows that have not started are never run or billed. Rows already running finish and are billed. Answered rows stay available to download.</p>
          <div className="button-row modal-actions">
            <Button
              onClick={() => {
                setModal(null);
                cancelServer(run);
              }}
            >
              Cancel batch
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Keep running
            </Button>
          </div>
        </Modal>
      )}
      {modal?.type === "discard" && (
        <Modal title="Start a new batch?" onClose={() => setModal(null)}>
          <p>This clears the batch and its results from this browser. Download the results first if you need them. Your input stays in the editor.</p>
          <div className="button-row modal-actions">
            <Button
              onClick={() => {
                setModal(null);
                discardRun();
              }}
            >
              Clear and start over
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Keep it
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function RowDetails({ row, st, laneRun, navigate, onClose }) {
  const body = st.status === "done" ? st.response?.body : null;
  const u = body?.usage;
  const receipt = st.served?.receipt_id || body?.receipt?.id || body?.id;
  const closed = failClosed(st);
  const text = body ? responseText(body) : "";
  const lastUser = [...(row.body.messages || [])].reverse().find((m) => m.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => p?.text || "").join("") : "";
  return (
    <Modal title={"Row " + row.custom_id} onClose={onClose}>
      <span className={styles.pill} data-status={statusKey(st)}>
        {statusLabel(st)}
      </span>
      {closed && <p className="help-text">{closedNote(st)}</p>}
      <dl className="detail-list">
        <div>
          <dt>Line</dt>
          <dd>{row.line}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="mono">{body?.model || row.body.model}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{st.attempts}</dd>
        </div>
        {u && (
          <div>
            <dt>Tokens</dt>
            <dd>
              {int(u.prompt_tokens)} input / {int(u.completion_tokens)} output
            </dd>
          </div>
        )}
        {u?.cost != null && (
          <div>
            <dt>Cost</dt>
            <dd>{money(u.cost, 8)} USDG</dd>
          </div>
        )}
        {laneRun && (
          <div>
            <dt>Lane</dt>
            <dd>{st.served?.lane || (closed === "refused" ? "None: refused before any provider was used" : "Not stated")}</dd>
          </div>
        )}
        {receipt && (
          <div>
            <dt>Receipt</dt>
            <dd className="mono">{receipt}</dd>
          </div>
        )}
        {laneRun && st.served?.policy_hash && (
          <div>
            <dt>Policy hash</dt>
            <dd className="mono">{st.served.policy_hash}</dd>
          </div>
        )}
      </dl>
      {st.error && st.status !== "done" && (
        <div className="error">
          {st.error.status ? `HTTP ${st.error.status} · ` : ""}
          {st.error.message}
        </div>
      )}
      {prompt && (
        <>
          <span className="eyebrow">Prompt</span>
          <pre className={styles.response}>{prompt.length > 4000 ? prompt.slice(0, 4000) + "…" : prompt}</pre>
        </>
      )}
      {body && (
        <>
          <span className="eyebrow">Response</span>
          <pre className={styles.response}>{text || "(empty response)"}</pre>
        </>
      )}
      <div className="button-row">
        {body && <CopyButton text={text} label="Copy response" />}
        {receipt && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              onClose();
              navigate("Receipts");
            }}
          >
            Open receipts →
          </button>
        )}
      </div>
    </Modal>
  );
}
