"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, loadKey, toCatalogModel, validKey } from "../lib/api";
import {
  DEFAULT_MAX_TOKENS, MAX_LANES, MAX_PROMPT, MIN_LANES, PRESETS, TOKEN_CAPS, attestedCatalog, blankLane, chatModels, decodeArena, encodeArena, estimateCeiling, filterModels,
  formatMs, formatUsd, isFailClosed, pickWinners, presetLanes, raceLane, receiptHref, shortId, tokensPerSecond,
} from "../lib/arena";
import { verifyHref } from "../lib/verify";
import { Button } from "./UI";
import styles from "./Arena.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");
const pad = (ids) => [...ids, ...Array(Math.max(0, MIN_LANES - ids.length)).fill(null)].map(blankLane);
const BADGES = [
  ["first", "First token"],
  ["fastest", "Fastest"],
  ["cheapest", "Cheapest"],
];

/** A searchable model list that opens in place inside a lane. */
function ModelPicker({ index, models, ready, value, taken, disabled, onPick }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef(null);
  const button = useRef(null);
  const input = useRef(null);
  const panelId = useId();
  const picked = models.find((m) => m.id === value);
  const { items, total } = useMemo(() => (open ? filterModels(models, query) : { items: [], total: 0 }), [open, models, query]);
  const close = (refocus) => {
    setOpen(false);
    setQuery("");
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e) => {
      if (!root.current?.contains(e.target)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const choose = (m) => {
    onPick(m.id);
    close(true);
  };
  return (
    <div className={styles.picker} ref={root} onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), close(true))}>
      <button ref={button} type="button" className={styles.pick} disabled={disabled || !ready} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
        <small>{value ? picked?.author || "Model" : ready ? "Lane " + (index + 1) : "Loading models"}</small>
        <span>{picked?.name || value || (ready ? "Choose a model" : "…")}</span>
        <i aria-hidden="true">{open ? "−" : "+"}</i>
      </button>
      {open && (
        <div className={styles.panel} id={panelId}>
          <input
            ref={input}
            type="search"
            className={styles.search}
            placeholder="Search models…"
            aria-label={`Search models for lane ${index + 1}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const first = items.find((m) => !taken.has(m.id));
              if (e.key === "Enter" && first) (e.preventDefault(), choose(first));
            }}
          />
          <ul className={styles.list}>
            {items.map((m) => (
              <li key={m.id}>
                <button type="button" disabled={taken.has(m.id)} aria-current={m.id === value ? "true" : undefined} onClick={() => choose(m)}>
                  <span>{m.name}</span>
                  <small>{taken.has(m.id) && m.id !== value ? "in another lane" : m.id}</small>
                  {m.gpuAttested === true && (
                    <em className={styles.tag} title="The router’s most recent verified receipt for this model asserted GPU attestation.">
                      GPU attested
                    </em>
                  )}
                </button>
              </li>
            ))}
            {!items.length && <li className={styles.none}>No model matches “{query}”.</li>}
          </ul>
          {total > items.length && <p className={styles.more}>Showing {items.length} of {total}. Keep typing to narrow the list.</p>}
        </div>
      )}
    </div>
  );
}

const MARKS = { yes: "✓", no: "×", unknown: "?" };

/** What the signed receipt records about the hardware behind one answer, with links to check it. */
function Proof({ proof, receiptId }) {
  const verify = proof.provider ? verifyHref(proof.provider) : null;
  return (
    <div className={styles.proof} data-attested={proof.attested ? "yes" : "no"} role="group" aria-label="Proof from the signed receipt">
      <ul className={styles.checks}>
        {proof.checks.map((c) => (
          <li key={c.key} data-state={c.state}>
            <span aria-hidden="true">{MARKS[c.state]}</span>
            {c.text}
          </li>
        ))}
      </ul>
      {proof.reason && <p className={styles.why}>{proof.reason}.</p>}
      <p className={styles.proofLinks}>
        {verify && <a href={verify}>Verify provider →</a>}
        {receiptId && (
          <a href={receiptHref(receiptId)} target="_blank" rel="noopener noreferrer">
            Signed receipt ↗
          </a>
        )}
      </p>
      <p className={styles.fine}>{proof.gateway ? "Read from the receipt’s gateway record." : "This provider is attested directly; its receipt has no gateway record, so GPU and TCB status are not part of it."}</p>
    </div>
  );
}

function Lane({ lane, index, elapsed, winners, reserve, picker, canRemove, onRemove, locked }) {
  const out = useRef(null);
  const stick = useRef(true);
  const live = lane.status === "waiting" || lane.status === "streaming";
  useEffect(() => {
    const el = out.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lane.text]);
  const tps = tokensPerSecond(lane.tokens, lane.ttft, lane.total);
  const won = BADGES.filter(([k]) => winners[k].includes(index));
  const label = lane.model ? "answer from " + (picker.models.find((m) => m.id === lane.model)?.name || lane.model) : "answer, no model chosen";
  return (
    <article className={styles.lane} data-status={lane.status} aria-label={"Lane " + (index + 1)}>
      <div className={styles.laneHead}>
        <ModelPicker index={index} {...picker} value={lane.model} disabled={locked} />
        {canRemove && (
          <button type="button" className={styles.remove} disabled={locked} aria-label={"Remove lane " + (index + 1)} onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      <ul className={cx(styles.badges, reserve && styles.reserve)} aria-label="Results">
        {won.map(([k, text]) => (
          <li key={k} data-badge={k}>
            {text}
          </li>
        ))}
      </ul>
      <div
        ref={out}
        className={cx(styles.output, lane.status === "streaming" && styles.caret)}
        tabIndex={0}
        role="region"
        aria-label={label}
        aria-busy={live}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
        }}
      >
        {lane.text ? lane.text : lane.status === "waiting" ? <span className={styles.wait}>Routing…</span> : lane.status === "idle" ? <span className={styles.hint}>The answer streams here.</span> : null}
        {lane.error && (
          <p className={styles.laneError} role={lane.status === "error" ? "alert" : undefined}>
            {isFailClosed(lane.errorType) && <b className={styles.closed}>Failed closed </b>}
            {lane.error}{" "}
            {lane.errorType === "insufficient_credits" && (
              <a href="/dashboard/">Add funds in the dashboard →</a>
            )}
          </p>
        )}
      </div>
      {lane.proof && <Proof proof={lane.proof} receiptId={lane.receiptId} />}
      <dl className={styles.stats}>
        <div>
          <dt>First token</dt>
          <dd>{formatMs(lane.ttft ?? NaN)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd className={live ? styles.ticking : undefined}>{formatMs(live ? elapsed : lane.status === "error" ? NaN : lane.total ?? NaN)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {lane.tokens == null ? "—" : (lane.status === "streaming" ? "~" : "") + lane.tokens.toLocaleString("en-US")}
            {tps ? <small> · {Math.round(tps)}/s</small> : null}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatUsd(lane.cost ?? NaN)}</dd>
        </div>
        <div className={styles.wide}>
          <dt>Receipt</dt>
          <dd>
            {lane.receiptId ? (
              <a href={receiptHref(lane.receiptId)} target="_blank" rel="noopener noreferrer" title={lane.receiptId}>
                {shortId(lane.receiptId)} ↗
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}

export default function Arena() {
  const [prompt, setPrompt] = useState("");
  const [lanes, setLanes] = useState(() => pad([]));
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState("");
  const [attested, setAttested] = useState(false); // attested only: pickers list the attested models, every lane asks for the attested lane
  const [attestedList, setAttestedList] = useState(null);
  const [attestedError, setAttestedError] = useState("");
  const [keyState, setKeyState] = useState("checking"); // checking | none | rejected | ready
  const [secret, setSecret] = useState("");
  const [balance, setBalance] = useState(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [linkNote, setLinkNote] = useState("");
  const [notice, setNotice] = useState("");
  const [announce, setAnnounce] = useState("");
  const ctl = useRef(null);
  const started = useRef(0);
  const pending = useRef({});
  const frame = useRef(0);
  const fromLink = useRef([]);
  const raced = useRef(false);

  // Restore a shared link, then read the visitor's own key (kept in this tab's session storage by the dashboard).
  useEffect(() => {
    const linked = decodeArena(location.search);
    fromLink.current = linked.models;
    if (linked.attested) setAttested(true);
    if (linked.prompt) setPrompt(linked.prompt);
    if (linked.models.length) setLanes(pad(linked.models));
    const stored = loadKey();
    if (validKey(stored)) {
      setSecret(stored);
      setKeyState("ready");
    } else setKeyState("none");
    return () => {
      ctl.current?.abort();
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const loadCatalog = () => {
    setCatalogError("");
    api("/api/v1/models")
      .then((r) => setCatalog(chatModels(r.data.map(toCatalogModel))))
      .catch((e) => setCatalogError(e.message));
  };
  useEffect(loadCatalog, []);

  // The attested list is what attested-only mode and the presets draw on; it is read once at load, whatever the switch says.
  const loadAttested = () => {
    setAttestedError("");
    api("/api/v1/models?lane=attested")
      .then((r) => setAttestedList(attestedCatalog(r.data)))
      .catch((e) => setAttestedError(e.message));
  };
  useEffect(loadAttested, []);

  const active = attested ? attestedList : catalog;
  // A lane whose model the active list does not carry (a shared link, or the switch turned on) is cleared, and the visitor is told.
  useEffect(() => {
    if (!active) return;
    const known = new Set(active.map((m) => m.id));
    const gone = lanes.filter((l) => l.model && !known.has(l.model)).map((l) => l.model);
    const linked = fromLink.current.some((id) => gone.includes(id));
    fromLink.current = [];
    if (!gone.length) return;
    const n = gone.length;
    const from = linked ? " from this link" : "";
    setNotice(
      attested
        ? `${n} model${n === 1 ? "" : "s"}${from} ${n === 1 ? "has" : "have"} no attested endpoint right now, so ${n === 1 ? "its lane was" : "their lanes were"} cleared. Choose from the attested models.`
        : `${n} model${n === 1 ? "" : "s"} from this link ${n === 1 ? "is" : "are"} not in the live catalog right now. Choose another to fill ${n === 1 ? "its" : "their"} lane.`,
    );
    setLanes((ls) => ls.map((l) => (l.model && gone.includes(l.model) ? blankLane(null) : l)));
  }, [active, attested]); // eslint-disable-line react-hooks/exhaustive-deps

  // The key's balance, so an empty key is called out before a race is paid for.
  useEffect(() => {
    if (keyState !== "ready") return;
    let alive = true;
    api("/api/v1/credits", { key: secret })
      .then((r) => alive && setBalance(Number(r.data?.available)))
      .catch((e) => {
        if (!alive) return;
        if (e.status === 401 || e.status === 403) setKeyState("rejected");
      });
    return () => {
      alive = false;
    };
  }, [keyState, secret]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsed(performance.now() - started.current), 100);
    return () => clearInterval(timer);
  }, [running]);

  const models = active || [];
  const chosen = lanes.filter((l) => l.model);
  const metas = chosen.map((l) => models.find((m) => m.id === l.model)).filter(Boolean);
  const winners = useMemo(() => (running ? { first: [], fastest: [], cheapest: [] } : pickWinners(lanes)), [running, lanes]);
  const taken = useMemo(() => new Set(lanes.map((l) => l.model).filter(Boolean)), [lanes]);
  const ceiling = metas.length ? estimateCeiling(metas, prompt, maxTokens) : 0;
  const blocker =
    keyState !== "ready" ? "Add an API key to race." : !prompt.trim() ? "Write a prompt to race." : chosen.length < MIN_LANES ? "Choose at least two models." : "";

  useEffect(() => {
    if (running || !raced.current) return;
    const names = (ids) => ids.map((i) => models.find((m) => m.id === lanes[i]?.model)?.name || lanes[i]?.model).join(" and ");
    const parts = [["Fastest", winners.fastest], ["Cheapest", winners.cheapest], ["First token", winners.first]].filter(([, w]) => w.length).map(([t, w]) => `${t}: ${names(w)}.`);
    setAnnounce("Race finished. " + parts.join(" "));
    raced.current = false;
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = () => {
    frame.current = 0;
    const p = pending.current;
    pending.current = {};
    setLanes((ls) => ls.map((l, i) => (p[i] ? { ...l, ...p[i] } : l)));
  };
  const push = (i, patch) => {
    pending.current[i] = { ...pending.current[i], ...patch };
    if (patch.status === "streaming") {
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    } else {
      cancelAnimationFrame(frame.current);
      flush();
    }
  };

  async function race() {
    if (running || blocker) return;
    const controller = new AbortController();
    ctl.current = controller;
    const t0 = performance.now();
    started.current = t0;
    raced.current = true;
    setElapsed(0);
    setAnnounce("Race started with " + chosen.length + " models" + (attested ? " on the attested lane." : "."));
    setLinkNote("");
    setLanes((ls) => ls.map((l) => (l.model ? { ...blankLane(l.model), status: "waiting" } : l)));
    setRunning(true);
    await Promise.all(
      lanes.map((l, i) => (l.model ? raceLane({ model: l.model, prompt: prompt.trim(), maxTokens, key: secret, signal: controller.signal, attested, t0, onUpdate: (patch) => push(i, patch) }) : null)),
    );
    setRunning(false);
  }
  const stop = () => ctl.current?.abort();

  const setModel = (i, id) => setLanes((ls) => ls.map((l, k) => (k === i ? blankLane(id) : l)));
  const addLane = () => setLanes((ls) => (ls.length < MAX_LANES ? [...ls, blankLane(null)] : ls));
  const removeLane = (i) => setLanes((ls) => (ls.length > MIN_LANES ? ls.filter((_, k) => k !== i) : ls));

  // Turning the switch clears old results: a result belongs to the lane it was asked on.
  function toggleAttested() {
    if (running) return;
    const next = !attested;
    setAttested(next);
    setNotice("");
    setLinkNote("");
    setLanes((ls) => ls.map((l) => blankLane(l.model)));
    setAnnounce(next ? "Attested only is on. Model lists show models with an attested endpoint." : "Attested only is off.");
  }
  function applyPreset(preset) {
    if (running || !attestedList) return;
    const { models: ids, missing } = presetLanes(preset, attestedList);
    if (!ids.length) {
      setNotice(`None of the ${preset.label} models has an attested endpoint right now.`);
      return;
    }
    const name = (id) => attestedList.find((m) => m.id === id)?.name || id;
    setAttested(preset.attested === true);
    setLanes(pad(ids));
    setLinkNote("");
    setNotice(missing.length ? `${ids.length} of ${preset.models.length} ${preset.label} models have an attested endpoint right now. Without one: ${missing.join(", ")}.` : "");
    setAnnounce(`${preset.label}: ${ids.map(name).join(", ")}.`);
  }

  async function copyLink() {
    const { query, trimmed } = encodeArena({ prompt, models: chosen.map((l) => l.model), attested });
    const url = location.origin + location.pathname + query;
    try {
      history.replaceState(null, "", location.pathname + query);
    } catch {
      /* the address bar is optional */
    }
    let note = trimmed ? "Link copied. The prompt was trimmed to fit." : "Link copied.";
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      note = "The link is in your address bar. Copy it from there.";
    }
    setLinkNote(query ? note : "Nothing to share yet: write a prompt or choose models.");
  }

  const pickerFor = (i) => ({ models, ready: !!active, taken, onPick: (id) => setModel(i, id), index: i });
  const listError = attested ? attestedError : catalogError;
  const noKey = keyState === "none" || keyState === "rejected";

  return (
    <section className={styles.arena} aria-labelledby="arena-title">
      <div className={styles.grid} aria-hidden="true" />
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.inner}>
        <header className={styles.head}>
          <span className={styles.kicker}>
            <b>▲</b> Model Arena · live race
          </span>
          <h1 id="arena-title">
            One prompt.
            <br />
            <em>Every model, live.</em>
          </h1>
          <p>Race the same prompt across two to four models. Tokens stream side by side, and every answer ends with its time to first token, total time, cost and a signed receipt.</p>
        </header>

        {noKey && (
          <div className={styles.cta} role="region" aria-label="API key required">
            <div>
              <strong>{keyState === "rejected" ? "This tab’s API key was rejected." : "A funded API key runs the race."}</strong>
              <p>
                {keyState === "rejected" ? "Add a valid key or fund the workspace" : "Add a key or fund one in the dashboard"}, then return here. Your key stays in this browser tab and is only ever sent to the Anyroute API.
              </p>
            </div>
            <Button href="/dashboard/" light>
              Add or fund a key
            </Button>
          </div>
        )}
        {keyState === "ready" && balance !== null && balance <= 0 && (
          <div className={styles.cta} role="region" aria-label="Balance">
            <div>
              <strong>This key has no balance.</strong>
              <p>Each answer is billed per call at catalog prices. Fund the key to race.</p>
            </div>
            <Button href="/dashboard/" light>
              Fund in dashboard
            </Button>
          </div>
        )}
        {listError && (
          <div className={styles.cta} role="alert">
            <div>
              <strong>{attested ? "The attested model list could not load." : "The model list could not load."}</strong>
              <p>{listError}</p>
            </div>
            <Button secondary onClick={attested ? loadAttested : loadCatalog}>
              Retry
            </Button>
          </div>
        )}
        {notice && <p className={styles.notice}>{notice}</p>}
        {attested && attestedList && !attestedList.length && <p className={styles.notice}>No model has an attested endpoint right now, so there is nothing to race in this mode.</p>}

        <div className={styles.prompt}>
          <label htmlFor="arena-prompt">Prompt</label>
          <textarea
            id="arena-prompt"
            value={prompt}
            maxLength={MAX_PROMPT}
            rows={4}
            placeholder="Explain how a Merkle proof works in three sentences."
            disabled={running}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), race());
            }}
          />
          <span className={styles.count}>
            {prompt.length.toLocaleString("en-US")} / {MAX_PROMPT.toLocaleString("en-US")} · Ctrl/⌘ + Enter races
          </span>
        </div>

        <div className={styles.mode}>
          <button type="button" role="switch" aria-checked={attested} aria-describedby="arena-attested-note" className={styles.switchBtn} disabled={running} onClick={toggleAttested}>
            <span className={styles.switch} aria-hidden="true" />
            <span className={styles.switchText}>
              <b>Attested only</b>
              <small id="arena-attested-note">Models with an attested endpoint. Every lane asks for the attested lane and fails rather than fall back.</small>
            </span>
          </button>
          {PRESETS.map((preset) => (
            <button key={preset.id} type="button" className={styles.ghost} disabled={running || !attestedList} onClick={() => applyPreset(preset)}>
              {preset.label}
            </button>
          ))}
        </div>

        <div className={styles.lanes} data-lanes={lanes.length}>
          {lanes.map((lane, i) => (
            <Lane
              key={i}
              lane={lane}
              index={i}
              elapsed={elapsed}
              winners={winners}
              reserve={Object.values(winners).some((w) => w.length > 0)}
              picker={pickerFor(i)}
              locked={running}
              canRemove={lanes.length > MIN_LANES}
              onRemove={() => removeLane(i)}
            />
          ))}
        </div>

        <div className={styles.bar}>
          <div className={styles.actions}>
            {running ? (
              <Button secondary onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button light onClick={race} disabled={!!blocker} aria-describedby="arena-hint">
                Race
              </Button>
            )}
            <button type="button" className={styles.ghost} onClick={copyLink}>
              Copy link
            </button>
            <button type="button" className={styles.ghost} onClick={addLane} disabled={running || lanes.length >= MAX_LANES}>
              + Add lane
            </button>
            <label className={styles.cap}>
              <span>Answer cap</span>
              <select value={maxTokens} disabled={running} onChange={(e) => setMaxTokens(Number(e.target.value))}>
                {TOKEN_CAPS.map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString("en-US")} tokens
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className={styles.hintLine} id="arena-hint">
            {running ? "Racing…" : blocker || (ceiling > 0 ? `Worst case about ${formatUsd(ceiling)} if every answer hits its cap. Billed per call from your key’s balance.` : "Billed per call from your key’s balance.")}
            {attested && !running && !blocker && " A withheld answer is still billed."}
            {linkNote && <span className={styles.linkNote}> {linkNote}</span>}
          </p>
        </div>
        <p className="sr-only" role="status">
          {announce}
        </p>
      </div>
    </section>
  );
}
