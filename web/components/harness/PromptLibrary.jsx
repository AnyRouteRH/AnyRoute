"use client";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../UI";
import { formatUsd } from "../../lib/arena";
import { STARTER_PROMPTS, MAX_PROMPT_BYTES, fillPrompt, promptVariables, importPrompts, exportPrompts, mergePrompts, readPrompts, writePrompts, validatePrompts, searchPrompts, slashPrompts, promptShortcut } from "../../lib/harness-prompts.js";
import s from "./PromptLibrary.module.css";

const newId = () => "p-" + crypto.randomUUID();
const ordinary = "ordinary";

export function usePromptLibrary({ privateMode, history, draft, system, model, focus, busy, models, setDraft, setSystem, setLanes, setFocus, input, setFiles, setEditing, stopVoice }) {
  const scope = privateMode ? (history?.unlocked ? history : null) : ordinary;
  const [data, setData] = useState({ scope: null, items: [], error: "" });
  const [view, setView] = useState(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(null);
  const live = useRef(scope);
  live.current = scope;
  useEffect(() => {
    setView(null);
    setDismissed(null);
    try {
      const items = privateMode ? (history?.unlocked ? history.listPrompts() ?? structuredClone(STARTER_PROMPTS) : structuredClone(STARTER_PROMPTS)) : readPrompts(localStorage);
      setData({ scope, items, error: "" });
    } catch (e) { setData({ scope, items: [], error: e.message }); }
  }, [scope, privateMode, history]);
  useEffect(() => { setActive(0); }, [draft]);
  const items = data.scope === scope ? data.items : [];
  const open = () => { stopVoice?.(); setView({ scope, kind: "list" }); };
  useEffect(() => {
    const key = (e) => {
      if (promptShortcut(e) && !document.querySelector("dialog[open]")) { e.preventDefault(); open(); }
    };
    const hash = () => { if (location.hash === "#prompt-library" && !document.querySelector("dialog[open]")) open(); };
    addEventListener("keydown", key);
    addEventListener("hashchange", hash);
    hash();
    return () => { removeEventListener("keydown", key); removeEventListener("hashchange", hash); };
  }, [scope]);
  const save = (text = draft, savedModel = model) => {
    stopVoice?.();
    setView({ scope, kind: "edit", prompt: { id: newId(), name: "", text, tags: [], pinned: false, ...(system ? { system } : {}), ...(savedModel ? { model: savedModel } : {}) } });
  };
  const select = (prompt, compare = false) => { stopVoice?.(); setView({ scope, kind: "use", prompt, compare }); };
  const suggestions = dismissed === draft ? [] : slashPrompts(items, draft);
  const chooseSlash = () => { if (!suggestions.length || busy) return false; select(suggestions[Math.min(active, suggestions.length - 1)]); return true; };
  const onComposerKey = (e) => {
    if (!suggestions.length || e.nativeEvent?.isComposing || e.isComposing) return false;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chooseSlash(); return true; }
    if (e.key === "Escape") { e.preventDefault(); setDismissed(draft); return true; }
    if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length); return true; }
    return false;
  };
  const writable = !privateMode || !!history?.unlocked;
  const mutate = async (next) => {
    if (!writable) throw new Error("Unlock or create history in Private mode to save prompts.");
    next = validatePrompts(next);
    const owner = scope;
    if (privateMode) await history.replacePrompts(next);
    else writePrompts(localStorage, next);
    if (live.current === owner && (!privateMode || history.unlocked)) setData({ scope, items: next, error: "" });
  };
  const use = (prompt, values, selected) => {
    if (busy) throw new Error("Wait for the current reply to finish.");
    if (prompt.model && !models.some((m) => m.id === prompt.model) && !selected) throw new Error("This saved model is unavailable here. Edit the prompt to choose another model or remove it.");
    const text = fillPrompt(prompt.text, values);
    const filledSystem = prompt.system === undefined ? undefined : fillPrompt(prompt.system, values);
    const ids = selected || (prompt.model ? [prompt.model] : null);
    if (ids) {
      if (!ids.length || ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => !models.some((m) => m.id === id))) throw new Error("Choose available models.");
      if (selected) { setLanes(ids.map((modelId, i) => ({ id: "prompt-" + i, modelId, messages: [] }))); setFocus(0); setFiles([]); }
      else setLanes((ls) => ls.map((l, i) => i === focus ? { ...l, modelId: ids[0] } : l));
    }
    setEditing(null);
    setDraft(text);
    if (filledSystem !== undefined) setSystem(filledSystem);
    setView(null);
    requestAnimationFrame(() => input.current?.focus());
  };
  return { items, error: data.scope === scope ? data.error : "", view: view?.scope === scope ? view : null, setView, scope, open, save, select, suggestions, active, onComposerKey, chooseSlash, writable, mutate, use, privateMode, persistent: history?.persistent, models, busy };
}

