"use client";
// G165: one tab-scoped selection shared by cards, model pages and the tray.
import { useEffect, useSyncExternalStore } from "react";
import { COMPARE_LIMIT, compareHref, readComparePicks, toggleCompareId, writeComparePicks } from "../lib/model-compare.js";
import { Button } from "./UI";
import s from "./ModelCompare.module.css";

const empty = [], listeners = new Set();
let picks = empty, loaded = false;
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
function update(ids) {
  picks = ids;
  try { writeComparePicks(window.sessionStorage, ids); } catch { /* Keep page memory when storage is blocked. */ }
  listeners.forEach(listener => listener());
}
function usePicks() {
  const ids = useSyncExternalStore(subscribe, () => picks, () => empty);
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    try { update(readComparePicks(window.sessionStorage)); } catch { /* Empty until a model is picked. */ }
  }, []);
  return ids;
}
export function ModelCompareButton({ model }) {
  const ids = usePicks(), picked = ids.includes(model.id), full = ids.length >= COMPARE_LIMIT;
  return <button type="button" className="text-button" aria-pressed={picked} aria-label={`${picked ? "Remove" : "Compare"} ${model.name || model.id}${!picked && full ? ": three models already picked" : ""}`} disabled={!picked && full} onClick={() => update(toggleCompareId(ids, model.id))}>{picked ? "Remove from comparison" : "Compare"}</button>;
}
export function ModelCompareTray({ models = [] }) {
  const ids = usePicks();
  if (!ids.length) return null;
  return <aside className={s.tray} aria-label="Models to compare">
    <p role="status">{ids.length} of 3 picked. {ids.length === 1 ? "Pick one more model to compare." : "Ready to compare."}</p>
    <ul className={s.picks}>{ids.map(id => <li key={id}><span>{models.find(model => model.id === id)?.name || id}</span><button type="button" className="text-button" aria-label={`Remove ${id}`} onClick={() => update(toggleCompareId(ids, id))}>Remove</button></li>)}</ul>
    <div className="button-row">{ids.length >= 2 ? <Button href={compareHref(ids)}>Compare models</Button> : <Button secondary href="/models/">Pick another model</Button>}<button type="button" className="text-button" onClick={() => update([])}>Clear picks</button></div>
  </aside>;
}
