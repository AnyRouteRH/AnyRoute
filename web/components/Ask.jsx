'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, ApiError, api, validKey } from "../lib/api";
import {
  ACCEPT, CHUNK_SIZE, LANES, LIMITS, MAX_HELD_BYTES, MAX_LISTED_FILES, QUESTION_MAX, READ_LIMIT_BYTES, SUPPORTED, TOP_K,
  buildRagRequest, chunkText, fileTooLarge, formatBytes, formatContext, kindOf, laneAdvice, modelsFor, overlapFor, parseFile, perMillion, pickModel, planRequest, problems,
  readAnswer, readCatalog, readError, readPrivacyLabel, receiptLinks,
} from "../lib/ask";
import { loadPdfjs } from "../lib/ask-pdfjs";
import { Button, CopyButton } from "./UI";
import styles from "./Ask.module.css";

const LANE_TEXT = {
  attested: ["Attested", "The chat and embedding models run only at providers whose hardware attestation the router has verified and holds fresh. If a step cannot be served on it, the request is refused rather than sent on a weaker lane. Calls made before a refusal are billed and listed."],
  public: ["Public", "The router's ordinary lane. A provider's documented policy applies to your text."],
  auto: ["Router's choice", "The attested lane when the chat model and the embedding model both have an attested endpoint right now, otherwise the public lane. The answer says which lane it used and why."],
};
const STEP_LABEL = { embeddings: "Embeddings", chat: "Answer" };
const KIND_LABEL = { text: "text", markdown: "markdown", csv: "csv", json: "json", html: "html", docx: "word", pdf: "pdf" };
const yes = (v) => (v ? "yes" : "no");
const Word = ({ state, children }) => (
  <span className={styles.state} data-state={state}>
    {children}
  </span>
);

let fileCounter = 0;

// ---------------------------------------------------------------------------------------------------------------
// Step 1: the key. Kept in this component's state only: not in session or local storage, and gone on reload.

