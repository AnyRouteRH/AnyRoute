'use client';
// D141: one independent setting on each agent row, outside its selection button.
import { useEffect, useId, useRef, useState } from 'react';
import { QUIET_OPTIONS, quietAlertPath, quietChoice, quietSetting } from '../lib/quiet-agent-alerts';
import s from './QuietAgentAlert.module.css';

export default function QuietAgentAlert({ agent, request }) {
  const id = useId(), active = useRef(null);
  const [state, setState] = useState({ ready: false, hours: null, busy: false, message: '', off: false });
  useEffect(() => {
    const ac = new AbortController(); active.current = ac;
    request(quietAlertPath(agent.key_hash), { signal: ac.signal }).then(response => {
      const hours = quietSetting(response);
      if (!ac.signal.aborted) setState({ ready: true, hours, busy: false, message: '', off: false });
    }).catch(error => {
      if (!ac.signal.aborted) setState({ ready: false, hours: null, busy: false, message: 'Quiet alert settings could not be read.', off: error.status === 404 });
    });
    return () => ac.abort();
  }, [agent.key_hash, request]);
  async function save(value) {
    const ac = active.current;
    setState(old => ({ ...old, busy: true, message: '' }));
    try {
      const response = await request(quietAlertPath(agent.key_hash), { method: 'PUT', body: { hours: quietChoice(value) }, signal: ac.signal });
      const hours = quietSetting(response);
      if (!ac.signal.aborted) setState({ ready: true, hours, busy: false, message: 'Saved.', off: false });
    } catch {
      if (!ac.signal.aborted) setState(old => ({ ...old, busy: false, message: 'The quiet alert could not be saved. Try again.' }));
    }
  }
  if (state.off || (!state.ready && !state.message)) return null;
  return <div className={s.setting}>
    <label htmlFor={id}>Alert me if this agent makes no calls for</label>
    <select id={id} aria-label={`Quiet alert for ${agent.name || 'Unnamed agent'}`} value={state.hours ?? 'off'} disabled={!state.ready || state.busy} onChange={event => save(event.target.value)}>
      {QUIET_OPTIONS.map(hours => <option key={hours ?? 'off'} value={hours ?? 'off'}>{hours === null ? 'Off' : `${hours} ${hours === 1 ? 'hour' : 'hours'}`}</option>)}
    </select>
    {agent.killed && <p className="help-text">Alerts pause while this agent is stopped.</p>}
    {state.message && <p className="help-text" role="status">{state.message}</p>}
  </div>;
}
