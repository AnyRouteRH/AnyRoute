import { MODEL_CAPABILITIES, modelCapabilities } from "../lib/model-capabilities.js";
import s from "./ModelCapabilities.module.css";

export function CapabilityChips({ model, dark = false }) {
  const keys = modelCapabilities(model);
  return <span className={s.chips} data-dark={dark || undefined}>
    {keys.length ? MODEL_CAPABILITIES.filter(tag => keys.includes(tag.key)).map(tag => <span key={tag.key} className={s.chip} title={tag.explanation} aria-label={`${tag.label}: ${tag.explanation}`}>{tag.label}</span>) : <span className={s.chip}>No tags declared</span>}
  </span>;
}

export function CapabilityGuide({ dark = false }) {
  return <details className={s.guide} data-dark={dark || undefined}>
    <summary>What the tags mean</summary>
    <ul>{MODEL_CAPABILITIES.map(tag => <li key={tag.key}><b>{tag.label}.</b> {tag.explanation} {tag.href && <a href={tag.href}>Read more →</a>}</li>)}</ul>
    <p>Tags describe available endpoints. A request’s lane, provider and signed receipt show which path was used.</p>
  </details>;
}
