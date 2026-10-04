'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Button } from '../../components/UI';
import { GUARD_STARTERS, GUARD_LIMIT } from '../../lib/agent-guard';
import s from './starters.module.css';
export default function GuardStarters({ agent, request, onApplied, disabled }) {
  const [enabled, setEnabled] = useState(false), [chosen, setChosen] = useState(GUARD_STARTERS[0].id), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { const ac = new AbortController(); api('/api/v1/status', { signal: ac.signal }).then(r => { if (!ac.signal.aborted) setEnabled(r.data?.agent_guard?.enabled === true); }).catch(() => {}); return () => ac.abort(); }, []);
  if (!enabled) return null;
  const starter = GUARD_STARTERS.find(s => s.id === chosen);
  return <section id="agent-guard" className="control-panel"><h2>Ask before an action</h2><p>{GUARD_LIMIT}</p>
    <div className="field"><label htmlFor="guard-starter">Action rulebook</label><select id="guard-starter" value={chosen} disabled={busy} onChange={e => { setChosen(e.target.value); setMessage(''); }}>{GUARD_STARTERS.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
    <p className="help-text">These starters set action limits. Model spending and declared tools remain unrestricted. UTC windows cover the whole rulebook: 13:30–20:00 covers US market hours during daylight time; from Nov 1 use 14:30–21:00. Review every setting before applying.</p>
    <details className={s.details}><summary>View exact rulebook JSON</summary><pre className={s.json}>{JSON.stringify(starter.policy, null, 2)}</pre></details>
    <p><a className="inline-link" href="/docs/#agent-guard">Read the integration and limits</a></p>
    {agent ? <><p className="help-text">Applying replaces the selected agent’s own rulebook, including model caps, autonomy and alerts. Inherited rules and kill state still apply. Approve or deny requests in Waiting for you below, or in linked Telegram; resume a stopped agent below.</p><Button disabled={busy || disabled} onClick={async () => { setBusy(true); setMessage(''); try { await request(`/api/v1/agents/${encodeURIComponent(agent.key_hash)}/policy`, { method: 'PUT', body: structuredClone(starter.policy) }); setMessage('Action rulebook saved.'); onApplied(); } catch (e) { setMessage(e.message || 'Could not save the rulebook.'); } finally { setBusy(false); } }}>{busy ? 'Applying…' : 'Apply action rulebook'}</Button></> : <p className="help-text">Connect an owner or management key and select an agent to apply these rules.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
