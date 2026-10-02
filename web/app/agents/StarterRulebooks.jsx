'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/UI';
import { STARTER_RULEBOOKS, applyStarter, starterSettings } from '../../lib/agent-starters';
import s from './starters.module.css';

export default function StarterRulebooks({ agent, request, onApplied, disabled = false }) {
  const [chosen, setChosen] = useState(STARTER_RULEBOOKS[0].id);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const template = STARTER_RULEBOOKS.find(item => item.id === chosen);
  return <section id="rulebook-templates" className="control-panel">
    <h2>Start from a rulebook template</h2>
    <p className="help-text">Choose a starting point and review every setting before applying it. Model choices do not guarantee availability or speed; caps limit spending. All starters deny declared tools. Rules only cover requests through AnyRoute.</p>
    <div className="field"><label htmlFor="starter-choice">Starter rulebook</label><select id="starter-choice" value={chosen} disabled={busy} onChange={event => { setChosen(event.target.value); setMessage(''); }}>{STARTER_RULEBOOKS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    <p>{template.description}</p>
    <dl className={s.settings}>{starterSettings(template.policy).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <details className={s.details}><summary>View exact rulebook JSON</summary><pre className={s.json}>{JSON.stringify(template.policy, null, 2)}</pre></details>
    {agent && request ? <><p className="help-text">Apply to {agent.name || 'selected agent'} ({agent.key_hash}). This replaces its own rulebook, including autonomy, alerts and agreement settings. Inherited rules and its stopped state still apply. You can edit the saved rulebook below.</p><Button disabled={busy || disabled} onClick={async () => {
      setBusy(true); setMessage('');
      try { await applyStarter(request, agent.key_hash, template); if (alive.current) { setMessage('Rulebook saved. You can edit it below.'); onApplied(); } }
      catch (error) { if (alive.current) setMessage(error.message || 'The rulebook could not be saved.'); }
      finally { if (alive.current) setBusy(false); }
    }}>{busy ? 'Applying…' : 'Apply rulebook'}</Button></> : <p className="help-text">Connect a management or owner/admin key, then select an agent to apply a rulebook.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
