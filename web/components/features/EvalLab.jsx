"use client";

/**
 * Eval Lab workspace tab. Props (from Dashboard): { live, apiKey, ws, status, catalog, refresh, notify, fail, navigate }.
 * Compares 2–4 models or saved routes on the user's own test set. Eval sets live in localStorage and
 * finished runs in IndexedDB (both optional): the router never stores them. Only the chat requests
 * themselves go to the router, as normal billed generations with signed receipts.
 * live=false is the sample workspace: the editor works, running is disabled, and the only results shown
 * are a static example labelled as such.
 */
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, downloadJSON, loadKey } from "../../lib/api";
import { models as sampleModels, money } from "../../lib/demo";
import {
  CHECKS,
  CHECK_LABELS,
  JUDGE_MAX_TOKENS,
  LIMITS,
  buildRequest,
  caseProblem,
  casesToCSV,
  createGate,
  estimateRun,
  fileSlug,
  importCases,
  judgeRequest,
  loadState,
  newId,
  paramsProblem,
  parseJudge,
  readCompletion,
  resultKey,
  routeOptions,
  runPool,
  runToCSV,
  runToJSON,
  saveState,
  scoreOutput,
  setToJSON,
  summarize,
  uniqueId,
  withRetry,
} from "../../lib/evals";
import { Button, CopyButton, Modal } from "../UI";
import styles from "./EvalLab.module.css";

const PRIVACY = "Eval sets and results stay in this browser. Each case is sent to the router as a normal request.";
const PAGE = 20;
const LETTERS = "ABCD";
const FATAL = new Set([401, 402, 403]); // bad key, no credits, not allowed: every later call would fail too
const EXPECTED_LABEL = { none: "Reference (optional)", exact: "Expected text", contains: "Must contain", regex: "Pattern", json: "Expected JSON (optional)" };
const EXPECTED_HINT = {
  none: "Not checked. A reference here is shown to the judge.",
  exact: "The whole trimmed answer, case-sensitive.",
  contains: "Text the answer must include, any case.",
  regex: "/^\\d{4}-\\d{2}-\\d{2}$/i or a bare pattern.",
  json: '{"city": "Paris"}: fields the JSON output must contain.',
};

function Field({ label, id, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

const fmtMs = (v) => (v == null ? "—" : v >= 10000 ? (v / 1000).toFixed(1) + " s" : Math.round(v).toLocaleString("en-US") + " ms");
const fmtPct = (v) => (v == null ? "—" : Math.round(v * 100) + "%");
const fmtPrice = (v) => Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
const preview = (s, n = 90) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t || "(empty)";
};
const errorInfo = (e) => ({ status: Number.isFinite(e?.status) ? e.status : 0, type: e?.type || "error", message: e?.message || String(e) });
const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
function downloadText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- runs outlive the tab ----
// Switching workspace tabs unmounts this component; a run keeps going and reports back through `lab`.

const lab = { active: null, ctl: null, key: "", wait: "", history: [], historyState: "idle", storageNote: "", version: 0, listeners: new Set() };
const emit = () => {
  lab.version++;
  lab.listeners.forEach((l) => l());
};
const subscribe = (l) => {
  lab.listeners.add(l);
  return () => lab.listeners.delete(l);
};
const getVersion = () => lab.version;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    let open;
    try {
      open = indexedDB.open("anyroute-evals", 1);
    } catch (e) {
      return reject(e);
    }
    open.onupgradeneeded = () => open.result.createObjectStore("runs", { keyPath: "id" });
    open.onblocked = () => reject(new Error("Browser storage is blocked by another tab."));
    open.onerror = () => reject(open.error || new Error("Browser storage is unavailable."));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction("runs", mode);
        const req = fn(tx.objectStore("runs"));
        tx.oncomplete = () => {
          db.close();
          resolve(req?.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error || new Error("Browser storage failed."));
        };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}

function loadHistory() {
  if (lab.historyState !== "idle") return;
  lab.historyState = "loading";
  idb("readonly", (s) => s.getAll())
    .then((list) => {
      const saved = (list || []).filter((r) => r?.id && r.set && Array.isArray(r.set.cases) && Array.isArray(r.candidates) && r.results);
      const ids = new Set(lab.history.map((r) => r.id));
      lab.history = [...lab.history, ...saved.filter((r) => !ids.has(r.id))].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, LIMITS.runs);
      lab.historyState = "ok";
      emit();
    })
    .catch(() => {
      lab.historyState = "unavailable";
      emit();
    });
}

async function keepRun(run) {
  const next = [run, ...lab.history.filter((r) => r.id !== run.id)];
  const dropped = next.slice(LIMITS.runs);
  lab.history = next.slice(0, LIMITS.runs);
  emit();
  try {
    await idb("readwrite", (s) => {
      s.put(run);
      dropped.forEach((r) => s.delete(r.id));
    });
    lab.storageNote = "";
  } catch {
    lab.storageNote = "This browser could not store the run, so its results last only until you leave the page. Export them to keep a copy.";
  }
  emit();
}

async function forgetRun(id) {
  lab.history = lab.history.filter((r) => r.id !== id);
  if (lab.active?.id === id && !lab.ctl) lab.active = null;
  emit();
  await idb("readwrite", (s) => s.delete(id)).catch(() => {});
}

