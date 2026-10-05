'use client';
// U102: the one spending limits editor for chat, /agents and the dashboard's API keys. Same fields, words and order:
// caps per request, hour, day and week; ask me first above; stop and resume; then models, lanes and tools where relevant.
import { useEffect, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api';
import { LANES } from '../../lib/agents';
import { GUARD_LIMIT } from '../../lib/agent-guard';
import { LIMIT_CAPS, GUARD_CAPS, LIMIT_WORDS as W, guardForm } from '../../lib/spending-limits';
import RouteDefault from './RouteDefault'; // U101
import StarterSetups from './StarterSetups'; // U103
import st from './SpendingLimits.module.css';

export function LimitField({ id, label, children, help }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{help && <p className="help-text">{help}</p>}</div>;
}
export function LimitGroup({ title, disabled, children }) {
  return <fieldset disabled={disabled} className={st.group}><legend>{title}</legend>{children}</fieldset>;
}
const Field = LimitField;
// Agent Guard's actions section applies only where /api/v1/status reports agent_guard.enabled: true.
export function useAgentGuard() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { const ac = new AbortController(); api('/api/v1/status', { signal: ac.signal }).then(r => { if (!ac.signal.aborted) setEnabled(r.data?.agent_guard?.enabled === true); }).catch(() => {}); return () => ac.abort(); }, []);
  return enabled;
}
const money = (id, value, set) => <input id={id} type="number" min="0" max="1000000" step="any" inputMode="decimal" value={value ?? ''} onChange={e => set(e.target.value)}/>;
const lines = (id, value, set) => <textarea id={id} rows={2} value={value ?? ''} onChange={e => set(e.target.value)}/>;

export function StopResume({ id, stop, disabled }) {
  const [reason, setReason] = useState('');
  return <fieldset disabled={disabled || stop.busy} className={st.group}><legend>{W.stopTitle}</legend>
    <p className={st.state}><span className={'badge' + (stop.stopped ? ' dark' : '')}>{stop.stopped ? 'Stopped' : stop.ready ? 'Running' : 'No saved limits'}</span>{stop.detail}</p>
    {stop.ready && !stop.stopped && stop.reason && <Field id={`${id}-stop-reason`} label="Reason (optional)"><input id={`${id}-stop-reason`} maxLength={160} value={reason} onChange={e => setReason(e.target.value)}/></Field>}
    {stop.stopped ? <Button type="button" className={st.stop} onClick={() => stop.onResume()}>{W.resume}</Button>
      : <Button type="button" secondary className={st.stop} disabled={!stop.ready} onClick={() => stop.onStop(reason)}>{W.stop}</Button>}
    <p className="help-text">{stop.ready ? W.stopHelp : W.stopFirst}</p>
  </fieldset>;
}

