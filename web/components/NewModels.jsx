"use client";
// C131: shared arrival badges and rows, using the existing capabilities and picker.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { modelUnavailable } from "../lib/model-availability.js";
import { isNewModel, newModels, newModelRates, NEW_MODELS_FILTER } from "../lib/new-models.js";
import { CapabilityChips } from "./ModelCapabilities";
import s from "./NewModels.module.css";

export function NewModelBadge({ model }) {
  return isNewModel(model) ? <span className={s.badge}>New</span> : null;
}
export function NewModelsFilter({ tags, onToggle }) {
  return <div className={s.filters}><button type="button" aria-pressed={tags.includes(NEW_MODELS_FILTER)} onClick={() => onToggle(NEW_MODELS_FILTER)}>New this week</button></div>;
}
export function NewModelsRow({ models, onChoose, dark = false }) {
  const recent = newModels(models || []);
  if (!recent.length) return null;
  return <section className={s.row} data-dark={dark || undefined} aria-label="New this week">
    <h3>New this week</h3>
    <ul>{recent.map(model => {
      const rates = newModelRates(model);
      const title = model.name || model.id;
      return <li key={model.id}>
        {modelUnavailable(model) ? <strong>{title}</strong> : onChoose ? <button type="button" className={s.pick} onClick={() => onChoose(model.id)}>{title}</button> : <a href={"/harness/?model=" + encodeURIComponent(model.id)}>{title}</a>}
        <CapabilityChips model={model} dark={dark} />
        <p>{rates.input} input · {rates.output} output / 1M tokens</p>
        {modelUnavailable(model) && <small>Temporarily unavailable</small>}
      </li>;
    })}</ul>
  </section>;
}
export default function NewModelsHome() {
  const [models, setModels] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    api("/api/v1/models", { signal: controller.signal }).then(result => setModels(result.data || [])).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!newModels(models).length) return null;
  return <div className="section tight"><div className="container"><NewModelsRow models={models} /><a className="text-button" href="/models/">Browse models →</a></div></div>;
}