async function execute(run, { key, notify, refresh }) {
  const ctl = new AbortController();
  const gate = createGate();
  const guard = (e) => {
    e.preventDefault();
    e.returnValue = "";
  };
  addEventListener("beforeunload", guard);
  Object.assign(lab, { active: run, ctl, key, wait: "" });
  emit();
  const put = (k, value) => {
    if (lab.active?.id !== run.id) return;
    lab.active = { ...lab.active, results: { ...lab.active.results, [k]: value } };
    emit();
  };
  const call = (body) =>
    withRetry(
      async () => {
        const t0 = performance.now();
        const json = await api("/api/v1/chat/completions", { key, method: "POST", body, signal: ctl.signal });
        if (lab.wait) {
          lab.wait = "";
          emit();
        }
        return { json, latencyMs: Math.round(performance.now() - t0) };
      },
      {
        signal: ctl.signal,
        gate,
        onRetry: ({ ms }) => {
          lab.wait = `The router asked to slow down (429). Waiting ${Math.ceil(ms / 1000)} s before retrying; nothing was billed for the rejected call.`;
          emit();
        },
      },
    );
  const tasks = run.set.cases.flatMap((c) => run.candidates.map((cand, j) => ({ c, j, cand })));
  let stop = "";
  let unreachable = 0;
  await runPool(
    tasks,
    async ({ c, j, cand }) => {
      const k = resultKey(c.id, j);
      put(k, { status: "running" });
      const { json, latencyMs } = await call(buildRequest(cand.id, c.prompt, run.params));
      unreachable = 0;
      const read = readCompletion(json);
      const rec = { status: "ok", ...read, latencyMs, ...scoreOutput(read.output, c) };
      if (run.judge) {
        put(k, { ...rec, judge: { status: "running" } });
        try {
          const reply = readCompletion((await call(judgeRequest(run.judge, c, read.output))).json);
          rec.judge = { status: "ok", ...parseJudge(reply.output), cost: reply.cost, receipt: reply.receipt, model: reply.model };
        } catch (e) {
          rec.judge = e?.name === "AbortError" ? { status: "cancelled" } : { status: "error", error: errorInfo(e) };
        }
      }
      put(k, rec);
      return rec;
    },
    {
      concurrency: LIMITS.concurrency,
      signal: ctl.signal,
      onResult: (res, i) => {
        if (res.ok) return;
        const { c, j } = tasks[i];
        put(resultKey(c.id, j), res.cancelled ? { status: "cancelled" } : { status: "error", error: errorInfo(res.error) });
        if (res.cancelled || ctl.signal.aborted) return;
        const status = res.error?.status;
        unreachable = status === 0 ? unreachable + 1 : 0;
        if (FATAL.has(status) || unreachable >= 3) {
          stop = status === 0 ? "The router could not be reached." : res.error.message;
          ctl.abort();
        }
      },
    },
  );
  removeEventListener("beforeunload", guard);
  const results = { ...lab.active.results };
  for (const { c, j } of tasks) {
    const k = resultKey(c.id, j);
    if (!results[k] || results[k].status === "running") results[k] = { status: "cancelled" };
  }
  const status = stop ? "stopped" : ctl.signal.aborted ? "cancelled" : "complete";
  const done = { ...lab.active, results, status, ...(stop ? { stopReason: stop } : {}), finishedAt: new Date().toISOString() };
  Object.assign(lab, { active: done, ctl: null, wait: "" });
  emit();
  await keepRun(done);
  const summary = summarize(done);
  const returned = summary.reduce((s, x) => s + x.completed, 0);
  const billed = summary.reduce((s, x) => s + x.cost + x.judgeCost, 0);
  const verb = status === "complete" ? "finished" : status === "stopped" ? "stopped" : "cancelled";
  notify?.(`Eval run ${verb}: ${returned} of ${tasks.length} outputs returned, ${money(billed, 6)} USDG billed${done.judge ? " including the judge" : ""}. Results are in Eval Lab and stay in this browser.`);
  refresh?.().catch(() => {});
}

// A static layout example for the sample workspace. Never presented as a measurement.
const EXAMPLE = (() => {
  const [a, b] = [sampleModels[0], sampleModels[3]];
  const cases = [
    { id: "capital", prompt: "What is the capital of Australia? Answer with the city name only.", expected: "Canberra", check: "contains" },
    { id: "arithmetic", prompt: "What is 17 × 23? Reply with the number only.", expected: "391", check: "exact" },
    { id: "extract-json", prompt: 'Return only a JSON object with the keys "city" and "country" for the Eiffel Tower.', expected: '{"city": "Paris", "country": "France"}', check: "json" },
  ];
  const cell = (output, c, latencyMs, promptTokens, completionTokens, cost) => ({ status: "ok", output, ...scoreOutput(output, c), latencyMs, promptTokens, completionTokens, cost, model: null, provider: null, receipt: null });
  return {
    id: "example",
    example: true,
    status: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    set: { name: "Starter set", cases },
    candidates: [
      { id: a.id, label: a.name },
      { id: b.id, label: b.name },
    ],
    params: { temperature: 0, maxTokens: 256 },
    judge: null,
    results: {
      [resultKey("capital", 0)]: cell("Canberra", cases[0], 640, 24, 3, 0.0000171),
      [resultKey("capital", 1)]: cell("The capital of Australia is Canberra.", cases[0], 410, 24, 9, 0.0000084),
      [resultKey("arithmetic", 0)]: cell("391", cases[1], 580, 22, 2, 0.0000150),
      [resultKey("arithmetic", 1)]: cell("17 × 23 = 391", cases[1], 390, 22, 8, 0.0000076),
      [resultKey("extract-json", 0)]: cell('{"city": "Paris", "country": "France"}', cases[2], 820, 30, 14, 0.0000306),
      [resultKey("extract-json", 1)]: cell("Sure! Here it is: Paris, France.", cases[2], 450, 30, 10, 0.0000100),
    },
  };
})();

const runLabel = (r) =>
  `${new Date(r.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ${r.set.name} · ${r.candidates.length} candidates${r.status === "running" ? " · running" : r.status !== "complete" ? " · " + r.status : ""}`;

/** The column index that is strictly best, or -1 (ties and single values highlight nothing). */
function best(values, better) {
  const known = values.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v));
  if (known.length < 2) return -1;
  const top = known.reduce((a, b) => (better(b[0], a[0]) ? b : a));
  return known.filter(([v]) => v === top[0]).length === 1 ? top[1] : -1;
}