export function PromptSlash({ library }) {
  if (!library.suggestions.length) return null;
  return <div className={s.slash} aria-label="Matching saved prompts"><span>Use a prompt · ↑ ↓ choose · Enter fills variables · Esc dismisses</span>{library.suggestions.map((p, i) => <button type="button" key={p.id} data-active={i === library.active || undefined} disabled={library.busy} onClick={() => library.select(p)}>{p.name}</button>)}</div>;
}

function Editor({ prompt, models, onSave, onCancel, writable }) {
  const [value, setValue] = useState(prompt);
  const [tags, setTags] = useState(prompt.tags.join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const patch = (field, text) => setValue((v) => ({ ...v, [field]: text }));
  return <form className={s.body} onSubmit={async (e) => {
    e.preventDefault(); setSaving(true); setError("");
    try { const { model, system, ...rest } = value; await onSave({ ...rest, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), ...(model ? { model } : {}), ...(system ? { system } : {}) }); }
    catch (e) { setError(e.message); setSaving(false); }
  }}>
    <label>Name<input autoFocus value={value.name} maxLength={80} required onChange={(e) => patch("name", e.target.value)} /></label>
    <label>Tags, separated by commas<input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
    <label>Prompt<textarea rows={6} required value={value.text} maxLength={100000} onChange={(e) => patch("text", e.target.value)} /></label>
    <p>Use {'{{name}}'} for a fill-in field. Write {'\\{{name}}'} to keep those braces as literal text.</p>
    <label>System prompt (optional)<textarea rows={3} value={value.system || ""} maxLength={100000} onChange={(e) => patch("system", e.target.value)} /></label>
    <label>Model (optional)<select value={value.model || ""} onChange={(e) => patch("model", e.target.value)}><option value="">Keep the current model</option>{value.model && !models.some((m) => m.id === value.model) && <option value={value.model}>{value.model} · unavailable</option>}{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    {error && <p className="error" role="alert">{error}</p>}
    <div className={s.actions}><button type="submit" disabled={saving || !writable}>Save prompt</button><button type="button" onClick={onCancel} disabled={saving}>Cancel</button></div>
  </form>;
}

function Fill({ prompt, compare, library }) {
  const variables = promptVariables(prompt.text, prompt.system);
  const [values, setValues] = useState({});
  const [selected, setSelected] = useState(() => prompt.model && library.models.some((m) => m.id === prompt.model) ? [prompt.model] : []);
  const [error, setError] = useState("");
  return <form className={s.body} onSubmit={(e) => {
    e.preventDefault();
    try { if (compare && selected.length < 2) throw new Error("Choose two or three models."); library.use(prompt, values, compare ? selected : null); }
    catch (e) { setError(e.message); }
  }}>
    <p>{compare ? "Choose two or three models. This opens a new Compare chat; press Send there to submit the prompt. Each model call is billed separately." : "Fill in the fields, then put the prompt in the composer. Press Send when ready."}</p>
    {variables.map((name, i) => <label key={name}>{name}<textarea autoFocus={i === 0} rows={3} required value={Object.hasOwn(values, name) ? values[name] : ""} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} /></label>)}
    {!variables.length && <pre className={s.preview}>{prompt.text}</pre>}
    {prompt.system !== undefined && <details><summary>Saved system prompt</summary><pre className={s.preview}>{prompt.system}</pre></details>}
    {prompt.model && <p>Saved model: {prompt.model}</p>}
    {compare && <fieldset className={s.models}><legend>Models · {selected.length}/3</legend>{library.models.map((m) => <label key={m.id}><input type="checkbox" checked={selected.includes(m.id)} disabled={library.busy || (!selected.includes(m.id) && selected.length === 3)} onChange={() => setSelected((ids) => ids.includes(m.id) ? ids.filter((id) => id !== m.id) : [...ids, m.id])} /><span>{m.name}<small>Per million tokens: {formatUsd(m.inPrice)} in · {formatUsd(m.outPrice)} out</small></span></label>)}</fieldset>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className={s.actions}><button type="submit" disabled={library.busy}>{compare ? "Open Compare" : "Fill composer"}</button><button type="button" onClick={library.open}>Back</button></div>
  </form>;
}

function Panel({ library }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const file = useRef(null);
  const act = async (fn) => { setWorking(true); setError(""); try { await fn(); } catch (e) { setError(e.message); } finally { setWorking(false); } };
  const update = (prompt) => library.mutate([...library.items.filter((p) => p.id !== prompt.id), prompt]);
  const view = library.view;
  if (view.kind === "edit") return <Editor prompt={view.prompt} models={library.models} writable={library.writable} onCancel={library.open} onSave={async (p) => { await update(p); library.open(); }} />;
  if (view.kind === "use") return <Fill prompt={view.prompt} compare={view.compare} library={library} />;
  return <div className={s.body}>
    <p>{library.privateMode ? "Private prompts share your encrypted history vault. Locking or forgetting history also locks or deletes these prompts." : "Prompts stay in this browser. This library is stored without encryption; Private mode has a separate encrypted library."}</p>
    {!library.writable && <p role="status">Unlock or create history in Private mode to save, edit or import prompts. You can still use the starter prompts.</p>}
    {library.privateMode && library.writable && !library.persistent && <p>Storage lasts until this tab closes in this browser.</p>}
    {(error || library.error) && <p className="error" role="alert">{error || library.error}</p>}
    {note && <p role="status">{note}</p>}
    <label>Search names, tags or text<input type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} /></label>
    <div className={s.actions}>
      <button type="button" disabled={!library.writable || working} onClick={() => library.save()}>Save composer</button>
      <button type="button" disabled={!library.writable || working} onClick={() => file.current?.click()}>Import JSON</button>
      <button type="button" disabled={!library.items.length || working} onClick={() => act(() => {
        const url = URL.createObjectURL(new Blob([exportPrompts(library.items)], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url; a.download = "anyroute-prompts.json"; document.body.append(a);
        try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      })}>Export JSON</button>
    </div>
    <p>Exports contain readable prompt text, tags, model choices and system prompts. Keep the file somewhere safe. Imports add new entries without replacing matching IDs.</p>
    <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => {
      const selected = e.target.files?.[0]; e.target.value = "";
      if (selected) act(async () => {
        if (selected.size > MAX_PROMPT_BYTES) throw new Error("Choose a prompt library JSON file up to 2 MB.");
        const incoming = importPrompts(await selected.text());
        const next = mergePrompts(library.items, incoming);
        await library.mutate(next); setNote(`Added ${next.length - library.items.length} prompts.`);
      });
    }} />
    <ul className={s.results}>{searchPrompts(library.items, query).map((p) => <li key={p.id}>
      <b>{p.name}{p.pinned ? " · Pinned" : ""}</b><small>{p.tags.join(" · ")}</small><p>{p.text.slice(0, 180)}{p.text.length > 180 ? "…" : ""}</p>
      <div className={s.actions}>
        <button type="button" disabled={library.busy || working} onClick={() => library.select(p)}>Use</button>
        <button type="button" disabled={library.busy || working || library.models.length < 2} onClick={() => library.select(p, true)}>Run on…</button>
        <button type="button" disabled={!library.writable || working} aria-pressed={p.pinned} onClick={() => act(() => update({ ...p, pinned: !p.pinned }))}>{p.pinned ? "Unpin" : "Pin"}</button>
        <button type="button" disabled={!library.writable || working} onClick={() => library.setView({ scope: library.scope, kind: "edit", prompt: p })}>Edit</button>
        <button type="button" disabled={!library.writable || working} onClick={() => library.setView({ scope: library.scope, kind: "edit", prompt: { ...p, id: newId(), name: (p.name + " copy").slice(0, 80) } })}>Duplicate</button>
        <button type="button" disabled={!library.writable || working} onClick={() => setDeleting(p.id)}>Delete</button>
      </div>
      {deleting === p.id && <div className={s.actions}><span>Delete this prompt?</span><button type="button" disabled={working} onClick={() => act(async () => { await library.mutate(library.items.filter((v) => v.id !== p.id)); setDeleting(null); })}>Delete prompt</button><button type="button" onClick={() => setDeleting(null)}>Cancel</button></div>}
    </li>)}</ul>
    {!searchPrompts(library.items, query).length && <p>No prompts found.</p>}
  </div>;
}

export default function PromptLibrary({ library }) {
  if (!library.view) return null;
  const title = library.view.kind === "edit" ? "Save a prompt" : library.view.kind === "use" ? library.view.prompt.name : "Prompt library";
  return <Modal title={title} onClose={() => library.setView(null)}><Panel key={library.view.kind + (library.view.prompt?.id || "") + String(library.view.compare)} library={library} /></Modal>;
}
