import { BREAKER_FIELDS, trippedBy } from '../../lib/agent-breakers';

export function BreakersForm({ values, onChange, busy }) {
  return <fieldset disabled={busy} className="control-panel"><legend>Circuit breakers</legend>
    <p className="help-text">Blank limits are omitted. Reaching a recorded rolling limit refuses the next request through Anyroute and stops the key until you resume it. Resume resets breaker counters; budget caps still include prior spend. In-flight requests may finish.</p>
    <div className="two-fields">{BREAKER_FIELDS.map(([name,label]) => <div className="field" key={name}><label htmlFor={name}>{label}</label><input id={name} type="number" min="0" max={name === 'max_spend_usd_per_minute' ? 1_000_000 : Number.MAX_SAFE_INTEGER} step={name === 'max_spend_usd_per_minute' ? 'any' : 1} value={values[name]} onChange={e => onChange({ ...values,[name]:e.target.value })}/></div>)}</div>
  </fieldset>;
}
export function TrippedBadge({ record, agent }) {
  const name = trippedBy(record, agent);
  return name && <span className="badge dark">Tripped by {name}</span>;
}
