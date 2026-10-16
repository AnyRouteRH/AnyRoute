'use client';
// H172: reuse the account's loaded agents, UI buttons and Stop presets.
import { useEffect, useId, useState } from 'react';
import { Button } from './UI';
import { STOP_PRESETS, stopHelp } from '../lib/stop-until';
import { bulkAgents, confirmAllStops } from '../lib/agent-stop-all';
import usePageCommand from './commands/usePageCommand'; // J181

export default function AgentStopAll({ agents, request, disabled }) {
  const id = useId();
  const [preset, setPreset] = useState('manual'), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const ac = new AbortController(); setAllowed(false);
    request('/api/v1/key', { signal: ac.signal }).then(({ data }) => {
      if (!ac.signal.aborted) setAllowed(!['read', 'inference'].includes(data.scope));
    }).catch(() => {});
    return () => ac.abort();
  }, [request]);
  const eligible = bulkAgents(agents);
  const run = async action => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await confirmAllStops(action, preset, eligible.length, text => window.confirm(text), request);
      if (result) { setMessage(result.message); window.dispatchEvent(new Event('anyroute:agents-changed')); }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  usePageCommand('stop-all', () => run('stop-all'), allowed && !!eligible.length && !busy && !disabled); // J181
  usePageCommand('resume-all', () => run('resume-all'), allowed && eligible.some(agent => agent.killed) && !busy && !disabled); // J181
  if (!allowed || !eligible.length) return null;
  return <section className="control-panel" aria-labelledby={id + '-title'} style={{ minWidth: 0 }}>
    <h2 id={id + '-title'}>Stop all agents</h2>
    <p className="help-text">Apply to every agent you can manage. Team keys affect their team; management keys affect the account. Agents need a rulebook to use Stop.</p>
    <div className="field"><label htmlFor={id}>Stop duration</label><select id={id} disabled={busy || disabled} value={preset} onChange={e => setPreset(e.target.value)}>{STOP_PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <p className="help-text">Tomorrow means 9:00 in this device’s local time. Already-stopped agents keep their current duration. {stopHelp}</p>
    <div className="button-row"><Button disabled={busy || disabled} onClick={() => run('stop-all')}>Stop all agents</Button><Button secondary disabled={busy || disabled || !eligible.some(agent => agent.killed)} onClick={() => run('resume-all')}>Resume all</Button></div>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
