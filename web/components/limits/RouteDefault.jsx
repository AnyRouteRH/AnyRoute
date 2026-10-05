// U101: the rulebook's default route for requests that name no lane, shown next to the lanes wherever the spending
// limits editor shows them (/agents and API keys). The lane allowlist above it is stricter, and the editor says so.
import { ROUTE_DEFAULT_OPTIONS, ROUTE_DEFAULT_FIRST_NOTE, routeDefaultConflict } from '../../lib/route-default';
import st from './SpendingLimits.module.css';

export default function RouteDefault({ id, value, onChange, restrictLanes, lanes, disabled }) {
  const current = value ?? 'standard';
  const conflict = routeDefaultConflict(current, restrictLanes, lanes ?? []);
  return <fieldset disabled={disabled} className={st.group}><legend>Default route</legend>
    <p className="help-text">Used for chat, completions, embeddings, rerank and document questions that name no lane. A lane the request names always wins, and the lanes above still apply.</p>
    {ROUTE_DEFAULT_OPTIONS.map(o => <label className="check-label" key={o.value}><input type="radio" name={`${id}-route-default`} value={o.value} checked={current === o.value} onChange={() => onChange(o.value)}/><span><strong>{o.label}</strong>{o.value === 'standard' ? ' (default)' : ''}. {o.help}</span></label>)}
    <p className="help-text">{ROUTE_DEFAULT_FIRST_NOTE}</p>
    {conflict && <p className="help-text" role="status">{conflict}</p>}
  </fieldset>;
}