function KeyStep({ auth, onConnect, onForget }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setError("");
    const key = value.trim();
    if (!validKey(key)) return setError("That is not an Anyroute key (sk-ar-v1- followed by 64 hex characters).");
    setBusy(true);
    try {
      const credits = await api("/api/v1/credits", { key });
      setValue("");
      onConnect(key, credits?.data?.available ?? null);
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 401 || err.status === 403) ? "The router did not accept that key." : err?.message || "The key could not be checked.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.step} aria-labelledby="ask-key">
      <h2 id="ask-key">
        <span className={styles.num}>1</span>Your API key
      </h2>
      {auth.key ? (
        <div className={styles.connected}>
          <Word state="yes">Connected</Word>
          <span className="mono">
            {auth.key.slice(0, 9)}…{auth.key.slice(-4)}
          </span>
          {Number.isFinite(Number(auth.balance)) && auth.balance !== null && <span className={styles.sub}>${Number(auth.balance).toFixed(2)} available</span>}
          <button type="button" className="text-button" onClick={onForget}>
            Forget key
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.keyForm}>
          <div className="field">
            <label htmlFor="ask-key-input">API key</label>
            <input id="ask-key-input" type="password" autoComplete="off" spellCheck="false" value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-ar-v1-…" />
          </div>
          <Button type="submit" disabled={busy || !value.trim()}>
            {busy ? "Checking…" : "Connect key"}
          </Button>
        </form>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className={styles.help}>
        This needs a prepaid Anyroute API key; per-call payment and blind tokens are not accepted here. The key is kept in this tab's memory only: it is not written to browser storage and is gone when you reload or leave.{" "}
        {!auth.key && (
          <>
            No key yet? <a className="inline-link" href="/dashboard/">Create one in the dashboard</a>.
          </>
        )}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2: the files

function Meter({ row }) {
  const text = row.bytes ? `${formatBytes(row.used)} of ${formatBytes(row.limit)}` : `${row.used.toLocaleString("en-US")}${row.floor ? " or more" : ""} of ${row.limit.toLocaleString("en-US")}`;
  return (
    <li className={styles.meter} data-over={row.over}>
      <span className={styles.meterLabel}>{row.label}</span>
      <span className={styles.meterValue}>{text}</span>
      <span className={styles.bar} aria-hidden="true">
        <i style={{ width: `${Math.max(row.used ? 2 : 0, row.share * 100)}%` }} />
      </span>
      <Word state={row.over ? "bad" : "yes"}>{row.over ? "Over the limit" : "Within the limit"}</Word>
    </li>
  );
}

function FileRow({ file, chunks, onRemove }) {
  const state = file.status === "ready" ? "yes" : file.status === "reading" ? "unknown" : "bad";
  const word = file.status === "ready" ? "Ready" : file.status === "reading" ? "Reading" : "Not used";
  return (
    <li className={styles.file}>
      <div className={styles.fileHead}>
        <span className={styles.fileName}>{file.name}</span>
        <Word state={state}>{word}</Word>
        <button type="button" className="text-button" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`}>
          Remove
        </button>
      </div>
      {file.status === "ready" && (
        <>
          <p className={styles.sub}>
            {KIND_LABEL[file.kind]}
            {file.pages ? ` · ${file.pages} page${file.pages === 1 ? "" : "s"}` : ""} · {formatBytes(file.bytes)} of text · {chunks ?? 0} chunk{chunks === 1 ? "" : "s"}
          </p>
          {file.note && <p className={styles.sub}>{file.note}</p>}
          <details className={styles.more}>
            <summary>Preview the text that will be sent</summary>
            <pre className={styles.preview}>
              {file.text.slice(0, 1500)}
              {file.text.length > 1500 ? "\n…" : ""}
            </pre>
          </details>
        </>
      )}
      {file.status === "error" && <p className={styles.fileError}>{file.error}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The answer

function Cite({ refs, onPick, active }) {
  return (
    <span className={styles.cites}>
      {refs.map((r) => (
        <button key={r} type="button" className={styles.cite} data-active={active === r} onClick={() => onPick(r)} aria-label={`Show source ${r}`} aria-controls={`ask-source-${r}`}>
          {r}
        </button>
      ))}
    </span>
  );
}

function SourceCard({ source, cited, active, open, onToggle, cardRef }) {
  const ex = source.excerpt;
  const expanded = active || open;
  return (
    <li id={`ask-source-${source.ref}`} ref={cardRef} tabIndex={-1} className={styles.source} data-active={active}>
      <div className={styles.sourceHead}>
        <span className={styles.refBadge}>{source.ref}</span>
        <span className={styles.fileName}>{source.name}</span>
        {source.part !== null && <span className={styles.sub}>passage {source.part}</span>}
        {source.pages && <span className={styles.sub}>{source.pages.first === source.pages.last ? `page ${source.pages.first}` : `pages ${source.pages.first} to ${source.pages.last}`}</span>}
        {source.score !== null && <span className={styles.sub}>match {source.score.toFixed(3)}</span>}
        <Word state={cited ? "yes" : "unknown"}>{cited ? "Cited in the answer" : "Not cited"}</Word>
      </div>
      {ex ? (
        <>
          <blockquote className={styles.quote} data-open={expanded}>
            {expanded ? (
              <>
                {ex.moreBefore && "… "}
                <span className={styles.ctx}>{ex.before}</span>
                <mark>{ex.hit}</mark>
                <span className={styles.ctx}>{ex.after}</span>
                {ex.moreAfter && " …"}
              </>
            ) : (
              <mark>
                {ex.hit.slice(0, 280)}
                {ex.hit.length > 280 ? "…" : ""}
              </mark>
            )}
          </blockquote>
          {!active && (
            <button type="button" className="text-button" onClick={onToggle} aria-expanded={open}>
              {open ? "Show less" : "Show the whole passage in context"}
            </button>
          )}
        </>
      ) : (
        <p className={styles.sub}>This passage could not be placed in the text that was sent.</p>
      )}
    </li>
  );
}

function PrivacyLabel({ state }) {
  if (!state || state.state === "hidden") return null;
  if (state.state === "loading") return <p className={styles.sub}>Reading the label…</p>;
  if (state.state === "absent") return <p className={styles.sub}>This router does not publish a privacy label for this receipt. The signed receipt is still the record.</p>;
  if (state.state === "error") return <p className={styles.sub}>The label could not be loaded. Try again.</p>;
  const l = state.label;
  return (
    <div className={styles.label}>
      <dl>
        {l.rows.map((r) => (
          <Fragment key={r.key}>
            <dt>{r.title}</dt>
            <dd>{r.value}</dd>
          </Fragment>
        ))}
      </dl>
      {l.summary.length > 0 && (
        <ul>
          {l.summary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {l.verifyUrl && (
        <p>
          <a className="inline-link" href={l.verifyUrl}>
            Check this receipt (link from the router)
          </a>
        </p>
      )}
      <p className={styles.sub}>Read from the router when you asked. The signed receipt, not this summary, is what can be verified.</p>
    </div>
  );
}

function ReceiptRow({ r, label, onLabel, onCopy, copied }) {
  const links = receiptLinks(r.id, API_BASE);
  return (
    <li className={styles.receipt}>
      <div className={styles.receiptHead}>
        <span className={styles.stepName}>{STEP_LABEL[r.step] || "Call"}</span>
        {r.id ? (
          <>
            <code className={styles.id}>{r.id}</code>
            <CopyButton text={r.id} label="Copy id" />
          </>
        ) : (
          <span className={styles.sub}>No usable receipt id</span>
        )}
        {r.withheld && <Word state="bad">Withheld, billed</Word>}
      </div>
      <dl className={styles.facts}>
        {r.model && (
          <>
            <dt>Model</dt>
            <dd className="mono">{r.model}</dd>
          </>
        )}
        {r.provider && (
          <>
            <dt>Provider</dt>
            <dd className="mono">{r.provider}</dd>
          </>
        )}
        {r.lane && (
          <>
            <dt>Lane</dt>
            <dd>{r.lane}</dd>
          </>
        )}
        {r.disclosure && (
          <>
            <dt>Disclosure class</dt>
            <dd>{r.disclosure}</dd>
          </>
        )}
        {(r.promptTokens !== null || r.completionTokens !== null) && (
          <>
            <dt>Tokens</dt>
            <dd>
              {r.promptTokens ?? 0} in · {r.completionTokens ?? 0} out{r.inputs !== null ? ` · ${r.inputs} text${r.inputs === 1 ? "" : "s"}` : ""}
            </dd>
          </>
        )}
        {r.cost !== null && (
          <>
            <dt>Cost</dt>
            <dd>${r.cost.toFixed(7).replace(/0+$/, "").replace(/\.$/, ".0")}</dd>
          </>
        )}
        {r.attestation && (
          <>
            <dt>Gateway attestation</dt>
            <dd className={styles.checks}>
              <Word state={yes(r.attestation.attested)}>Attested {yes(r.attestation.attested)}</Word>
              <Word state={yes(r.attestation.gpu)}>GPU {yes(r.attestation.gpu)}</Word>
              <Word state={yes(r.attestation.verified)}>Receipt verified {yes(r.attestation.verified)}</Word>
              {r.attestation.kind && <span className={styles.sub}>{r.attestation.kind}</span>}
            </dd>
          </>
        )}
      </dl>
      {r.developmentAttestation && <p className={styles.hint}>This router reports development attestation for this call, so treat nothing about its hardware as proven.</p>}
      {links && (
        <div className={styles.links}>
          <a className="inline-link" href={links.verify}>
            Verify it
          </a>
          <button type="button" className="text-button" onClick={() => onCopy(r.id)}>
            {copied === r.id ? "Copied. Paste it on the verify page" : "Copy the signed receipt"}
          </button>
          <a className="inline-link" href={links.receipt} rel="noopener">
            Signed receipt (JSON)
          </a>
          <button type="button" className="text-button" onClick={() => onLabel(r.id)} disabled={label?.state === "loading"}>
            {label?.state === "ok" ? "Hide privacy label" : "Privacy label"}
          </button>
        </div>
      )}
      {links && <PrivacyLabel state={label} />}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The page

export default function Ask() {
  const [auth, setAuth] = useState({ key: "", balance: null });
  const authRef = useRef(auth);
  authRef.current = auth;

  const [files, setFilesState] = useState([]);
  const filesRef = useRef([]);
  const setFiles = useCallback((next) => {
    filesRef.current = typeof next === "function" ? next(filesRef.current) : next;
    setFilesState(filesRef.current);
  }, []);
  const queue = useRef(Promise.resolve());
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);

  const [question, setQuestion] = useState("");
  const [lane, setLane] = useState("attested");
  const [model, setModel] = useState("");
  const [topK, setTopK] = useState(TOP_K.default);
  const [chunkSize, setChunkSize] = useState(CHUNK_SIZE.default);

  const [catalog, setCatalog] = useState({ state: "loading", data: { chat: [], embedding: [] } });
  const [run, setRun] = useState({ state: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef(null);
  const [active, setActive] = useState(0);
  const [openSources, setOpenSources] = useState(() => new Set());
  const [labels, setLabels] = useState({});
  const [copied, setCopied] = useState("");
  const sourceEls = useRef({});
  const resultHead = useRef(null);

  // The model catalog is public.
  useEffect(() => {
    const ac = new AbortController();
    api("/api/v1/models", { signal: ac.signal })
      .then((r) => setCatalog({ state: "ok", data: readCatalog(r?.data) }))
      .catch((e) => e?.name !== "AbortError" && setCatalog({ state: "error", data: { chat: [], embedding: [] }, message: e?.message }));
    return () => ac.abort();
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  // A model the lane allows is always selected.
  useEffect(() => {
    setModel((cur) => pickModel(catalog.data, lane, cur));
  }, [catalog, lane]);

  // ---- files
  const patchFile = useCallback((id, patch) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f))), [setFiles]);
  const removeFile = useCallback((id) => setFiles((fs) => fs.filter((f) => f.id !== id)), [setFiles]);

  const readOne = useCallback(
    async (file) => {
      const cur = filesRef.current;
      if (cur.length >= MAX_LISTED_FILES) return setNotice(`At most ${MAX_LISTED_FILES} files are listed at once.`);
      if (cur.some((f) => f.name === file.name && f.size === file.size && f.modified === file.lastModified)) return setNotice(`${file.name} is already added.`);
      const id = ++fileCounter;
      setFiles((fs) => [...fs, { id, name: file.name, size: file.size, modified: file.lastModified, status: "reading" }]);
      let result;
      try {
        const kind = kindOf(file.name);
        if (file.size > READ_LIMIT_BYTES) result = { ok: false, error: fileTooLarge(file.size) };
        else if (!kind) result = await parseFile(file.name, new Uint8Array(0));
        else result = await parseFile(file.name, new Uint8Array(await file.arrayBuffer()), { loadPdfjs });
      } catch {
        result = { ok: false, error: "This file could not be read." };
      }
      if (result.ok) {
        const held = filesRef.current.filter((f) => f.status === "ready").reduce((n, f) => n + f.bytes, 0);
        if (held + result.bytes > MAX_HELD_BYTES) result = { ok: false, error: "Too much text is loaded at once. Remove some files first." };
      }
      if (result.ok) patchFile(id, { status: "ready", kind: result.kind, text: result.text, bytes: result.bytes, pages: result.pages, note: result.note });
      else patchFile(id, { status: "error", error: result.error });
    },
    [patchFile, setFiles],
  );
  const addFiles = useCallback(
    (list) => {
      const incoming = Array.from(list || []);
      if (!incoming.length) return;
      setNotice("");
      queue.current = queue.current
        .then(async () => {
          for (const f of incoming) await readOne(f);
        })
        .catch(() => undefined);
    },
    [readOne],
  );

  const ready = useMemo(() => files.filter((f) => f.status === "ready"), [files]);
  // While the size field holds something the router would refuse, the counts use the default size.
  const size = Number.isInteger(chunkSize) && chunkSize >= CHUNK_SIZE.min && chunkSize <= CHUNK_SIZE.max ? chunkSize : CHUNK_SIZE.default;
  const pieces = useMemo(() => new Map(ready.map((f) => [f.id, chunkText(f.text, size, overlapFor(size))])), [ready, size]);
  const plan = useMemo(() => planRequest(ready, { chunkSize: size, chunks: ready.map((f) => pieces.get(f.id) || []) }), [ready, pieces, size]);

  const chosen = catalog.data.chat.find((m) => m.id === model);
  const stop = problems({ key: auth.key, docs: ready, plan, question, model, topK, chunkSize, contextLength: chosen?.context });
  const advice = catalog.state === "ok" ? laneAdvice(catalog.data, lane, model) : null;
  const models = modelsFor(catalog.data, lane);

  // ---- asking
  useEffect(() => {
    if (run.state !== "running") return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - run.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [run]);

  async function ask(e) {
    e?.preventDefault();
    if (stop.length || run.state === "running") return;
    const sent = ready.map((f) => ({ name: f.name, text: f.text, kind: f.kind }));
    let body;
    try {
      body = buildRagRequest({ docs: sent, question, model, lane, topK, chunkSize });
    } catch (err) {
      return setRun({ state: "error", error: readError({ message: err.message }) });
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setElapsed(0);
    setRun({ state: "running", startedAt: Date.now() });
    setActive(0);
    setOpenSources(new Set());
    setLabels({});
    try {
      const json = await api("/api/v1/rag", { key: authRef.current.key, method: "POST", body, signal: ac.signal });
      setRun({ state: "done", view: readAnswer(json, sent), lane: lane });
    } catch (err) {
      if (err?.name === "AbortError") setRun({ state: "cancelled" });
      else setRun({ state: "error", error: readError(err) });
    } finally {
      abortRef.current = null;
    }
  }
  useEffect(() => {
    if (run.state === "done" || run.state === "error") resultHead.current?.focus({ preventScroll: false });
  }, [run.state]);

  function pick(ref) {
    setActive(ref);
    const el = sourceEls.current[ref];
    if (!el) return;
    const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }
  const toggleSource = (ref) =>
    setOpenSources((s) => {
      const n = new Set(s);
      n.has(ref) ? n.delete(ref) : n.add(ref);
      return n;
    });

  async function loadLabel(id) {
    if (labels[id]?.state === "ok") return setLabels((l) => ({ ...l, [id]: { ...l[id], state: "hidden" } }));
    if (labels[id]?.state === "hidden") return setLabels((l) => ({ ...l, [id]: { ...l[id], state: "ok" } }));
    setLabels((l) => ({ ...l, [id]: { state: "loading" } }));
    try {
      const json = await api(`/api/v1/receipts/${encodeURIComponent(id)}/privacy`);
      const label = readPrivacyLabel(json, typeof location === "object" ? location.origin : "");
      setLabels((l) => ({ ...l, [id]: label ? { state: "ok", label } : { state: "absent" } }));
    } catch (err) {
      setLabels((l) => ({ ...l, [id]: err instanceof ApiError && (err.status === 404 || err.status === 501) ? { state: "absent" } : { state: "error" } }));
    }
  }
  async function copyReceipt(id) {
    try {
      const res = await fetch(API_BASE + `/api/v1/receipts/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? "" : c)), 4000);
    } catch {
      setCopied("");
      setNotice("The signed receipt could not be copied. Open its JSON link instead and copy it from there.");
    }
  }

  function clearAll() {
    abortRef.current?.abort();
    setFiles([]);
    setQuestion("");
    setRun({ state: "idle" });
    setActive(0);
    setLabels({});
    setNotice("");
  }

  const view = run.state === "done" ? run.view : null;
  const failure = run.state === "error" ? run.error : null;
  const fileCount = plan.documents;

  return (
    <div className={styles.stack}>
      <section className={styles.handling} aria-labelledby="ask-handling">
        <h2 id="ask-handling">How your files are handled</h2>
        <ol>
          <li>
            <b>Read here.</b> Files are opened in this browser and turned into plain text ({SUPPORTED.join(", ")}). A PDF is read by a reader that this site serves, in a background worker in your browser, and only when you add one; it asks no other site for anything. File names stay here: the router receives documents called doc-1, doc-2 and so on.
          </li>
          <li>
            <b>Sent over TLS.</b> The text and your question go to Anyroute. The router reads them in memory to cut them into chunks, embed them and rank them against your question, and asks a chat model to answer from the best few. It writes none of it to a database, cache or log.
          </li>
          <li>
            <b>Then to models.</b> The chunks and the question go to the embedding model's provider, and the question and the best chunks go to the chat model's provider. On the attested lane the router sends them only to providers whose hardware attestation it has verified and holds fresh. That shows what code is running, not what it does with your text. On the public lane a provider's documented policy applies.
          </li>
          <li>
            <b>What is kept.</b> Only what any call leaves: a signed receipt with ids, model, provider, lane, token counts, cost, timing and the SHA-256 of the request and of the response, never their text. A hash does not reveal text, but whoever holds an exact guess of a request can confirm it against one, and a receipt can be read by its id.
          </li>
          <li>
            <b>On this page.</b> Your key and your files stay in this tab's memory, and are gone when you reload or choose Clear. Nothing is written to browser storage.
          </li>
        </ol>
        <p className={styles.help}>
          The endpoint is <span className="mono">POST /api/v1/rag</span>. <a className="inline-link" href="/docs/#rag">Read what it does and does not claim</a>.
        </p>
      </section>

      <KeyStep auth={auth} onConnect={(key, balance) => setAuth({ key, balance })} onForget={() => setAuth({ key: "", balance: null })} />

      <section className={styles.step} aria-labelledby="ask-files">
        <h2 id="ask-files">
          <span className={styles.num}>2</span>Your files
        </h2>
        <div
          className={styles.drop}
          data-active={dragging}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer?.files);
          }}
        >
          <input
            id="ask-file-input"
            className={styles.fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <label htmlFor="ask-file-input">
            <b>Drop files here</b>
            <span>or choose files</span>
          </label>
        </div>
        <p className={styles.help}>
          Reads {SUPPORTED.join(", ")} in this browser. Word files: the body text only, not headers, footers, footnotes or comments. PDF files: the text layer only, page by page; scanned pages are pictures and aren't read.
        </p>
        {notice && (
          <div className={styles.hint} role="status">
            {notice}
          </div>
        )}
        {files.length > 0 && (
          <ul className={styles.files}>
            {files.map((f) => (
              <FileRow key={f.id} file={f} chunks={pieces.get(f.id)?.length} onRemove={removeFile} />
            ))}
          </ul>
        )}

        <div className={styles.limits}>
          <h3>Before you send</h3>
          <ul>{plan.rows.map((r) => <Meter key={r.key} row={r} />)}</ul>
          <p className={styles.help}>
            These are the router's default limits for one request ({LIMITS.documents} documents, {formatBytes(LIMITS.bytes)} of text, {LIMITS.chunks.toLocaleString("en-US")} chunks, {LIMITS.embeddingCalls} embeddings calls). Over any of them the router refuses the request with 413 before anything is sent to a provider; a router configured differently says so in its refusal. The embeddings calls shown are a floor: an embedding model with a small context needs more.
          </p>
        </div>
      </section>

      <form className={styles.step} onSubmit={ask} aria-labelledby="ask-question">
        <h2 id="ask-question">
          <span className={styles.num}>3</span>Your question
        </h2>
        <div className="field">
          <label htmlFor="ask-q">Question</label>
          <textarea id="ask-q" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={QUESTION_MAX} spellCheck="true" placeholder="What does the handbook say about refunds?" />
        </div>

        <fieldset className={styles.lanes}>
          <legend>Lane</legend>
          {LANES.map((l) => (
            <label key={l} className={styles.laneOption} data-checked={lane === l}>
              <input type="radio" name="ask-lane" value={l} checked={lane === l} onChange={() => setLane(l)} />
              <span>
                <b>
                  {LANE_TEXT[l][0]}
                  {l === "attested" ? " (default)" : ""}
                </b>
                <span>{LANE_TEXT[l][1]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="field">
          <label htmlFor="ask-model">Chat model</label>
          <select id="ask-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={catalog.state !== "ok" || !models.length}>
            {catalog.state === "loading" && <option value="">Loading models…</option>}
            {catalog.state === "error" && <option value="">Models could not be loaded</option>}
            {catalog.state === "ok" && !models.length && <option value="">No model available on this lane</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} · {formatContext(m.context)} · {perMillion(m.prompt)}/M in{m.attested ? " · attested" : ""}
              </option>
            ))}
          </select>
        </div>
        {catalog.state === "error" && (
          <div className="error" role="alert">
            {catalog.message || "The model list could not be loaded."}
          </div>
        )}
        {advice && (
          <div className={styles.hint} role="status">
            {advice}
          </div>
        )}
        <p className={styles.help}>The embedding model is chosen by the router (and named in the answer). The catalog above is read from this router when the page opens.</p>

        <details className={styles.more}>
          <summary>Passages</summary>
          <div className={styles.advanced}>
            <div className="field">
              <label htmlFor="ask-topk">Passages to answer from</label>
              <input id="ask-topk" type="number" inputMode="numeric" min={TOP_K.min} max={TOP_K.max} value={Number.isInteger(topK) ? topK : ""} onChange={(e) => setTopK(e.target.value === "" ? NaN : Number(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor="ask-size">Passage size (characters)</label>
              <input id="ask-size" type="number" inputMode="numeric" min={CHUNK_SIZE.min} max={CHUNK_SIZE.max} step="50" value={Number.isInteger(chunkSize) ? chunkSize : ""} onChange={(e) => setChunkSize(e.target.value === "" ? NaN : Number(e.target.value))} />
            </div>
            <p className={styles.help}>
              The files are cut into overlapping passages of this size ({CHUNK_SIZE.min} to {CHUNK_SIZE.max}; overlap 15%), the passages closest to your question are ranked in memory, and the best {TOP_K.min} to {TOP_K.max} go to the model.
            </p>
          </div>
        </details>

        <div className={styles.send}>
          <p className={styles.sendLine} role="status">
            {fileCount
              ? `You are about to send ${fileCount} file${fileCount === 1 ? "" : "s"} (${formatBytes(plan.bytes)} of text, ${plan.chunks.toLocaleString("en-US")} chunk${plan.chunks === 1 ? "" : "s"}) and your question to Anyroute over TLS, ${lane === "auto" ? "on the lane the router chooses" : `on the ${lane} lane`}${model ? `, answered by ${model}` : ""}.`
              : "Nothing is sent until you press Ask."}
          </p>
          <div className="button-row">
            <Button type="submit" disabled={stop.length > 0 || run.state === "running"}>
              {run.state === "running" ? `Asking… ${elapsed}s` : "Ask"}
            </Button>
            {run.state === "running" && (
              <button type="button" className="text-button" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            )}
            <button type="button" className="text-button" onClick={clearAll}>
              Clear files and answer
            </button>
          </div>
          {stop.length > 0 && run.state !== "running" && (
            <ul className={styles.stops}>
              {stop.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      </form>

      {run.state === "cancelled" && (
        <div className={styles.hint} role="status">
          Cancelled. The router may already have made, and billed, some of its calls; each one is a receipt on your key.
        </div>
      )}

      {failure && (
        <section className={styles.result} aria-labelledby="ask-failed">
          <h2 id="ask-failed" ref={resultHead} tabIndex={-1}>
            Not answered
          </h2>
          <div className="error" role="alert">
            {failure.message}
          </div>
          {failure.hint && <p className={styles.hint}>{failure.hint}</p>}
          {failure.type === "payload_too_large" && failure.limit !== null && <p className={styles.help}>This router's limit here is {failure.limit.toLocaleString("en-US")}.</p>}
          {failure.step && <p className={styles.help}>It stopped at the {failure.step} step.</p>}
          {failure.retryAfter && <p className={styles.help}>Try again after {failure.retryAfter}.</p>}
          {failure.receipts.length > 0 && (
            <>
              <h3>Calls already made, and billed</h3>
              <ul className={styles.receipts}>
                {failure.receipts.map((r, i) => (
                  <ReceiptRow key={r.id || i} r={r} label={labels[r.id]} onLabel={loadLabel} onCopy={copyReceipt} copied={copied} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {view && (
        <section className={styles.result} aria-labelledby="ask-answer">
          <h2 id="ask-answer" ref={resultHead} tabIndex={-1}>
            Answer
          </h2>
          <div className={styles.laneBox} data-lane={view.lane}>
            <div className={styles.row}>
              <span className={styles.sub}>Lane used</span>
              <Word state={view.lane === "attested" ? "yes" : "known"}>{view.lane || "not reported"}</Word>
              <span className={styles.sub}>{view.laneSource === "request" ? "you chose it" : view.laneSource === "default" ? "the router chose it" : ""}</span>
              {view.disclosure && <span className={styles.sub}>weakest disclosure class across the calls: {view.disclosure}</span>}
            </div>
            {view.laneNote && <p className={styles.hint}>Router note: {view.laneNote}</p>}
            {view.developmentAttestation && <p className={styles.hint}>This router reports development attestation, so treat nothing about its hardware as proven.</p>}
            <p className={styles.sub}>
              {view.model && (
                <>
                  Chat model <span className="mono">{view.model}</span>.{" "}
                </>
              )}
              {view.embeddingModel && (
                <>
                  Embedding model <span className="mono">{view.embeddingModel}</span>.{" "}
                </>
              )}
              {view.retrieval && view.retrieval.chunks !== null && (
                <>
                  {view.retrieval.chunks} chunk{view.retrieval.chunks === 1 ? "" : "s"} searched, {view.retrieval.topK} used, {view.retrieval.embeddingCalls} embeddings call{view.retrieval.embeddingCalls === 1 ? "" : "s"}.{" "}
                </>
              )}
              {view.usage.costUsd && <>Cost ${view.usage.costUsd}.</>}
            </p>
          </div>

          <div className={styles.answer}>
            {view.answer.trim() ? (
              view.segments.map((s, i) => (s.type === "text" ? <Fragment key={i}>{s.text}</Fragment> : <Cite key={i} refs={s.refs} onPick={pick} active={active} />))
            ) : (
              <span className={styles.sub}>The model returned no text.</span>
            )}
          </div>
          {view.finishReason && view.finishReason !== "stop" && <p className={styles.hint}>The answer stopped early ({view.finishReason}).</p>}
          <p className={styles.help}>
            The answer is a model's output grounded in the passages below, not a proof: check the numbered citations against them. Documents are treated as untrusted; the prompt tells the model to use only the numbered passages and to ignore instructions inside them, which lowers, and does not remove, the chance that a document steers the answer.
          </p>

          {view.sources.length > 0 && (
            <>
              <h3>Passages it was given</h3>
              <p className={styles.help}>Click a number in the answer to jump to its passage. The passage is cut from the text held in this tab, using the position the router returned.</p>
              <ul className={styles.sources}>
                {view.sources.map((s) => (
                  <SourceCard
                    key={s.ref}
                    source={s}
                    cited={view.cited.has(s.ref)}
                    active={active === s.ref}
                    open={openSources.has(s.ref)}
                    onToggle={() => toggleSource(s.ref)}
                    cardRef={(el) => {
                      sourceEls.current[s.ref] = el;
                    }}
                  />
                ))}
              </ul>
            </>
          )}

          <h3>Receipts</h3>
          <p className={styles.help}>Every call is a signed receipt on your key. The verify page checks one against the keys the router publishes; the privacy label is the router's plain-language summary of how the call was served, where it publishes one.</p>
          <ul className={styles.receipts}>
            {view.receipts.map((r, i) => (
              <ReceiptRow key={r.id || i} r={r} label={labels[r.id]} onLabel={loadLabel} onCopy={copyReceipt} copied={copied} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