export default function EvalLab({ live, apiKey, ws, catalog = [], refresh, notify, navigate }) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const [boot] = useState(() => loadState(storage()));
  const [state, setState] = useState(boot.state);
  const [storageNote, setStorageNote] = useState(boot.note);
  const [routes, setRoutes] = useState({ status: "idle", list: [], message: "" });
  const [visible, setVisible] = useState(PAGE);
  const [report, setReport] = useState(null);
  const [modal, setModal] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [shownId, setShownId] = useState(null);
  const [verdicts, setVerdicts] = useState({});
  const fileRef = useRef(null);
  const focusId = useRef(null);
  const running = !!lab.ctl;

  useEffect(() => {
    loadHistory();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!saveState(storage(), state)) setStorageNote((n) => n || "This browser could not save your eval sets. They stay available until you leave the page; export them to keep a copy.");
    }, 300);
    return () => clearTimeout(t);
  }, [state]);
  useEffect(() => {
    if (!live || !apiKey) return;
    let current = true;
    setRoutes({ status: "loading", list: [], message: "" });
    api("/api/v1/routes", { key: apiKey })
      .then((r) => current && setRoutes({ status: "ok", list: routeOptions(r), message: "" }))
      .catch((e) => current && setRoutes({ status: [404, 405, 501].includes(e?.status) ? "missing" : "error", list: [], message: e?.message || "" }));
    return () => {
      current = false;
    };
  }, [live, apiKey]);
  // A run keeps going across tab switches, but not across a sign-out or a different key.
  useEffect(() => {
    if (lab.ctl && live && apiKey && lab.key !== apiKey) lab.ctl.abort();
    return () => {
      if (lab.ctl && loadKey() !== lab.key) lab.ctl.abort();
    };
  }, [live, apiKey]);
  useEffect(() => {
    if (!focusId.current) return;
    document.getElementById(focusId.current)?.focus();
    focusId.current = null;
  });

  const models = useMemo(() => (live ? catalog : sampleModels).filter((m) => m.type !== "Embeddings"), [live, catalog]);
  const priceBook = useMemo(() => ({ models, routes: routes.list }), [models, routes.list]);
  useEffect(() => {
    if (state.config.candidates.length || models.length < LIMITS.minCandidates) return;
    setState((s) => ({ ...s, config: { ...s.config, candidates: models.slice(0, LIMITS.minCandidates).map((m) => m.id) } }));
  }, [state.config.candidates.length, models]);

  const set = state.sets.find((s) => s.id === state.activeId) || state.sets[0];
  const cases = set.cases;
  const cfg = state.config;
  const candidates = cfg.candidates;
  const judgeOn = cfg.judge.enabled;
  const problems = useMemo(() => cases.map(caseProblem), [cases]);
  const problemCount = problems.filter(Boolean).length;
  const known = new Set([...models.map((m) => m.id), ...routes.list.map((r) => r.id)]);
  const estimate = useMemo(
    () => estimateRun({ cases, candidates, maxTokens: cfg.maxTokens, judge: judgeOn && cfg.judge.model ? cfg.judge : null, catalog: priceBook }),
    [cases, candidates, cfg.maxTokens, judgeOn, cfg.judge, priceBook],
  );
  const available = Number.isFinite(ws?.credits?.available) ? ws.credits.available : null;
  const keyRemaining = Number.isFinite(ws?.me?.limit_remaining) ? ws.me.limit_remaining : null;
  const labelOf = (id) => {
    const m = models.find((x) => x.id === id);
    return m && !live ? m.name : id;
  };

  const blockers = [
    !cases.length && "Add at least one case.",
    problemCount > 0 && `Fix ${problemCount} case${problemCount === 1 ? "" : "s"} marked in the eval set.`,
    candidates.length < LIMITS.minCandidates && "Choose at least two candidates.",
    candidates.some((id) => !known.has(id)) && "Replace candidates that are not available on this router.",
    new Set(candidates).size !== candidates.length && "Choose different candidates.",
    paramsProblem(cfg),
    judgeOn && !cfg.judge.model && "Choose a judge model.",
    judgeOn && !cfg.judge.rubric.trim() && "Write a rubric for the judge.",
    running && "A run is in progress.",
  ].filter(Boolean);

  // ---- editing ----
  const updateSet = (fn) => setState((s) => ({ ...s, sets: s.sets.map((x) => (x.id === s.activeId ? { ...fn(x), updatedAt: Date.now() } : x)) }));
  const updateCases = (fn) => updateSet((x) => ({ ...x, cases: fn(x.cases) }));
  const updateConfig = (patch) => setState((s) => ({ ...s, config: { ...s.config, ...patch } }));
  const updateJudge = (patch) => setState((s) => ({ ...s, config: { ...s.config, judge: { ...s.config.judge, ...patch } } }));
  const patchCase = (id, patch) => updateCases((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  function addCase() {
    if (cases.length >= LIMITS.cases) return;
    updateCases((cs) => [...cs, { id: uniqueId(new Set(cs.map((c) => c.id))), prompt: "", check: "none" }]);
    setVisible((v) => Math.max(v, cases.length + 1));
    focusId.current = `eval-case-${cases.length + 1}-prompt`;
  }
  function duplicateCase(i) {
    if (cases.length >= LIMITS.cases) return;
    updateCases((cs) => [...cs.slice(0, i + 1), { ...cs[i], id: uniqueId(new Set(cs.map((c) => c.id))) }, ...cs.slice(i + 1)]);
    setVisible((v) => Math.max(v, i + 2));
    focusId.current = `eval-case-${i + 2}-prompt`;
  }
  function removeCase(i) {
    updateCases((cs) => cs.filter((_, x) => x !== i));
    focusId.current = i + 1 < cases.length ? `eval-case-${i + 1}-prompt` : "eval-add-case";
  }
  function addSet(name, list = []) {
    if (state.sets.length >= LIMITS.sets) {
      setError(`This browser holds at most ${LIMITS.sets} eval sets. Delete one first.`);
      return false;
    }
    const id = uniqueId(new Set(state.sets.map((s) => s.id)), "s");
    const names = new Set(state.sets.map((s) => s.name));
    let unique = (name || "Untitled set").slice(0, LIMITS.nameChars);
    for (let n = 2; names.has(unique); n++) unique = `${(name || "Untitled set").slice(0, LIMITS.nameChars - 4)} ${n}`;
    setState((s) => ({ ...s, activeId: id, sets: [...s.sets, { id, name: unique, cases: list, updatedAt: Date.now() }] }));
    setVisible(PAGE);
    setError("");
    return true;
  }
  function deleteSet() {
    setState((s) => {
      const rest = s.sets.filter((x) => x.id !== s.activeId);
      if (rest.length) return { ...s, sets: rest, activeId: rest[0].id };
      const id = newId("s");
      return { ...s, sets: [{ id, name: "Untitled set", cases: [], updatedAt: Date.now() }], activeId: id };
    });
    setVisible(PAGE);
    setReport(null);
    setModal(null);
  }
  async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return setReport({ ok: false, errors: [`${file.name} is larger than 5 MB.`] });
    let text;
    try {
      text = await file.text();
    } catch {
      return setReport({ ok: false, errors: [`${file.name} could not be read.`] });
    }
    const out = importCases(text, file.name);
    if (!out.cases.length) return setReport({ ok: false, errors: out.errors.length ? out.errors : [`${file.name} contains no cases.`] });
    if (addSet(out.name || file.name.replace(/\.[^.]+$/, ""), out.cases)) setReport({ ok: true, name: file.name, count: out.cases.length, errors: out.errors });
  }
  function setCandidate(j, id) {
    updateConfig({ candidates: candidates.map((x, i) => (i === j ? id : x)) });
  }
  function addCandidate() {
    const spare = models.find((m) => !candidates.includes(m.id)) || routes.list.find((r) => !candidates.includes(r.id));
    if (spare && candidates.length < LIMITS.maxCandidates) updateConfig({ candidates: [...candidates, spare.id] });
  }

  // ---- running ----
  async function preflight() {
    if (blockers.length || !live) return;
    setChecking(true);
    setError("");
    let credits = ws?.credits ?? null;
    try {
      credits = (await api("/api/v1/credits", { key: apiKey })).data ?? credits;
    } catch {
      /* keep the workspace's last balance */
    }
    setChecking(false);
    setModal({ type: "confirm", available: Number.isFinite(credits?.available) ? credits.available : available });
  }
  function start() {
    setModal(null);
    const run = {
      id: newId("run"),
      startedAt: new Date().toISOString(),
      status: "running",
      set: { id: set.id, name: set.name, cases: cases.map((c) => ({ ...c })) },
      candidates: candidates.map((id) => ({ id, label: labelOf(id) })),
      params: { temperature: Number(cfg.temperature), maxTokens: Number(cfg.maxTokens) },
      judge: judgeOn ? { model: cfg.judge.model, rubric: cfg.judge.rubric } : null,
      estimate: { total: estimate.total, candidates: estimate.candidatesCost, judge: estimate.judgeCost, calls: estimate.calls, judge_calls: estimate.judgeCalls },
      results: {},
    };
    setShownId(run.id);
    execute(run, { key: apiKey, notify, refresh });
  }
  async function verify(k, receipt) {
    setVerdicts((v) => ({ ...v, [k]: { busy: true } }));
    try {
      const data = (await api("/api/v1/receipts/verify", { method: "POST", body: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id } })).data;
      setVerdicts((v) => ({ ...v, [k]: { data } }));
    } catch (e) {
      setVerdicts((v) => ({ ...v, [k]: { error: e.message } }));
    }
  }

  const runList = lab.active && !lab.history.some((r) => r.id === lab.active.id) ? [lab.active, ...lab.history] : lab.history;
  const shown = (shownId && runList.find((r) => r.id === shownId)) || lab.active || runList[0] || null;
  const over = (limit) => limit != null && estimate.total > limit;
  const warnings = (bal) =>
    [
      over(bal) && `The estimated maximum is more than your available balance (${money(bal, 6)} USDG). Calls fail once the balance runs out; completed calls stay billed.`,
      over(keyRemaining) && `The estimated maximum is more than this key’s remaining budget (${money(keyRemaining, 6)} USDG).`,
    ].filter(Boolean);
  const basisNote = (basis) =>
    basis === "route" ? " · priced at the route’s most expensive model" : basis === "assumed" ? " · price unknown, priced at the most expensive model" : basis === "unknown" ? " · no catalog prices" : "";
  const priceLine = (id) => {
    const m = models.find((x) => x.id === id);
    if (m) return `${fmtPrice(m.price)} / ${fmtPrice(m.output)} USDG per 1M tokens (input / output)${m.royaltyBps ? ` + ${m.royaltyBps / 100}% creator royalty` : ""}`;
    const r = routes.list.find((x) => x.id === id);
    if (r) return r.models.length ? `Saved route · ${r.models.join(" → ")}` : "Saved route · models not listed";
    return "Not available on this router.";
  };

  return (
    <>
      <div className="panel-heading">
        <div>
          <h2>Compare models on your own cases.</h2>
          <p className="help-text">One test set, two to four models or saved routes, side by side. Pass rates, latency, tokens, actual cost and a signed receipt for every output.</p>
        </div>
        <span className={"badge" + (live ? " green" : "")}>{live ? "Live · each case is a billed call" : "Sample · editor only"}</span>
      </div>
      <div className={"note " + styles.privacy}>{PRIVACY}</div>
      {storageNote && (
        <div className="error" role="alert">
          {storageNote}
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <section className={styles.panel} aria-labelledby="eval-set-title">
        <header className={styles.panelHead}>
          <span className="eyebrow">01 · Eval set</span>
          <h3 id="eval-set-title">Test cases</h3>
          <span className={styles.count}>
            {cases.length} / {LIMITS.cases} cases
          </span>
        </header>
        <div className={styles.setBar}>
          <Field label="Eval set" id="eval-set-select">
            <select
              id="eval-set-select"
              value={set.id}
              onChange={(e) => {
                setState((s) => ({ ...s, activeId: e.target.value }));
                setVisible(PAGE);
                setReport(null);
              }}
            >
              {state.sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || "Untitled set"} ({s.cases.length})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Set name" id="eval-set-name">
            <input id="eval-set-name" value={set.name} maxLength={LIMITS.nameChars} onChange={(e) => updateSet((x) => ({ ...x, name: e.target.value }))} placeholder="Untitled set" />
          </Field>
        </div>
        <div className={styles.toolbar} role="group" aria-label="Eval set actions">
          <button className="text-button" onClick={() => addSet("Untitled set")}>
            New set
          </button>
          <button className="text-button" onClick={() => addSet(set.name + " copy", set.cases.map((c) => ({ ...c })))}>
            Duplicate set
          </button>
          <button className="text-button" onClick={() => setModal({ type: "delete-set" })}>
            Delete set
          </button>
          <span className={styles.divider} aria-hidden="true" />
          <button className="text-button" onClick={() => fileRef.current?.click()}>
            Import JSON or CSV
          </button>
          <button className="text-button" disabled={!cases.length} onClick={() => downloadJSON(setToJSON(set), `anyroute-evalset-${fileSlug(set.name)}.json`)}>
            Export JSON
          </button>
          <button className="text-button" disabled={!cases.length} onClick={() => downloadText(casesToCSV(cases), `anyroute-evalset-${fileSlug(set.name)}.csv`, "text/csv;charset=utf-8")}>
            Export CSV
          </button>
          <input ref={fileRef} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept=".json,.jsonl,.csv,.tsv,.txt,application/json,text/csv" onChange={importFile} />
        </div>
        {report && (
          <div className={report.ok ? "success" : "error"} role={report.ok ? "status" : "alert"}>
            {report.ok ? `Imported ${report.count} case${report.count === 1 ? "" : "s"} from ${report.name} into a new set.` : "Nothing was imported."}
            {report.errors.length > 0 && (
              <ul className={styles.reportList}>
                {report.errors.slice(0, 5).map((m) => (
                  <li key={m}>{m}</li>
                ))}
                {report.errors.length > 5 && <li>…and {report.errors.length - 5} more.</li>}
              </ul>
            )}
          </div>
        )}
        {cases.length ? (
          <ol className={styles.caseList}>
            {cases.slice(0, visible).map((c, i) => (
              <CaseEditor
                key={c.id}
                c={c}
                n={i + 1}
                problem={problems[i]}
                canDuplicate={cases.length < LIMITS.cases}
                onChange={(patch) => patchCase(c.id, patch)}
                onDuplicate={() => duplicateCase(i)}
                onRemove={() => removeCase(i)}
              />
            ))}
          </ol>
        ) : (
          <div className="empty">
            <h3>No cases yet.</h3>
            <p>Add a case, or import a JSON or CSV file with prompt, expected and check columns.</p>
          </div>
        )}
        <div className={styles.listFoot}>
          <Button secondary id="eval-add-case" onClick={addCase} disabled={cases.length >= LIMITS.cases}>
            Add case
          </Button>
          {cases.length > visible && (
            <button className="text-button" onClick={() => setVisible((v) => v + PAGE)}>
              Show {Math.min(PAGE, cases.length - visible)} more ({cases.length - visible} hidden)
            </button>
          )}
          {problemCount > 0 && <span className={styles.problemCount}>{problemCount} case{problemCount === 1 ? " needs" : "s need"} attention</span>}
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="eval-candidates-title">
        <header className={styles.panelHead}>
          <span className="eyebrow">02 · Candidates</span>
          <h3 id="eval-candidates-title">Models to compare</h3>
          <span className={styles.count}>
            {candidates.length} / {LIMITS.maxCandidates}
          </span>
        </header>
        {live && !models.length && <div className="note">The model catalog did not load, so there is nothing to choose yet. Reload the page to try again.</div>}
        <ol className={styles.candidates}>
          {candidates.map((id, j) => (
            <li key={j} className={styles.candidate}>
              <span className={styles.letter} aria-hidden="true">
                {LETTERS[j]}
              </span>
              <Field label={`Candidate ${LETTERS[j]}`} id={`eval-candidate-${j}`}>
                <select id={`eval-candidate-${j}`} value={id} onChange={(e) => setCandidate(j, e.target.value)} aria-describedby={`eval-candidate-${j}-price`}>
                  {!known.has(id) && <option value={id}>{id} (not available)</option>}
                  <optgroup label={live ? "Models" : "Sample models"}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id} disabled={m.id !== id && candidates.includes(m.id)}>
                        {live ? m.id : m.name}
                      </option>
                    ))}
                  </optgroup>
                  {routes.list.length > 0 && (
                    <optgroup label="Saved routes">
                      {routes.list.map((r) => (
                        <option key={r.id} value={r.id} disabled={r.id !== id && candidates.includes(r.id)}>
                          {r.id + (r.label !== r.slug ? " · " + r.label : "")}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </Field>
              <p className={styles.price} id={`eval-candidate-${j}-price`}>
                {priceLine(id)}
              </p>
              {candidates.length > LIMITS.minCandidates && (
                <button className="text-button" onClick={() => updateConfig({ candidates: candidates.filter((_, x) => x !== j) })} aria-label={`Remove candidate ${LETTERS[j]}`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className={styles.listFoot}>
          {candidates.length < LIMITS.maxCandidates && (
            <Button secondary onClick={addCandidate} disabled={candidates.length >= models.length + routes.list.length}>
              Add candidate
            </Button>
          )}
          <p className={styles.routesNote}>
            {!live ? (
              "Saved routes (@route/…) can be compared in the live workspace."
            ) : routes.status === "loading" ? (
              "Loading saved routes…"
            ) : routes.status === "ok" && routes.list.length ? (
              `${routes.list.length} saved route${routes.list.length === 1 ? "" : "s"} can be compared as @route/<slug>.`
            ) : routes.status === "ok" ? (
              <>
                No saved routes yet.{" "}
                <button className="text-button" onClick={() => navigate?.("Saved Routes")}>
                  Create one in Saved Routes →
                </button>
              </>
            ) : routes.status === "missing" ? (
              "Saved routes are not available on this router yet, so only catalog models are listed."
            ) : routes.status === "error" ? (
              `Saved routes could not be loaded (${routes.message || "unknown error"}), so only catalog models are listed.`
            ) : null}
          </p>
        </div>
        <div className={styles.params}>
          <Field label="Temperature (0–2)" id="eval-temperature">
            <input
              id="eval-temperature"
              type="number"
              inputMode="decimal"
              min="0"
              max="2"
              step="0.1"
              value={Number.isFinite(cfg.temperature) ? cfg.temperature : ""}
              onChange={(e) => updateConfig({ temperature: e.target.value === "" ? NaN : Number(e.target.value) })}
            />
          </Field>
          <Field label={`Max tokens (1–${LIMITS.maxTokens})`} id="eval-max-tokens">
            <input
              id="eval-max-tokens"
              type="number"
              inputMode="numeric"
              min="1"
              max={LIMITS.maxTokens}
              step="1"
              value={Number.isFinite(cfg.maxTokens) ? cfg.maxTokens : ""}
              onChange={(e) => updateConfig({ maxTokens: e.target.value === "" ? NaN : Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className={styles.judge}>
          <label className="check-label">
            <input
              type="checkbox"
              checked={judgeOn}
              onChange={(e) => updateJudge({ enabled: e.target.checked, ...(e.target.checked && !cfg.judge.model && models[0] ? { model: models[0].id } : {}) })}
            />{" "}
            Score each output with an LLM judge (optional, billed)
          </label>
          {judgeOn && (
            <div className={styles.judgeGrid}>
              <Field label="Judge model" id="eval-judge-model">
                <select id="eval-judge-model" value={cfg.judge.model} onChange={(e) => updateJudge({ model: e.target.value })}>
                  <option value="">Choose a judge model</option>
                  {cfg.judge.model && !models.some((m) => m.id === cfg.judge.model) && <option value={cfg.judge.model}>{cfg.judge.model} (not available)</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {live ? m.id : m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Rubric" id="eval-judge-rubric">
                <textarea id="eval-judge-rubric" rows={4} maxLength={LIMITS.rubricChars} value={cfg.judge.rubric} onChange={(e) => updateJudge({ rubric: e.target.value })} />
              </Field>
              <p className="help-text">
                The judge reads the rubric, the prompt, the expected value as a reference and the output, then replies with a score from 1 to 5 and a short reason. Each judgement is one more billed call (at most {JUDGE_MAX_TOKENS} output
                tokens), included in the estimate.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="eval-run-title">
        <header className={styles.panelHead}>
          <span className="eyebrow">03 · Pre-flight</span>
          <h3 id="eval-run-title">Estimate and run</h3>
        </header>
        <div className={styles.runGrid}>
          <div className={styles.estimateBox}>
            <dl className={"detail-list " + styles.estimate}>
              {estimate.perCandidate.map((p, j) => (
                <div key={j}>
                  <dt>
                    {LETTERS[j]} · {labelOf(p.id)}
                  </dt>
                  <dd>
                    ≤ {money(p.cost, 6)} USDG
                    <small>
                      {cases.length} call{cases.length === 1 ? "" : "s"}
                      {basisNote(p.basis)}
                    </small>
                  </dd>
                </div>
              ))}
              {judgeOn && (
                <div>
                  <dt>Judge · {cfg.judge.model ? labelOf(cfg.judge.model) : "not chosen"}</dt>
                  <dd>
                    ≤ {money(estimate.judgeCost, 6)} USDG
                    <small>
                      {estimate.judgeCalls} call{estimate.judgeCalls === 1 ? "" : "s"}
                      {basisNote(estimate.judgeBasis)}
                    </small>
                  </dd>
                </div>
              )}
              <div className={styles.total}>
                <dt>Estimated maximum</dt>
                <dd>
                  <strong>{money(estimate.total, 6)} USDG</strong>
                  <small>
                    {estimate.calls + estimate.judgeCalls} calls{live ? "" : " · sample prices"}
                  </small>
                </dd>
              </div>
              {live && (
                <div>
                  <dt>Available balance</dt>
                  <dd>{available == null ? "Unknown" : money(available, 6) + " USDG"}</dd>
                </div>
              )}
            </dl>
            {live &&
              warnings(available).map((w) => (
                <div className="error" role="alert" key={w}>
                  {w}
                </div>
              ))}
            <p className="help-text">
              Estimate at catalog prices: for every case and candidate, ⌈prompt characters ÷ 4⌉ input tokens plus max_tokens output tokens, plus any creator royalty. Actual cost is the usage.cost the router returns for each call, usually
              far less.
            </p>
          </div>
          <div className={styles.runBox}>
            {running ? (
              <Progress run={lab.active} wait={lab.wait} onCancel={() => lab.ctl?.abort()} />
            ) : (
              <>
                {!live ? (
                  <div className={styles.connect} id="eval-run-blockers">
                    <strong>Connect a live key to run evals.</strong>
                    <span>The sample workspace edits and exports eval sets but sends no requests.</span>
                    <button className="text-button" onClick={() => navigate?.("Settings")}>
                      Connect in Settings →
                    </button>
                  </div>
                ) : blockers.length ? (
                  <ul className={styles.blockers} id="eval-run-blockers">
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.ready}>
                    Ready: {estimate.calls} billed call{estimate.calls === 1 ? "" : "s"}
                    {estimate.judgeCalls ? ` plus ${estimate.judgeCalls} judge calls` : ""}, three at a time.
                  </p>
                )}
                <Button onClick={preflight} disabled={!live || blockers.length > 0 || checking} aria-describedby={!live || blockers.length ? "eval-run-blockers" : undefined}>
                  {checking ? "Checking balance…" : "Review and run"}
                </Button>
                <p className="help-text">You confirm the estimate before anything is sent. A 429 pauses every lane for the router’s Retry-After, then retries; a rejected call is never billed.</p>
              </>
            )}
          </div>
        </div>
      </section>

      {live ? (
        <>
          {lab.storageNote && <div className="note">{lab.storageNote}</div>}
          {shown ? (
            <Results
              key={shown.id}
              run={shown}
              runs={runList}
              running={running && shown.id === lab.active?.id}
              onShow={setShownId}
              onForget={(id) => setModal({ type: "forget-run", id })}
              verdicts={verdicts}
              onVerify={verify}
              navigate={navigate}
            />
          ) : lab.historyState !== "loading" ? (
            <div className={"empty " + styles.noRuns}>
              <h3>No eval runs yet.</h3>
              <p>{lab.historyState === "unavailable" ? "This browser cannot store runs, so results last until you leave the page. Export them to keep a copy." : "Results appear here after a run and stay in this browser."}</p>
            </div>
          ) : null}
        </>
      ) : (
        <Results run={EXAMPLE} example runs={[]} verdicts={{}} />
      )}

      {modal?.type === "confirm" && (
        <Modal title="Run this eval?" onClose={() => setModal(null)}>
          <p>
            {cases.length} case{cases.length === 1 ? "" : "s"} × {candidates.length} candidates = <strong>{estimate.calls} billed calls</strong>
            {estimate.judgeCalls ? `, plus ${estimate.judgeCalls} judge calls` : ""}. Each is a normal generation with a signed receipt, billed to this key.
          </p>
          <dl className="detail-list">
            <div>
              <dt>Estimated maximum</dt>
              <dd>{money(estimate.total, 6)} USDG</dd>
            </div>
            <div>
              <dt>Available balance</dt>
              <dd>{modal.available == null ? "Unknown" : money(modal.available, 6) + " USDG"}</dd>
            </div>
            {keyRemaining != null && (
              <div>
                <dt>Key budget left</dt>
                <dd>{money(keyRemaining, 6)} USDG</dd>
              </div>
            )}
            <div>
              <dt>Parameters</dt>
              <dd>
                temperature {cfg.temperature} · max_tokens {cfg.maxTokens} · {LIMITS.concurrency} at a time
              </dd>
            </div>
          </dl>
          {warnings(modal.available).map((w) => (
            <div className="error" role="alert" key={w}>
              {w}
            </div>
          ))}
          <p className="help-text">{PRIVACY}</p>
          <div className="button-row modal-actions">
            <Button onClick={start}>{`Run ${estimate.calls + estimate.judgeCalls} billed calls`}</Button>
            <Button secondary onClick={() => setModal(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {modal?.type === "delete-set" && (
        <Modal title="Delete this eval set?" onClose={() => setModal(null)}>
          <p>
            “{set.name || "Untitled set"}” and its {cases.length} case{cases.length === 1 ? "" : "s"} are removed from this browser. Export the set first if you want a copy. Saved run results are kept.
          </p>
          <div className="button-row modal-actions">
            <Button onClick={deleteSet}>Delete set</Button>
            <Button secondary onClick={() => setModal(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {modal?.type === "forget-run" && (
        <Modal title="Remove this run?" onClose={() => setModal(null)}>
          <p>The run’s outputs and scores are removed from this browser. Its generations stay billed and their receipts remain in Receipts. Export the results first if you want a copy.</p>
          <div className="button-row modal-actions">
            <Button
              onClick={() => {
                forgetRun(modal.id);
                setShownId(null);
                setModal(null);
              }}
            >
              Remove run
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function CaseEditor({ c, n, problem, canDuplicate, onChange, onDuplicate, onRemove }) {
  const base = `eval-case-${n}`;
  const tag = String(n).padStart(2, "0");
  return (
    <li className={styles.case + (problem ? " " + styles.caseInvalid : "")}>
      <div className={styles.caseHead}>
        <span className={styles.caseNo}>Case {tag}</span>
        <span className={styles.caseId} title="Case id">
          {c.id}
        </span>
        <div className={styles.caseActions}>
          <button className="text-button" onClick={onDuplicate} disabled={!canDuplicate} aria-label={`Duplicate case ${n}`}>
            Duplicate
          </button>
          <button className="text-button" onClick={onRemove} aria-label={`Remove case ${n}`}>
            Remove
          </button>
        </div>
      </div>
      <div className={styles.caseGrid}>
        <Field
          label={
            <>
              Prompt<span className="sr-only"> for case {n}</span>
            </>
          }
          id={`${base}-prompt`}
        >
          <textarea
            id={`${base}-prompt`}
            rows={3}
            value={c.prompt}
            maxLength={LIMITS.promptChars}
            placeholder="What the model is asked"
            onChange={(e) => onChange({ prompt: e.target.value })}
            aria-invalid={problem && !c.prompt.trim() ? true : undefined}
            aria-describedby={problem ? `${base}-problem` : undefined}
          />
        </Field>
        <div className={styles.caseSide}>
          <Field
            label={
              <>
                Check<span className="sr-only"> for case {n}</span>
              </>
            }
            id={`${base}-check`}
          >
            <select id={`${base}-check`} value={c.check} onChange={(e) => onChange({ check: e.target.value })}>
              {CHECKS.map((k) => (
                <option key={k} value={k}>
                  {CHECK_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={
              <>
                {EXPECTED_LABEL[c.check]}
                <span className="sr-only"> for case {n}</span>
              </>
            }
            id={`${base}-expected`}
          >
            <textarea
              id={`${base}-expected`}
              rows={2}
              value={c.expected ?? ""}
              maxLength={LIMITS.expectedChars}
              placeholder={EXPECTED_HINT[c.check]}
              onChange={(e) => onChange({ expected: e.target.value })}
              aria-invalid={problem && c.prompt.trim() ? true : undefined}
              aria-describedby={problem ? `${base}-problem` : undefined}
            />
          </Field>
        </div>
      </div>
      {problem && (
        <p className={styles.caseProblem} id={`${base}-problem`}>
          {problem}
        </p>
      )}
    </li>
  );
}

function Progress({ run, wait, onCancel }) {
  const total = run.set.cases.length * run.candidates.length;
  const cells = Object.values(run.results);
  const done = cells.filter((r) => r.status === "ok" || r.status === "error" || r.status === "cancelled").length;
  const errors = cells.filter((r) => r.status === "error").length;
  const billed = cells.reduce((s, r) => s + (r.cost || 0) + (r.judge?.cost || 0), 0);
  const milestone = total ? Math.floor((done / total) * 10) * 10 : 0;
  return (
    <div className={styles.progress}>
      <div className={styles.progressHead}>
        <strong>
          {done} / {total} outputs
        </strong>
        <span>
          {errors} error{errors === 1 ? "" : "s"} · {money(billed, 6)} USDG billed so far
        </span>
      </div>
      <progress max={total || 1} value={done} aria-label="Eval run progress" />
      <p className="sr-only" role="status">
        Eval run {milestone}% done.
      </p>
      {wait && (
        <p className={styles.wait} role="status">
          {wait}
        </p>
      )}
      <Button secondary onClick={onCancel}>
        Cancel run
      </Button>
      <p className="help-text">Cancel stops new calls and aborts those in flight. A provider may still finish an aborted call; anything billed appears in Receipts. You can switch tabs while a run continues.</p>
    </div>
  );
}

function Verdict({ pass }) {
  const [cls, label] = pass === true ? [styles.pass, "Pass"] : pass === false ? [styles.fail, "Fail"] : pass === "error" ? [styles.err, "Error"] : [styles.na, "Not checked"];
  return <span className={styles.verdict + " " + cls}>{label}</span>;
}

function CellSummary({ r, judged }) {
  if (!r || r.status === "running") return <span className={styles.muted}>{r ? "Running…" : "Queued"}</span>;
  if (r.status === "cancelled") return <span className={styles.muted}>Not run</span>;
  if (r.status === "error")
    return (
      <>
        <Verdict pass="error" />
        <small>{r.error?.status ? "HTTP " + r.error.status : "No response"}</small>
      </>
    );
  const judge = !judged || !r.judge ? "" : r.judge.status === "running" ? " · judging…" : Number.isFinite(r.judge.score) ? ` · judge ${r.judge.score}/5` : " · judge –";
  return (
    <>
      <Verdict pass={r.pass} />
      <small>
        {fmtMs(r.latencyMs)} · {money(r.cost, 6)}
        {judge}
      </small>
    </>
  );
}

function judgeText(j) {
  if (j.status === "running") return "Scoring…";
  if (j.status === "cancelled") return "Not scored: the run was cancelled.";
  if (j.status === "error") return "The judge call failed: " + (j.error?.message || "unknown error");
  return `${Number.isFinite(j.score) ? j.score + "/5" : "No score"}${j.reason ? " · " + j.reason : ""}${j.cost ? ` · ${money(j.cost, 6)} USDG` : ""}`;
}

function ReceiptLine({ receipt, verdict, onVerify, navigate }) {
  if (!receipt) return "No receipt in the response.";
  return (
    <>
      <code className={styles.receiptId}>{receipt.id}</code>
      <span className={styles.receiptActions}>
        <CopyButton text={receipt.id} label="Copy id" />
        <button className="text-button" onClick={onVerify} disabled={verdict?.busy}>
          {verdict?.busy ? "Verifying…" : "Verify signature"}
        </button>
      </span>
      {verdict?.data && (
        <span className={verdict.data.signature_valid ? styles.good : styles.bad} role="status">
          Signature {verdict.data.signature_valid ? "valid" : "INVALID"}
          {verdict.data.key_source ? ` (key from ${verdict.data.key_source === "chain" ? "the on-chain registry" : "the router"})` : ""}. Anchor inclusion is checked in Receipts once the batch is anchored.{" "}
          <button className="text-button" onClick={() => navigate?.("Receipts")}>
            Open Receipts →
          </button>
        </span>
      )}
      {verdict?.error && (
        <span className={styles.bad} role="alert">
          {verdict.error}
        </span>
      )}
    </>
  );
}

function OutputCard({ r, cand, letter, example, verdict, onVerify, navigate }) {
  return (
    <article className={styles.output} aria-label={`Output from ${letter}: ${cand.label}`}>
      <header className={styles.outputHead}>
        <span className={styles.letter} aria-hidden="true">
          {letter}
        </span>
        <strong>{cand.label}</strong>
        {r?.status === "ok" && <Verdict pass={r.pass} />}
      </header>
      {!r || r.status === "running" ? (
        <p className={styles.muted}>Waiting for the response…</p>
      ) : r.status === "cancelled" ? (
        <p className={styles.muted}>Not run.</p>
      ) : r.status === "error" ? (
        <div className="error">
          {r.error?.message || "The call failed."}
          {r.error?.status ? ` (HTTP ${r.error.status})` : ""}
        </div>
      ) : (
        <>
          <pre className={styles.outputText} tabIndex={0} aria-label={`Output text from ${letter}`}>
            {r.output || "(empty output)"}
          </pre>
          <dl className={styles.facts}>
            <div>
              <dt>Check</dt>
              <dd>{r.reason}</dd>
            </div>
            {r.judge && (
              <div>
                <dt>Judge</dt>
                <dd>{judgeText(r.judge)}</dd>
              </div>
            )}
            {!example && (
              <div>
                <dt>Served</dt>
                <dd>
                  {[r.model, r.provider].filter(Boolean).join(" · ") || "—"}
                  {r.finish ? " · " + r.finish : ""}
                </dd>
              </div>
            )}
            <div>
              <dt>Usage</dt>
              <dd>
                {r.promptTokens} in / {r.completionTokens} out · {fmtMs(r.latencyMs)} · {money(r.cost, 6)} USDG
              </dd>
            </div>
            <div>
              <dt>Receipt</dt>
              <dd>{example ? "Example only · no request, no receipt" : <ReceiptLine receipt={r.receipt} verdict={verdict} onVerify={onVerify} navigate={navigate} />}</dd>
            </div>
          </dl>
        </>
      )}
    </article>
  );
}

function Results({ run, example = false, runs, running = false, onShow, onForget, verdicts, onVerify, navigate }) {
  const [open, setOpen] = useState({});
  const summary = summarize(run);
  const actual = summary.reduce((s, x) => s + x.cost, 0);
  const judgeCost = summary.reduce((s, x) => s + x.judgeCost, 0);
  const lead = {
    passRate: best(summary.map((s) => s.passRate), (a, b) => a > b),
    meanLatency: best(summary.map((s) => s.meanLatency), (a, b) => a < b),
    p95Latency: best(summary.map((s) => s.p95Latency), (a, b) => a < b),
    cost: best(summary.map((s) => (s.completed ? s.cost : null)), (a, b) => a < b),
    judgeMean: best(summary.map((s) => s.judgeMean), (a, b) => a > b),
  };
  const leadCls = (key, j) => (lead[key] === j ? " " + styles.lead : "");
  const bestMark = (key, j) =>
    lead[key] === j ? (
      <>
        <i className={styles.leadMark} aria-hidden="true" />
        <span className="sr-only">Best: </span>
      </>
    ) : null;
  const stamp = String(run.startedAt).slice(0, 16).replace(/[:T]/g, "-");
  const statusText = running ? "Running" : run.status === "complete" ? "Complete" : run.status === "stopped" ? "Stopped" : "Cancelled";
  return (
    <section className={styles.results} aria-labelledby="eval-results-title">
      <div className="panel-heading">
        <div>
          <h2 id="eval-results-title">{example ? "Example results" : "Results"}</h2>
          <p className="help-text">
            {run.set.name} · {run.set.cases.length} cases × {run.candidates.length} candidates · temperature {run.params.temperature} · max_tokens {run.params.maxTokens}
            {run.judge ? " · judged by " + run.judge.model : ""}
            {example ? "" : " · " + statusText}
          </p>
        </div>
        {example ? (
          <span className="badge">Illustrative · not a real run</span>
        ) : (
          <div className="button-row">
            <Button secondary disabled={running} onClick={() => downloadJSON(runToJSON(run), `anyroute-eval-${fileSlug(run.set.name)}-${stamp}.json`)}>
              Export JSON
            </Button>
            <Button secondary disabled={running} onClick={() => downloadText(runToCSV(run), `anyroute-eval-${fileSlug(run.set.name)}-${stamp}.csv`, "text/csv;charset=utf-8")}>
              Export CSV
            </Button>
          </div>
        )}
      </div>
      {example && <div className="note">A static example of the results layout. No requests were sent: the outputs, latencies and costs below are placeholders, not measurements. Connect a live key to run your own eval.</div>}
      {!example && runs.length > 1 && (
        <div className={styles.runPicker}>
          <Field label="Showing run" id="eval-run-select">
            <select id="eval-run-select" value={run.id} onChange={(e) => onShow(e.target.value)}>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {runLabel(r)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {run.status === "stopped" && (
        <div className="error" role="alert">
          Stopped early: {run.stopReason} Results so far are kept.
        </div>
      )}
      <div className="table-wrap">
        <table className={"data-table " + styles.summary}>
          <caption className="sr-only">Summary per candidate</caption>
          <thead>
            <tr>
              <th scope="col">Candidate</th>
              <th scope="col" className="num">
                Pass rate
              </th>
              <th scope="col" className="num">
                Mean latency
              </th>
              <th scope="col" className="num">
                p95 latency
              </th>
              <th scope="col" className="num">
                Tokens in / out
              </th>
              <th scope="col" className="num">
                Cost / USDG
              </th>
              <th scope="col" className="num">
                Failures
              </th>
              {run.judge && (
                <th scope="col" className="num">
                  Judge (1–5)
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {summary.map((s, j) => (
              <tr key={j}>
                <td className="cell-primary">
                  <span className={styles.letter} aria-hidden="true">
                    {LETTERS[j]}
                  </span>
                  <strong>{s.label}</strong>
                  <small>
                    {s.completed} of {s.total} returned{s.cancelled ? ` · ${s.cancelled} not run` : ""}
                  </small>
                </td>
                <td className={"num" + leadCls("passRate", j)} data-label="Pass rate">
                  {bestMark("passRate", j)}
                  {fmtPct(s.passRate)}
                  <small>{s.checked ? `${s.passed} of ${s.checked} checked` : "no checked outputs"}</small>
                </td>
                <td className={"num" + leadCls("meanLatency", j)} data-label="Mean latency">
                  {bestMark("meanLatency", j)}
                  {fmtMs(s.meanLatency)}
                </td>
                <td className={"num" + leadCls("p95Latency", j)} data-label="p95 latency">
                  {bestMark("p95Latency", j)}
                  {fmtMs(s.p95Latency)}
                </td>
                <td className="num" data-label="Tokens in / out">
                  {s.promptTokens.toLocaleString("en-US")} / {s.completionTokens.toLocaleString("en-US")}
                </td>
                <td className={"num" + leadCls("cost", j)} data-label="Cost / USDG">
                  {bestMark("cost", j)}
                  {money(s.cost, 6)}
                </td>
                <td className="num" data-label="Failures">
                  {s.failures}
                </td>
                {run.judge && (
                  <td className={"num" + leadCls("judgeMean", j)} data-label="Judge (1–5)">
                    {bestMark("judgeMean", j)}
                    {s.judgeMean == null ? "—" : s.judgeMean.toFixed(2)}
                    <small>{s.judged ? `${s.judged} scored · ${money(s.judgeCost, 6)} USDG` : "no scores"}</small>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.costLine}>
        {example ? "Illustrative cost" : "Actual cost"}: <strong>{money(actual + judgeCost, 6)} USDG</strong>
        {judgeCost ? ` (${money(actual, 6)} candidates + ${money(judgeCost, 6)} judge)` : ""}
        {run.estimate ? ` · estimated maximum was ${money(run.estimate.total, 6)} USDG` : ""}. Pass rate counts checked outputs only; failed calls are listed under Failures. Latency is measured in this browser.
      </p>

      <h3 className={styles.subhead}>Per case</h3>
      <div className="table-wrap">
        <table className={"data-table " + styles.matrix}>
          <caption className="sr-only">Results per case and candidate. Use Compare outputs to expand a case.</caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              {run.candidates.map((c, j) => (
                <th scope="col" key={j}>
                  <span className={styles.letter} aria-hidden="true">
                    {LETTERS[j]}
                  </span>
                  {c.label}
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">Outputs</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {run.set.cases.map((c, i) => {
              const isOpen = !!open[c.id];
              const rowId = `eval-outputs-${i + 1}`;
              return (
                <Fragment key={c.id}>
                  <tr>
                    <td className="cell-primary">
                      <strong>
                        {String(i + 1).padStart(2, "0")} · {preview(c.prompt)}
                      </strong>
                      <small>
                        {CHECK_LABELS[c.check]}
                        {c.expected ? " · " + preview(c.expected, 40) : ""}
                      </small>
                    </td>
                    {run.candidates.map((cand, j) => (
                      <td key={j} data-label={`${LETTERS[j]} · ${cand.label}`} className={styles.cell}>
                        <CellSummary r={run.results[resultKey(c.id, j)]} judged={!!run.judge} />
                      </td>
                    ))}
                    <td className="cell-action">
                      <button className="text-button" aria-expanded={isOpen} aria-controls={isOpen ? rowId : undefined} onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}>
                        {isOpen ? "Hide outputs" : "Compare outputs"}
                        <span className="sr-only"> for case {i + 1}</span>
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className={styles.detailRow} id={rowId}>
                      <td colSpan={run.candidates.length + 2}>
                        <p className={styles.fullPrompt}>
                          <span className="eyebrow">Prompt</span>
                          {c.prompt}
                        </p>
                        <div className={styles.outputs}>
                          {run.candidates.map((cand, j) => {
                            const k = run.id + "/" + resultKey(c.id, j);
                            return (
                              <OutputCard
                                key={j}
                                r={run.results[resultKey(c.id, j)]}
                                cand={cand}
                                letter={LETTERS[j]}
                                example={example}
                                verdict={verdicts[k]}
                                onVerify={() => onVerify(k, run.results[resultKey(c.id, j)].receipt)}
                                navigate={navigate}
                              />
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {!example && !running && (
        <button className={"text-button " + styles.forget} onClick={() => onForget(run.id)}>
          Remove this run from this browser
        </button>
      )}
    </section>
  );
}
