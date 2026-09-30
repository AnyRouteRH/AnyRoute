"use client";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, clearKey, loadKey, saveKey, streamChat, validKey } from "../lib/api";
import { hasWallet, walletApiKey } from "../lib/wallet";
import { formatMs, formatUsd, receiptHref, estimateTokens } from "../lib/arena";
import { retryAfterMs } from "../lib/batch";
import {
  CAPS, DISCLOSURE_LABEL, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, SORTS, TOOL_PRESETS,
  applyChunk, attachmentKind, blankReply, buildRequest, capCounts, catalogueCounts, defaultSettings, filterCatalog,
  formatContext, formatPrice, groupByMaker, ignoredSettings, normalizeModel, parseTools, parseSchema, pcm16ToWav, replyFacts,
  routeAsModel, sampleToolResult, supportFor,
} from "../lib/harness";
import Markdown from "./Markdown";
import { Button, CopyButton, Modal } from "./UI";
import s from "./Harness.module.css";

const MAX_LANES = 3;
const FAVS = "anyroute-harness-favs";
const PREFS = "anyroute-harness-prefs";
const uid = () => Math.random().toString(36).slice(2, 10);
const read = (k, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable: preferences stay for this visit */
  }
};
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const EXAMPLES = [
  { text: "Explain what a signed receipt proves about an AI call, in three short paragraphs." },
  { text: "Write a TypeScript function that checks an IBAN, with three test cases." },
  { text: "What is the weather in Lisbon right now, and should I bring a jacket?", tools: ["get_weather"] },
  { text: "Give me three product names for a quiet coffee grinder as JSON with name and reason.", format: "json" },
];

// ---------------------------------------------------------------- small pieces