// U103: `setups` names the editor (chat, key or agents) for Start from a setup, which fills only the values that editor shows.
export default function SpendingLimits({ id, value, onChange, disabled = false, compact = false, scope = false, guard = false, setups = null, stop, children }) {
  const set = patch => onChange({ ...value, ...patch });
  const g = value.guard, setGuard = patch => set({ guard: { ...g, ...patch } });
  return <div className={st.limits + (compact ? ' ' + st.compact : '')}>
    {setups && <StarterSetups id={id} view={setups} value={value} onChange={onChange} guard={guard} disabled={disabled}/>}
    <fieldset disabled={disabled} className={st.group}><legend>{W.caps}</legend>
      <div className={st.grid}>{LIMIT_CAPS.map(([k, label]) => <Field key={k} id={`${id}-${k}`} label={label}>{money(`${id}-${k}`, value.caps?.[k], v => set({ caps: { ...value.caps, [k]: v } }))}</Field>)}</div>
      <p className="help-text">{W.capsHelp}</p>
    </fieldset>
    <fieldset disabled={disabled} className={st.group}><legend>Ask me first</legend>
      <Field id={`${id}-ask`} label={W.ask} help={W.askHelp}>{money(`${id}-ask`, value.approval, v => set({ approval: v }))}</Field>
    </fieldset>
    {stop && <StopResume id={id} stop={stop} disabled={disabled}/>}
    {scope && <fieldset disabled={disabled} className={st.group}><legend>{W.scope}</legend><p className="help-text">{W.scopeHelp}</p>
      <div className={st.grid}>{[['modelAllow', 'Allowed models'], ['modelDeny', 'Denied models'], ['toolAllow', 'Allowed tools'], ['toolDeny', 'Denied tools']].map(([k, label]) => <Field key={k} id={`${id}-${k}`} label={label}>{lines(`${id}-${k}`, value[k], v => set({ [k]: v }))}</Field>)}</div>
      <label className="check-label"><input type="checkbox" checked={!!value.restrictTools} onChange={e => set({ restrictTools: e.target.checked })}/>Deny all declared tools when the allowed list is blank</label>
      <label className="check-label"><input type="checkbox" checked={!!value.restrictLanes} onChange={e => set({ restrictLanes: e.target.checked })}/>Restrict lanes</label>
      <div className={st.checks}>{LANES.map(lane => <label className="check-label" key={lane}><input type="checkbox" disabled={!value.restrictLanes} checked={value.lanes.includes(lane)} onChange={e => set({ lanes: e.target.checked ? [...value.lanes, lane] : value.lanes.filter(l => l !== lane) })}/>{lane}</label>)}</div>
      <p className="help-text">{W.lanesHelp}</p>
    </fieldset>}
    {scope && <RouteDefault id={id} value={value.routeDefault} onChange={v => set({ routeDefault: v })} restrictLanes={!!value.restrictLanes} lanes={value.lanes} disabled={disabled}/>} {/* U101: next to the lanes */}
    {guard && <fieldset disabled={disabled} className={st.group}><legend>{W.guard}</legend><p className="help-text">{GUARD_LIMIT}</p>
      <label className="check-label"><input type="checkbox" checked={!!g} onChange={e => set({ guard: e.target.checked ? guardForm(null) : null })}/>Use action rules</label>
      {g ? <>
        <div className={st.grid}>{[...GUARD_CAPS, ['approval_above_usd', W.ask]].map(([k, label]) => <Field key={k} id={`${id}-action-${k}`} label={label}>{k === 'max_per_hour' ? <input id={`${id}-action-${k}`} type="number" min="1" max="100000" step="1" inputMode="numeric" value={g[k]} onChange={e => setGuard({ [k]: e.target.value })}/> : money(`${id}-action-${k}`, g[k], v => setGuard({ [k]: v }))}</Field>)}</div>
        <p className="help-text">Optional. Action caps are separate from model spending caps. Cap per day is a rolling 24 hours; every allowed action counts toward actions per hour.</p>
        <div className={st.grid}>{[['allow', 'Allowed actions'], ['deny', 'Denied actions'], ['targetAllow', 'Allowed targets'], ['targetDeny', 'Denied targets']].map(([k, label]) => <Field key={k} id={`${id}-action-${k}`} label={label}>{lines(`${id}-action-${k}`, g[k], v => setGuard({ [k]: v }))}</Field>)}</div>
        <label className="check-label"><input type="checkbox" checked={g.restrictActions} onChange={e => setGuard({ restrictActions: e.target.checked })}/>Deny every action when the allowed list is blank</label>
        <label className="check-label"><input type="checkbox" checked={g.restrictTargets} onChange={e => setGuard({ restrictTargets: e.target.checked })}/>Deny every target when the allowed list is blank</label>
        <p className="help-text">Names match exactly or with a prefix ending in .*; targets match without case. Deny wins. <a href="/docs/#agent-guard">Read the integration and limits</a></p>
      </> : <p className="help-text">Without action rules, Agent Guard denies every action this key checks.</p>}
    </fieldset>}
    {children}
  </div>;
}
