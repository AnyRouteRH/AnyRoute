import { CAPS } from "../../lib/harness.js";
import { MODEL_CAPABILITIES } from "../../lib/model-capabilities.js";
import s from "../ModelCapabilities.module.css";

// Preserve the Harness's existing specialist filters and saved selections alongside the shared tags.
const extra = CAPS.filter(filter => !MODEL_CAPABILITIES.some(tag => tag.key === filter.key));
export default function ModelFilters({ caps, counts, onToggle, className }) {
  return <details className={s.guide} data-dark open={extra.some(filter => caps.includes(filter.key)) || undefined}>
    <summary>More filters</summary>
    <div className={className} role="group" aria-label="More model filters">{extra.map(filter => <button type="button" key={filter.key} aria-pressed={caps.includes(filter.key)} onClick={() => onToggle(filter.key)} disabled={!caps.includes(filter.key) && !counts[filter.key]}>{filter.label}<small>{counts[filter.key] ?? 0}</small></button>)}</div>
  </details>;
}