function Star({ on }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function Switch({ on, onChange, label, hint, disabled }) {
  return (
    <button type="button" className={s.switchRow} aria-pressed={!!on} onClick={() => onChange(!on)} disabled={disabled}>
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <i className={s.switch} aria-hidden="true" />
    </button>
  );
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" role="radio" key={String(v)} aria-checked={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, min, max, step, fallback, onChange }) {
  const id = "sl-" + label.replace(/\W/g, "");
  return (
    <div className={s.slider}>
      <label htmlFor={id}>
        {label}
        <span>
          {value === null ? "Default" : value}
          {value !== null && (
            <button type="button" className={s.reset} onClick={() => onChange(null)} aria-label={`Reset ${label} to the model default`}>
              Reset
            </button>
          )}
        </span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value ?? fallback} data-default={value === null || undefined} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function CapTags({ model }) {
  const tags = CAPS.filter((c) => model.caps.has(c.key));
  if (!tags.length) return <span className={s.capTag}>Text</span>;
  return tags.map((c) => (
    <span key={c.key} className={s.capTag} data-green={c.key === "attested" || undefined}>
      {c.label}
    </span>
  ));
}

// ---------------------------------------------------------------- model rail

function Rail({ models, routes, loading, error, onRetry, activeId, onPick, favs, toggleFav, prefs, setPrefs, searchRef, open, onClose }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const caps = prefs.caps || [];
  const all = useMemo(() => [...routes, ...models], [routes, models]);
  const list = useMemo(() => filterCatalog(all, { query: deferred, caps, sort: prefs.sort }), [all, deferred, caps, prefs.sort]);
  const counts = useMemo(() => capCounts(all, { query: deferred, caps }), [all, deferred, caps]);
  const favList = useMemo(() => (deferred || caps.length ? [] : all.filter((m) => favs.includes(m.id))), [all, favs, deferred, caps]);
  const groups = useMemo(() => {
    const rest = list.filter((m) => !m.route);
    const mine = list.filter((m) => m.route);
    const out = [];
    if (favList.length) out.push({ maker: "favs", label: "Favourites", models: favList });
    if (mine.length) out.push({ maker: "@route", label: "Your routes", models: mine });
    if (prefs.group) out.push(...groupByMaker(rest));
    else if (rest.length) out.push({ maker: "all", label: deferred || caps.length ? "Matches" : "All models", models: rest });
    return out;
  }, [list, favList, prefs.group, deferred, caps]);
  const toggleCap = (k) => setPrefs({ ...prefs, caps: caps.includes(k) ? caps.filter((x) => x !== k) : [...caps, k] });

  return (
    <aside className={s.rail} data-open={open || undefined} aria-label="Models">
      <div className={s.railHead}>
        <div className={s.railTitle}>
          <h2>Models</h2>
          <span className={s.count} aria-live="polite">
            {loading ? "Loading" : `${list.length} of ${all.length}`}
          </span>
          <button type="button" className={s.sheetClose} onClick={onClose} aria-label="Close models">
            Done
          </button>
        </div>
        <label className={s.search}>
          <span className="sr-only">Search models</span>
          <input ref={searchRef} type="search" placeholder="Search models or makers" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && list[0] && onPick(list[0].id)} spellCheck={false} autoComplete="off" />
          <kbd aria-hidden="true">{isMac() ? "⌘K" : "Ctrl K"}</kbd>
        </label>
        <div className={s.chips} role="group" aria-label="Filter by capability">
          {CAPS.map((c) => (
            <button type="button" key={c.key} aria-pressed={caps.includes(c.key)} onClick={() => toggleCap(c.key)} disabled={!caps.includes(c.key) && !counts[c.key]}>
              {c.label}
              <small>{counts[c.key] ?? 0}</small>
            </button>
          ))}
        </div>
        <div className={s.railSort}>
          <Segmented label="Sort models" value={prefs.sort} options={SORTS.map((x) => [x.key, x.label])} onChange={(v) => setPrefs({ ...prefs, sort: v })} />
          <button type="button" className={s.groupToggle} aria-pressed={!!prefs.group} onClick={() => setPrefs({ ...prefs, group: !prefs.group })}>
            By maker
          </button>
        </div>
      </div>
      <div className={s.railList} tabIndex={-1}>
        {error && (
          <div className={s.railNote}>
            <p>{error}</p>
            <button type="button" className="text-button" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {loading && !error && <div className={s.railSkeleton} aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</div>}
        {!loading && !error && !list.length && (
          <div className={s.railNote}>
            <p>No model matches every filter.</p>
            <button type="button" className="text-button" onClick={() => (setQuery(""), setPrefs({ ...prefs, caps: [] }))}>
              Clear filters
            </button>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.maker} className={s.group} aria-label={g.label}>
            <h3>
              {g.label}
              <span>{g.models.length}</span>
            </h3>
            <ul>
              {g.models.map((m) => (
                <li key={m.id} className={s.row} data-active={m.id === activeId || undefined}>
                  <button type="button" className={s.pick} onClick={() => onPick(m.id)} aria-current={m.id === activeId || undefined} title={m.id}>
                    <span className={s.rowName}>
                      {m.attested && <i className={s.att} title="Attested route available" />}
                      {m.name}
                    </span>
                    <span className={s.rowMeta}>
                      {!prefs.group || g.maker === "favs" || g.maker === "all" ? m.makerLabel + " · " : ""}
                      {formatContext(m.context)} · {formatPrice(m.inPrice)}
                      {m.outPrice ? " / " + formatPrice(m.outPrice) : ""}
                    </span>
                  </button>
                  {!m.route && (
                    <button type="button" className={s.fav} aria-pressed={favs.includes(m.id)} onClick={() => toggleFav(m.id)} aria-label={(favs.includes(m.id) ? "Remove " : "Add ") + m.name + (favs.includes(m.id) ? " from favourites" : " to favourites")}>
                      <Star on={favs.includes(m.id)} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className={s.railFoot}>Prices per 1M tokens, in / out.</p>
    </aside>
  );
}

// ---------------------------------------------------------------- command palette

function Palette({ models, onPick, onClose, title, onBrowse }) {
  const ref = useRef(null);
  const listRef = useRef(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useMemo(() => filterCatalog(models, { query, sort: "popular" }).slice(0, 60), [models, query]);
  useEffect(() => {
    const dlg = ref.current;
    dlg.showModal();
    return () => dlg.close();
  }, []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const key = (e) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(list.length - 1, a + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Enter" && list[active]) (e.preventDefault(), onPick(list[active].id));
  };
  return (
    <dialog ref={ref} className={s.palette} onCancel={(e) => (e.preventDefault(), onClose())} onClick={(e) => e.target === e.currentTarget && onClose()} aria-label={title}>
      <div className={s.paletteInner}>
        <label className={s.paletteSearch}>
          <span className="sr-only">{title}</span>
          <input autoFocus placeholder={title} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={key} role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={list[active] ? "pal-" + active : undefined} spellCheck={false} autoComplete="off" />
          <kbd>Esc</kbd>
        </label>
        <ul id="palette-list" role="listbox" ref={listRef} className={s.paletteList}>
          {list.map((m, i) => (
            <li key={m.id} id={"pal-" + i} role="option" aria-selected={i === active} data-active={i === active || undefined} onMouseMove={() => setActive(i)} onClick={() => onPick(m.id)}>
              <span className={s.palName}>
                {m.attested && <i className={s.att} />}
                {m.name}
                <small>{m.makerLabel}</small>
              </span>
              <span className={s.palCaps}>
                <CapTags model={m} />
              </span>
              <span className={s.palMeta}>
                {formatContext(m.context)} · {formatPrice(m.inPrice)}
              </span>
            </li>
          ))}
          {!list.length && <li className={s.palEmpty}>No model matches “{query}”.</li>}
        </ul>
        <p className={s.paletteFoot}>
          <span>↑↓ and Enter to choose</span>
          {onBrowse ? (
            <button type="button" className={s.palBrowse} onClick={onBrowse}>
              Filter all {models.length} models →
            </button>
          ) : (
            <span>{models.length} models</span>
          )}
        </p>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------- sign in

function SignIn({ onKey, onClose, reason }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const run = async (label, fn) => {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <Modal title={reason === "send" ? "Sign in to send" : "Sign in"} onClose={onClose}>
      <div className={s.signin}>
        <p>{reason === "send" ? "Your message and settings stay right here. Connect a key or your wallet and press send again." : "Use an Anyroute key or sign in with your wallet. The key stays in this tab only."}</p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!validKey(value)) return setError("That is not an Anyroute key (sk-ar-v1- followed by 64 hex characters).");
            run("key", () => onKey(value.trim()));
          }}
        >
          <div className="field">
            <label htmlFor="harness-key">API key</label>
            <input id="harness-key" type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-ar-v1-…" />
          </div>
          <div className="button-row">
            <Button type="submit" disabled={!!busy}>
              {busy === "key" ? "Connecting…" : "Connect key"}
            </Button>
            {hasWallet() && (
              <Button type="button" secondary disabled={!!busy} onClick={() => run("wallet", async () => onKey(await walletApiKey("Harness wallet key")))}>
                {busy === "wallet" ? "Waiting for signature…" : "Sign in with wallet"}
              </Button>
            )}
          </div>
        </form>
        <p className="help-text">
          No key yet? <a className="inline-link" href="/dashboard/">Create one in the dashboard</a>. Keys stay in this browser tab. Prompts are never stored.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- one reply

function AudioOut({ audio }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!audio?.data) return;
    let u;
    try {
      const bytes = /wav|mp3/.test(audio.format) ? Uint8Array.from(atob(audio.data), (c) => c.charCodeAt(0)) : pcm16ToWav(audio.data);
      u = URL.createObjectURL(new Blob([bytes], { type: audio.format === "mp3" ? "audio/mpeg" : "audio/wav" }));
      setUrl(u);
    } catch {
      setUrl(null);
    }
    return () => u && URL.revokeObjectURL(u);
  }, [audio?.data, audio?.format]);
  return (
    <div className={s.audio}>
      {url && <audio controls src={url} />}
      {audio.transcript && <p>{audio.transcript}</p>}
    </div>
  );
}

function ToolCalls({ msg, awaiting, onSubmit }) {
  const [results, setResults] = useState({});
  const calls = msg.toolCalls || [];
  const pretty = (a) => {
    try {
      return JSON.stringify(JSON.parse(a || "{}"), null, 2);
    } catch {
      return a;
    }
  };
  const ready = calls.every((c) => (results[c.id] ?? "").trim());
  return (
    <div className={s.tools}>
      {calls.map((c, i) => (
        <div className={s.toolCard} key={c.id || i}>
          <div className={s.toolHead}>
            <span>Tool call</span>
            <b>{c.name || "…"}</b>
          </div>
          <pre>{pretty(c.arguments)}</pre>
          {awaiting && (
            <div className={s.toolResult}>
              <label htmlFor={"tr-" + c.id}>
                Result
                {sampleToolResult(c) && (
                  <button type="button" className="text-button" onClick={() => setResults((r) => ({ ...r, [c.id]: sampleToolResult(c) }))}>
                    Fill a sample
                  </button>
                )}
              </label>
              <textarea id={"tr-" + c.id} rows={3} spellCheck={false} value={results[c.id] ?? ""} onChange={(e) => setResults((r) => ({ ...r, [c.id]: e.target.value }))} placeholder='{"result": …}' />
            </div>
          )}
        </div>
      ))}
      {awaiting && (
        <div className={s.toolActions}>
          <Button type="button" disabled={!ready} onClick={() => onSubmit(calls.map((c) => ({ call: c, text: results[c.id] })))}>
            Send {calls.length > 1 ? "results" : "result"}
          </Button>
          <span>The model continues with what you return.</span>
        </div>
      )}
    </div>
  );
}

function Reply({ msg, model, last, busy, onRegenerate, onToolResults, onSignIn }) {
  const facts = replyFacts(msg);
  const waiting = msg.status === "waiting";
  const streaming = msg.status === "streaming" || waiting;
  const awaitingTools = last && msg.status === "done" && (msg.toolCalls || []).length > 0 && !busy;
  return (
    <article className={s.reply} data-status={msg.status} aria-busy={streaming || undefined}>
      <header className={s.replyHead}>
        <b>{model?.name || msg.model}</b>
        <span>{model?.makerLabel}</span>
        {streaming && <span className={s.live}>{waiting ? "Routing" : "Streaming"}</span>}
      </header>
      {msg.reasoning && (
        <details className={s.thinking} open={streaming && !msg.text ? true : undefined}>
          <summary>
            Thinking
            {facts.reasoningTokens ? <small>{facts.reasoningTokens.toLocaleString("en-US")} tokens</small> : null}
          </summary>
          <div className={s.thinkingBody}>{msg.reasoning}</div>
        </details>
      )}
      {msg.text && <Markdown text={msg.text} />}
      {streaming && !msg.text && !msg.reasoning && !(msg.toolCalls || []).length && <div className={s.wait} role="progressbar" aria-label="Waiting for the first token"><i /></div>}
      {(msg.images || []).length > 0 && (
        <div className={s.images}>
          {msg.images.map((u, i) => (
            <a key={i} href={u} download={`anyroute-image-${i + 1}.png`} title="Download image">
              <img src={u} alt={`Generated image ${i + 1}`} />
            </a>
          ))}
        </div>
      )}
      {msg.audio && <AudioOut audio={msg.audio} />}
      {(msg.toolCalls || []).length > 0 && <ToolCalls msg={msg} awaiting={awaitingTools} onSubmit={onToolResults} />}
      {msg.notes?.map((n) => (
        <p className={s.note} key={n}>
          {n}
        </p>
      ))}
      {msg.error && (
        <div className={s.replyError} role="alert">
          <p>{msg.error}</p>
          {msg.errorKind === "auth" && (
            <button type="button" className="text-button" onClick={onSignIn}>
              Sign in again
            </button>
          )}
          {msg.errorKind === "funds" && (
            <a className="text-button" href="/dashboard/#payments">
              Add funds
            </a>
          )}
          {last && !busy && msg.errorKind !== "auth" && msg.errorKind !== "funds" && (
            <button type="button" className="text-button" onClick={onRegenerate}>
              Try again
            </button>
          )}
        </div>
      )}
      {!streaming && (msg.status === "done" || msg.status === "stopped" || facts.receiptId) && (
        <footer className={s.replyFoot}>
          <span title="Tokens in / out">
            {facts.tokensIn ?? "?"} in · {facts.tokensOut ?? "?"} out
          </span>
          <span title="Charged for this call">{facts.cost === null ? "cost pending" : formatUsd(facts.cost)}</span>
          {Number.isFinite(msg.ms) && <span title={msg.ttft != null ? `First token after ${formatMs(msg.ttft)}` : undefined}>{formatMs(msg.ms)}</span>}
          {facts.provider && <span>{facts.provider}</span>}
          {facts.disclosure && (
            <span className={facts.disclosure === "attested" ? s.attBadge : s.discl} title="Provider disclosure class, from the signed receipt">
              {DISCLOSURE_LABEL[facts.disclosure] || facts.disclosure}
            </span>
          )}
          {facts.receiptId && (
            <a href={receiptHref(facts.receiptId)} target="_blank" rel="noopener noreferrer" title={facts.receiptId}>
              Receipt ↗
            </a>
          )}
          <span className={s.footActions}>
            {msg.text && <CopyButton text={msg.text} />}
            {last && !busy && (
              <button type="button" className="text-button" onClick={onRegenerate}>
                Regenerate
              </button>
            )}
          </span>
        </footer>
      )}
    </article>
  );
}

function UserMsg({ msg, editing, onEdit, onCancel, onSave, busy }) {
  const [text, setText] = useState(msg.text);
  useEffect(() => setText(msg.text), [editing, msg.text]);
  return (
    <article className={s.user}>
      {editing ? (
        <form
          className={s.editForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onSave(text.trim());
          }}
        >
          <label className="sr-only" htmlFor={"edit-" + msg.id}>
            Edit message
          </label>
          <textarea
            id={"edit-" + msg.id}
            autoFocus
            value={text}
            rows={Math.min(10, text.split("\n").length + 1)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), text.trim() && onSave(text.trim()));
              if (e.key === "Escape") (e.stopPropagation(), onCancel());
            }}
          />
          <div className={s.editActions}>
            <button type="button" className="text-button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="text-button">
              Save and resend
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className={s.userText}>{msg.text}</div>
          {(msg.attachments || []).length > 0 && (
            <div className={s.userFiles}>
              {msg.attachments.map((a) => (a.kind === "image" ? <img key={a.id} src={a.url} alt={a.name} /> : <span key={a.id}>{a.name}</span>))}
            </div>
          )}
          {!busy && (
            <button type="button" className={s.editBtn} onClick={onEdit}>
              Edit
            </button>
          )}
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- tools panel

function ToolsPanel({ model, settings, set, open, onClose, compare, system, setSystem }) {
  const sup = supportFor(model);
  const toolsCheck = settings.tools ? parseTools(settings.toolsText) : {};
  const schemaCheck = settings.format === "schema" ? parseSchema(settings.schema) : {};
  const preview = useMemo(() => {
    if (!model) return null;
    const { body } = buildRequest({ model, settings, messages: [{ role: "user", text: "…" }] });
    const { messages, ...rest } = body;
    return { ...rest, messages: "[conversation]" };
  }, [model, settings]);
  const ignored = model ? ignoredSettings(model, settings) : [];
  const addPreset = (name) => {
    let list = [];
    try {
      const v = JSON.parse(settings.toolsText);
      list = Array.isArray(v) ? v : [v];
    } catch {
      list = [];
    }
    if (!list.some((t) => (t.function || t).name === name)) list.push(TOOL_PRESETS[name]);
    set({ tools: true, toolsText: JSON.stringify(list, null, 2) });
  };
  if (!model) return <aside className={s.toolsPanel} aria-label="Tools" />;
  const any = sup.reasoning || sup.web || sup.json || sup.schema || sup.tools || sup.imageOut || sup.audioOut || sup.verbosity;
  return (
    <aside className={s.toolsPanel} data-open={open || undefined} aria-label="Tools">
      <div className={s.toolsHead}>
        <div>
          <h2>Tools</h2>
          <p>
            For <b>{model.name}</b>. Only what it supports is shown and sent.
          </p>
        </div>
        <button type="button" className={s.sheetClose} onClick={onClose} aria-label="Close tools">
          Done
        </button>
      </div>
      <div className={s.toolsBody}>
        <section className={s.sect}>
          <h3>
            <label htmlFor="system-prompt">System prompt</label>
          </h3>
          <textarea id="system-prompt" className={s.systemInput} rows={3} value={system} placeholder={compare ? "How every model should behave in this chat" : "How the model should behave in this chat"} onChange={(e) => setSystem(e.target.value)} />
        </section>
        {!any && <p className={s.quiet}>This model takes text and sampling settings only.</p>}
        {sup.reasoning && (
          <section className={s.sect}>
            <h3>Reasoning</h3>
            <Segmented label="Reasoning" value={settings.reasoning} options={[[null, "Default"], [true, "On"], [false, "Off"]]} onChange={(v) => set({ reasoning: v })} />
            {settings.reasoning === true && sup.effort && (
              <div className={s.sub}>
                <span>Effort</span>
                <Segmented label="Reasoning effort" value={settings.effort} options={[["low", "Low"], ["medium", "Medium"], ["high", "High"]]} onChange={(v) => set({ effort: v })} />
              </div>
            )}
          </section>
        )}
        {sup.web && (
          <section className={s.sect}>
            <Switch label="Web search" hint="Answers cite live results" on={settings.web} onChange={(v) => set({ web: v })} />
            {settings.web && <Segmented label="Search context" value={settings.webSize} options={[["low", "Low"], ["medium", "Medium"], ["high", "High"]]} onChange={(v) => set({ webSize: v })} />}
          </section>
        )}
        {(sup.json || sup.schema) && (
          <section className={s.sect}>
            <h3>Output</h3>
            <Segmented
              label="Output format"
              value={settings.format}
              options={[["text", "Text"], ...(sup.json ? [["json", "JSON"]] : []), ...(sup.schema ? [["schema", "Schema"]] : [])]}
              onChange={(v) => set({ format: v })}
            />
            {settings.format === "schema" && sup.schema && (
              <>
                <label className="sr-only" htmlFor="schema-editor">
                  JSON schema
                </label>
                <textarea id="schema-editor" className={s.editor} rows={9} spellCheck={false} value={settings.schema} onChange={(e) => set({ schema: e.target.value })} />
                {schemaCheck.error && <p className={s.bad}>{schemaCheck.error}</p>}
              </>
            )}
          </section>
        )}
        {sup.tools && (
          <section className={s.sect}>
            <Switch label="Function tools" hint="You answer each call by hand" on={settings.tools} onChange={(v) => set({ tools: v })} />
            {settings.tools && (
              <>
                <div className={s.presets}>
                  <span>Add</span>
                  {Object.keys(TOOL_PRESETS).map((k) => (
                    <button type="button" key={k} onClick={() => addPreset(k)}>
                      {k}
                    </button>
                  ))}
                  <button type="button" onClick={() => set({ toolsText: "[]" })}>
                    Clear
                  </button>
                </div>
                <label className="sr-only" htmlFor="tools-editor">
                  Function tools, JSON
                </label>
                <textarea id="tools-editor" className={s.editor} rows={10} spellCheck={false} value={settings.toolsText} onChange={(e) => set({ toolsText: e.target.value })} />
                {toolsCheck.error ? <p className={s.bad}>{toolsCheck.error}</p> : <p className={s.good}>{toolsCheck.tools?.length} tool{toolsCheck.tools?.length === 1 ? "" : "s"} ready</p>}
                {sup.toolChoice && (
                  <div className={s.sub}>
                    <span>Tool choice</span>
                    <Segmented label="Tool choice" value={settings.toolChoice} options={[["auto", "Auto"], ["required", "Required"], ["none", "None"]]} onChange={(v) => set({ toolChoice: v })} />
                  </div>
                )}
              </>
            )}
          </section>
        )}
        {(sup.imageOut || sup.audioOut) && (
          <section className={s.sect}>
            <h3>Media out</h3>
            {sup.imageOut && <Switch label="Image output" hint="Replies can include images" on={settings.imageOut} onChange={(v) => set({ imageOut: v, audioOut: v ? false : settings.audioOut })} />}
            {sup.audioOut && <Switch label="Audio output" hint="Replies come back spoken" on={settings.audioOut} onChange={(v) => set({ audioOut: v, imageOut: v ? false : settings.imageOut })} />}
            {sup.audioOut && settings.audioOut && (
              <div className={s.sub}>
                <span>Voice</span>
                <Segmented label="Voice" value={settings.voice} options={[["alloy", "Alloy"], ["verse", "Verse"], ["sage", "Sage"]]} onChange={(v) => set({ voice: v })} />
              </div>
            )}
          </section>
        )}
        {sup.verbosity && (
          <section className={s.sect}>
            <h3>Verbosity</h3>
            <Segmented label="Verbosity" value={settings.verbosity} options={[[null, "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]]} onChange={(v) => set({ verbosity: v })} />
          </section>
        )}
        <section className={s.sect}>
          <h3>Sampling</h3>
          {sup.temperature && <Slider label="Temperature" value={settings.temperature} min={0} max={2} step={0.05} fallback={1} onChange={(v) => set({ temperature: v })} />}
          {sup.topP && <Slider label="Top p" value={settings.topP} min={0} max={1} step={0.01} fallback={1} onChange={(v) => set({ topP: v })} />}
          <div className={s.pair}>
            {sup.maxTokens && (
              <label>
                Max tokens
                <input type="number" min={1} max={model.maxOut || undefined} inputMode="numeric" placeholder={model.maxOut ? String(model.maxOut) : "Default"} value={settings.maxTokens ?? ""} onChange={(e) => set({ maxTokens: e.target.value ? Number(e.target.value) : null })} />
              </label>
            )}
            {sup.seed && (
              <label>
                Seed
                <input type="number" inputMode="numeric" placeholder="Random" value={settings.seed ?? ""} onChange={(e) => set({ seed: e.target.value === "" ? null : Number(e.target.value) })} />
              </label>
            )}
          </div>
          {sup.stop && (
            <label className={s.wide}>
              Stop sequences
              <input type="text" placeholder="Comma separated, up to 4" value={settings.stop} onChange={(e) => set({ stop: e.target.value })} />
            </label>
          )}
        </section>
        {(ignored.length > 0 || compare) && (
          <p className={s.quiet}>
            {ignored.length > 0 && <>Not sent to this model: {ignored.join(", ")}. </>}
            {compare && "In compare, each model receives only the settings it supports."}
          </p>
        )}
        <details className={s.preview}>
          <summary>Request preview</summary>
          <pre tabIndex={0}>{JSON.stringify(preview, null, 2)}</pre>
        </details>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- the page

export default function Harness() {
  const [raw, setRaw] = useState(null);
  const [catalogError, setCatalogError] = useState("");
  const [routeRows, setRouteRows] = useState([]);
  const [prefs, setPrefsState] = useState({ sort: "popular", group: true, caps: [] });
  const [favs, setFavs] = useState([]);
  const [lanes, setLanes] = useState([{ id: "l0", modelId: null, messages: [] }]);
  const [focus, setFocus] = useState(0);
  const [system, setSystem] = useState("");
  const [settings, setSettings] = useState(defaultSettings);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const [fileNote, setFileNote] = useState("");
  const [palette, setPalette] = useState(null); // { lane, add }
  const [sheet, setSheet] = useState(null); // "models" | "tools" on small screens
  const [auth, setAuth] = useState({ key: "", label: "", balance: null, tier: null, state: "checking" });
  const [signin, setSignin] = useState(null); // reason
  const [editing, setEditing] = useState(null); // message id
  const [inflight, setInflight] = useState(0);
  const [drag, setDrag] = useState(false);
  const [announce, setAnnounce] = useState("");
  const controllers = useRef(new Map());
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const systemRef = useRef(system);
  systemRef.current = system;
  const authRef = useRef(auth);
  authRef.current = auth;
  const input = useRef(null);
  const searchRef = useRef(null);
  const scroller = useRef(null);
  const stick = useRef(true);
  const pendingSend = useRef(false);
  const headsRef = useRef(null);
  const lanesRef2 = useRef(null);
  // On phones the compare lanes scroll sideways; keep their headers in step.
  const syncScroll = (e, other) => {
    if (other.current && Math.abs(other.current.scrollLeft - e.currentTarget.scrollLeft) > 1) other.current.scrollLeft = e.currentTarget.scrollLeft;
  };

  // ---- data ----
  const loadCatalog = useCallback(() => {
    setCatalogError("");
    api("/api/v1/models")
      .then((r) => setRaw(r.data || []))
      .catch((e) => setCatalogError(e?.message || "The model catalogue could not be loaded."));
  }, []);
  const models = useMemo(() => (raw || []).filter((m) => !(m.architecture?.output_modalities || []).includes("embeddings")).map(normalizeModel), [raw]);
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const routes = useMemo(() => routeRows.map((r) => routeAsModel(r, byId)), [routeRows, byId]);
  const all = useMemo(() => [...routes, ...models], [routes, models]);
  const find = useCallback((id) => all.find((m) => m.id === id) || null, [all]);
  const counts = useMemo(() => catalogueCounts(models), [models]);

  const loadAccount = useCallback(async (key) => {
    const [me, credits] = await Promise.all([api("/api/v1/key", { key }), api("/api/v1/credits", { key })]);
    setAuth({ key, label: me.data?.label || me.data?.name || "Key", balance: credits.data?.available ?? null, tier: null, state: "ok" });
    api("/api/v1/holder", { key })
      .then((r) => r.data?.tier?.name && setAuth((a) => (a.key === key ? { ...a, tier: r.data.tier.name } : a)))
      .catch(() => {});
    api("/api/v1/routes", { key })
      .then((r) => setRouteRows(r.data || []))
      .catch(() => setRouteRows([]));
  }, []);
  const refreshBalance = useCallback(() => {
    const key = authRef.current.key;
    if (key) api("/api/v1/credits", { key }).then((r) => setAuth((a) => (a.key === key ? { ...a, balance: r.data?.available ?? a.balance } : a))).catch(() => {});
  }, []);
  const signOut = useCallback(() => {
    clearKey();
    setAuth({ key: "", label: "", balance: null, tier: null, state: "none" });
    setRouteRows([]);
  }, []);

  useEffect(() => {
    loadCatalog();
    setFavs(read(FAVS, []));
    const p = read(PREFS, null);
    if (p) setPrefsState((x) => ({ ...x, ...p }));
    const stored = loadKey();
    if (stored)
      loadAccount(stored).catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) clearKey();
        setAuth((a) => ({ ...a, state: "none" }));
      });
    else setAuth((a) => ({ ...a, state: "none" }));
    return () => controllers.current.forEach((c) => c.abort());
  }, [loadCatalog, loadAccount]);

  // First model: the last one used, else a popular model with tools.
  useEffect(() => {
    if (!models.length || lanesRef.current[0].modelId) return;
    const last = read(PREFS, {})?.model;
    const pick = (last && byId.get(last)) || filterCatalog(models, { caps: ["tools"], sort: "popular" })[0] || models[0];
    setLanes((ls) => ls.map((l, i) => (i === 0 ? { ...l, modelId: pick.id } : l)));
  }, [models, byId]);

  const setPrefs = (p) => {
    setPrefsState(p);
    write(PREFS, { ...read(PREFS, {}), sort: p.sort, group: p.group, caps: p.caps });
  };
  const toggleFav = (id) =>
    setFavs((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [id, ...f].slice(0, 40);
      write(FAVS, next);
      return next;
    });
  const set = (patch) => setSettings((x) => ({ ...x, ...patch }));

  const compare = lanes.length > 1;
  const focusLane = lanes[Math.min(focus, lanes.length - 1)];
  const focusModel = find(focusLane?.modelId);
  const busy = inflight > 0;
  const empty = lanes.every((l) => !l.messages.length);
  const acceptsImages = lanes.some((l) => supportFor(find(l.modelId)).images);
  const acceptsFiles = lanes.some((l) => supportFor(find(l.modelId)).files);

  const pickModel = (id, laneIndex = focus, add = false) => {
    setPalette(null);
    setSheet(null);
    if (add) {
      setLanes((ls) => (ls.length >= MAX_LANES ? ls : [...ls, { id: "l" + uid(), modelId: id, messages: structuredClone(ls[focus]?.messages || []) }]));
      setFocus(Math.min(MAX_LANES - 1, lanesRef.current.length));
      return;
    }
    setLanes((ls) => ls.map((l, i) => (i === laneIndex ? { ...l, modelId: id } : l)));
    if (laneIndex === 0) write(PREFS, { ...read(PREFS, {}), model: id });
    const m = find(id);
    if (m) setAnnounce(`${m.name} selected.`);
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => (p ? null : { lane: focus, add: false }));
      } else if (e.key === "Escape" && sheet && !document.querySelector("dialog[open]")) setSheet(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [focus, sheet]);

  // ---- scrolling: follow the stream unless the reader scrolled up ----
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && lanes.some((l) => l.messages.length)) el.scrollTop = el.scrollHeight;
  }, [lanes]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // ---- sending ----
  const patchMsg = (laneId, msgId, patch) => setLanes((ls) => ls.map((l) => (l.id === laneId ? { ...l, messages: l.messages.map((m) => (m.id === msgId ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)) } : l)));

  async function runLane(laneId, modelId, history, msgId) {
    const model = find(modelId);
    const key = authRef.current.key;
    if (!model) return patchMsg(laneId, msgId, { status: "error", error: "Choose a model first." });
    const { body, notes, error } = buildRequest({ model, settings: settingsRef.current, system: systemRef.current, messages: history });
    if (error) return patchMsg(laneId, msgId, { status: "error", error, errorKind: "settings" });
    const ctl = new AbortController();
    controllers.current.set(msgId, ctl);
    setInflight((n) => n + 1);
    const t0 = performance.now();
    let ttft = null;
    let reply = blankReply();
    let raf = 0;
    const flush = () => {
      raf = 0;
      patchMsg(laneId, msgId, { ...reply, status: "streaming", ttft });
    };
    patchMsg(laneId, msgId, { notes });
    try {
      await streamChat({
        key,
        body,
        signal: ctl.signal,
        headers: { "x-title": "Anyroute Harness" },
        onEvent: (ev) => {
          reply = applyChunk(reply, ev);
          if (ttft === null && (reply.text || reply.reasoning || reply.toolCalls.length || reply.images.length || reply.audio)) ttft = performance.now() - t0;
          if (!raf) raf = requestAnimationFrame(flush);
        },
      });
      cancelAnimationFrame(raf);
      patchMsg(laneId, msgId, { ...reply, status: "done", ttft, ms: performance.now() - t0 });
    } catch (err) {
      cancelAnimationFrame(raf);
      const stopped = err?.name === "AbortError";
      let message = err?.message || "The route failed.";
      let kind = err?.type || "";
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        message = "This key was not accepted. Sign in again to keep going.";
        kind = "auth";
        signOut();
      } else if (err instanceof ApiError && err.status === 402) {
        message = "Your balance is too low for this call. Add funds, then try again.";
        kind = "funds";
      } else if (err instanceof ApiError && err.status === 429) {
        const wait = retryAfterMs(err);
        message = wait != null ? `Rate limited. You can try again in ${Math.max(1, Math.ceil(wait / 1000))} s.` : "Rate limited. Wait a moment and try again.";
        kind = "rate";
      }
      patchMsg(laneId, msgId, { ...reply, status: stopped ? "stopped" : "error", ttft, ms: performance.now() - t0, error: stopped ? (reply.text ? "Stopped. The part already delivered is billed." : "Stopped before the first token.") : message, errorKind: stopped ? "stopped" : kind });
    } finally {
      controllers.current.delete(msgId);
      setInflight((n) => n - 1);
      refreshBalance();
    }
  }

  const needKey = (reason) => {
    if (authRef.current.key) return false;
    pendingSend.current = true;
    setSignin(reason);
    return true;
  };

  /** Append a user turn to every lane and run them all. `truncate` (user turn index) drops that turn and what follows first. */
  function send(text, attachments = files, truncate = null) {
    const body = text.trim();
    if (!body || busy) return;
    if (needKey("send")) return;
    if (lanes.some((l) => !find(l.modelId))) return;
    stick.current = true;
    const jobs = [];
    const next = lanesRef.current.map((l) => {
      let msgs = l.messages;
      if (truncate !== null) {
        let seen = -1;
        const cut = msgs.findIndex((m) => m.role === "user" && ++seen === truncate);
        if (cut >= 0) msgs = msgs.slice(0, cut);
      }
      const user = { id: uid(), role: "user", text: body, attachments };
      const reply = { id: uid(), role: "assistant", model: l.modelId, status: "waiting", text: "" };
      const history = [...msgs, user];
      jobs.push([l.id, l.modelId, history, reply.id]);
      return { ...l, messages: [...history, reply] };
    });
    setLanes(next);
    setDraft("");
    setFiles([]);
    setFileNote("");
    setEditing(null);
    jobs.forEach((j) => runLane(...j));
  }

  function regenerate(laneId) {
    if (busy || needKey("send")) return;
    const lane = lanesRef.current.find((l) => l.id === laneId);
    if (!lane) return;
    const lastUser = lane.messages.map((m) => m.role).lastIndexOf("user");
    const lastTool = lane.messages.map((m) => m.role).lastIndexOf("tool");
    const cut = Math.max(lastUser, lastTool) + 1;
    const history = lane.messages.slice(0, cut);
    const reply = { id: uid(), role: "assistant", model: lane.modelId, status: "waiting", text: "" };
    setLanes((ls) => ls.map((l) => (l.id === laneId ? { ...l, messages: [...history, reply] } : l)));
    runLane(laneId, lane.modelId, history, reply.id);
  }

  function toolResults(laneId, results) {
    if (busy || needKey("send")) return;
    const lane = lanesRef.current.find((l) => l.id === laneId);
    const toolMsgs = results.map(({ call, text }) => ({ id: uid(), role: "tool", toolCallId: call.id, name: call.name, text: text.trim() }));
    const history = [...lane.messages, ...toolMsgs];
    const reply = { id: uid(), role: "assistant", model: lane.modelId, status: "waiting", text: "" };
    setLanes((ls) => ls.map((l) => (l.id === laneId ? { ...l, messages: [...history, reply] } : l)));
    runLane(laneId, lane.modelId, history, reply.id);
  }

  const stop = () => controllers.current.forEach((c) => c.abort());
  const newChat = () => {
    stop();
    setLanes((ls) => ls.map((l) => ({ ...l, messages: [] })));
    setEditing(null);
    input.current?.focus();
  };
  const toggleCompare = () => {
    if (compare) {
      setLanes((ls) => [ls[Math.min(focus, ls.length - 1)]]);
      setFocus(0);
    } else setPalette({ lane: 1, add: true });
  };
  const removeLane = (i) => {
    setLanes((ls) => ls.filter((_, k) => k !== i));
    setFocus(0);
  };

  // ---- attachments ----
  async function addFiles(list) {
    const incoming = [...list];
    const notes = [];
    const out = [];
    for (const f of incoming) {
      const kind = attachmentKind(f.type, f.name);
      if (!kind) {
        notes.push(`${f.name}: this file type is not sent.`);
        continue;
      }
      if ((kind === "image" && !acceptsImages) || (kind === "file" && !acceptsFiles)) {
        notes.push(`${f.name}: the selected model does not read ${kind === "image" ? "images" : "files"}.`);
        continue;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        notes.push(`${f.name}: larger than 8 MB.`);
        continue;
      }
      const url = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      }).catch(() => null);
      if (url) out.push({ id: uid(), kind, name: f.name || (kind === "image" ? "pasted image" : "file"), size: f.size, url });
    }
    setFiles((x) => {
      const merged = [...x, ...out];
      if (merged.length > MAX_ATTACHMENTS) notes.push(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      return merged.slice(0, MAX_ATTACHMENTS);
    });
    setFileNote(notes.join(" "));
  }

  // Auto-size the composer.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    if (draft) el.style.height = Math.min(240, el.scrollHeight) + "px";
  }, [draft]);

  const onKey = async (key) => {
    saveKey(key);
    await loadAccount(key);
    setSignin(null);
    if (pendingSend.current) {
      pendingSend.current = false;
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  const tryExample = (ex) => {
    const patch = {};
    if (ex.tools && supportFor(focusModel).tools) Object.assign(patch, { tools: true, toolsText: JSON.stringify(ex.tools.map((t) => TOOL_PRESETS[t]), null, 2) });
    if (ex.format && supportFor(focusModel).json) patch.format = ex.format;
    if (Object.keys(patch).length) set(patch);
    setDraft(ex.text);
    input.current?.focus();
  };

  const turnIndex = (lane, msgId) => {
    let n = -1;
    for (const m of lane.messages) {
      if (m.role === "user") n++;
      if (m.id === msgId) return n;
    }
    return -1;
  };
  const promptCost = focusModel ? (estimateTokens(system + draft + lanes[0].messages.map((m) => m.text || "").join(" ")) * focusModel.inPrice) / 1e6 : 0;
  const mod = isMac() ? "⌘" : "Ctrl";

  return (
    <div className={s.harness} data-dark-hero data-compare={compare || undefined}>
      <Rail
        models={models}
        routes={routes}
        loading={!raw && !catalogError}
        error={catalogError}
        onRetry={loadCatalog}
        activeId={focusModel?.id}
        onPick={(id) => pickModel(id)}
        favs={favs}
        toggleFav={toggleFav}
        prefs={prefs}
        setPrefs={setPrefs}
        searchRef={searchRef}
        open={sheet === "models"}
        onClose={() => setSheet(null)}
      />

      <main
        id="content"
        className={s.stage}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes("Files")) (e.preventDefault(), setDrag(true));
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
        }}
      >
        <div className={s.bar}>
          {!compare && (
            <button type="button" className={s.modelBtn} onClick={() => setPalette({ lane: 0, add: false })} aria-label={`Model: ${focusModel?.name || "none"}. Change model`} aria-keyshortcuts="Meta+K Control+K">
              <b>{focusModel?.name || "Loading models"}</b>
              <span>{focusModel ? `${focusModel.makerLabel} · ${formatContext(focusModel.context)} · ${formatPrice(focusModel.inPrice)} / ${formatPrice(focusModel.outPrice)}` : ""}</span>
            </button>
          )}
          {compare && (
            <button type="button" className={s.barTitle} onClick={() => setSheet("models")}>
              Comparing {lanes.length} models
            </button>
          )}
          <div className={s.barRight}>
            <button type="button" className={s.barToggle} aria-pressed={compare} onClick={toggleCompare} disabled={!models.length}>
              <i className={s.switch} aria-hidden="true" />
              Compare
            </button>
            {!empty && (
              <button type="button" className={s.barLink} onClick={newChat}>
                New chat
              </button>
            )}
            <button type="button" className={s.toolsBtn} onClick={() => setSheet("tools")}>
              Tools
            </button>
            {auth.state === "ok" ? (
              <div className={s.account}>
                <span title={auth.label}>
                  <b>{auth.balance === null ? "Signed in" : "$" + Number(auth.balance).toFixed(2)}</b>
                  {auth.tier && <small>{auth.tier}</small>}
                </span>
                <button type="button" className={s.barLink} onClick={signOut}>
                  Sign out
                </button>
              </div>
            ) : (
              <button type="button" className={s.signBtn} onClick={() => setSignin("header")} disabled={auth.state === "checking"}>
                Sign in
              </button>
            )}
          </div>
        </div>

        {compare && (
          <div className={s.laneHeads} style={{ "--lanes": lanes.length }} ref={headsRef} onScroll={(e) => syncScroll(e, lanesRef2)}>
            {lanes.map((l, i) => {
              const m = find(l.modelId);
              return (
                <div key={l.id} className={s.laneHead} data-focus={i === focus || undefined}>
                  <button
                    type="button"
                    onClick={() => (i === focus ? setPalette({ lane: i, add: false }) : setFocus(i))}
                    aria-pressed={i === focus}
                    aria-label={i === focus ? `${m?.name}, tools shown. Change model` : `${m?.name}. Show its tools`}
                    title={i === focus ? "Change model" : "Show this model's tools"}
                  >
                    <b>{m?.name}</b>
                    <span>{m ? `${m.makerLabel} · ${formatPrice(m.inPrice)} / ${formatPrice(m.outPrice)}` : ""}</span>
                  </button>
                  {lanes.length > 1 && (
                    <button type="button" className={s.laneX} onClick={() => removeLane(i)} aria-label={`Remove ${m?.name} from compare`}>
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            {lanes.length < MAX_LANES && (
              <button type="button" className={s.laneAdd} onClick={() => setPalette({ lane: lanes.length, add: true })}>
                + Add a model
              </button>
            )}
          </div>
        )}

        <div className={s.scroll} ref={scroller} onScroll={onScroll}>
          {empty ? (
            <div className={s.empty}>
              <h1 className={s.display}>
                <span className={s.line}>
                  <span className={s.w} style={{ "--i": 0 }}>Every</span> <span className={s.w} style={{ "--i": 1 }}>model.</span>
                </span>
                <span className={s.line}>
                  <span className={s.w} style={{ "--i": 2 }}>
                    <mark>One page.</mark>
                  </span>
                </span>
              </h1>
              <p className={s.lede}>Choose a model at the top, then type below. Every reply shows what it cost, with a signed receipt.</p>
              <p className={s.counts} aria-label="Live catalogue">
                {raw ? `${counts.models.toLocaleString("en-US")} models from ${counts.makers} makers, live` : "Loading the live catalogue"}
              </p>
              <ul className={s.examples} aria-label="Example prompts">
                {EXAMPLES.map((ex) => (
                  <li key={ex.text}>
                    <button type="button" onClick={() => tryExample(ex)}>
                      <span>{ex.text}</span>
                      <b aria-hidden="true">→</b>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className={s.lanes} style={{ "--lanes": lanes.length }} ref={lanesRef2} onScroll={(e) => syncScroll(e, headsRef)}>
              {lanes.map((l, li) => {
                const lastId = l.messages[l.messages.length - 1]?.id;
                return (
                  <div key={l.id} className={s.lane} onClick={() => compare && setFocus(li)}>
                    {l.messages.map((m) =>
                      m.role === "user" ? (
                        <UserMsg key={m.id} msg={m} busy={busy} editing={editing === m.id} onEdit={() => setEditing(m.id)} onCancel={() => setEditing(null)} onSave={(t) => send(t, m.attachments || [], turnIndex(l, m.id))} />
                      ) : m.role === "tool" ? (
                        <div key={m.id} className={s.toolMsg}>
                          <span>{m.name} returned</span>
                          <code>{m.text}</code>
                        </div>
                      ) : (
                        <Reply key={m.id} msg={m} model={find(m.model)} last={m.id === lastId} busy={busy} onRegenerate={() => regenerate(l.id)} onToolResults={(r) => toolResults(l.id, r)} onSignIn={() => setSignin("send")} />
                      ),
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <form
          className={s.composer}
          onSubmit={(e) => {
            e.preventDefault();
            busy ? stop() : send(draft);
          }}
        >
          {files.length > 0 && (
            <ul className={s.tray} aria-label="Attachments">
              {files.map((f) => (
                <li key={f.id}>
                  {f.kind === "image" ? <img src={f.url} alt="" /> : <span className={s.fileIcon}>{f.name.split(".").pop()}</span>}
                  <span>{f.name}</span>
                  <button type="button" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} aria-label={`Remove ${f.name}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fileNote && <p className={s.fileNote} role="status">{fileNote}</p>}
          <div className={s.box}>
            {(acceptsImages || acceptsFiles) && (
              <label className={s.attach} title={acceptsFiles ? "Attach images or files" : "Attach images"}>
                <span className="sr-only">{acceptsFiles ? "Attach images or files" : "Attach images"}</span>
                <input type="file" multiple accept={[acceptsImages && "image/png,image/jpeg,image/webp,image/gif", acceptsFiles && "application/pdf,text/plain,text/markdown,text/csv,application/json"].filter(Boolean).join(",")} onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </label>
            )}
            <label className="sr-only" htmlFor="harness-input">
              Message
            </label>
            <textarea
              id="harness-input"
              ref={input}
              rows={1}
              value={draft}
              placeholder={focusModel ? `Message ${compare ? lanes.length + " models" : focusModel.name}` : "Loading models…"}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const pasted = [...(e.clipboardData?.files || [])];
                if (pasted.length) (e.preventDefault(), addFiles(pasted));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!busy) send(draft);
                }
              }}
            />
            <button type="submit" className={s.send} data-busy={busy || undefined} disabled={!busy && (!draft.trim() || !focusModel)}>
              {busy ? "Stop" : "Send"}
              <b aria-hidden="true">{busy ? "■" : "↵"}</b>
            </button>
          </div>
          <p className={s.hints}>
            <span>
              <kbd>{mod} K</kbd> switch model
            </span>
            {focusModel && draft.trim() && <span className={s.est}>Prompt ≈ {formatUsd(promptCost)}</span>}
          </p>
        </form>
        {drag && (
          <div className={s.drop} aria-hidden="true">
            <p>{acceptsImages || acceptsFiles ? `Drop to attach ${acceptsFiles ? "images or files" : "images"}` : "This model reads text only"}</p>
          </div>
        )}
      </main>

      <ToolsPanel model={focusModel} settings={settings} set={set} open={sheet === "tools"} onClose={() => setSheet(null)} compare={compare} system={system} setSystem={setSystem} />
      {sheet && <button type="button" className={s.scrim} aria-label="Close panel" onClick={() => setSheet(null)} />}

      {palette && (
        <Palette
          models={palette.add ? all.filter((m) => !lanes.some((l) => l.modelId === m.id)) : all}
          title={palette.add ? "Add a model to compare" : "Switch model"}
          onClose={() => setPalette(null)}
          onPick={(id) => pickModel(id, palette.lane, palette.add)}
          onBrowse={palette.add ? undefined : () => (setPalette(null), setSheet("models"))}
        />
      )}
      {signin && <SignIn reason={signin} onKey={onKey} onClose={() => (setSignin(null), (pendingSend.current = false))} />}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
