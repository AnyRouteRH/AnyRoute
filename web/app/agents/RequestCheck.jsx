'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/UI';
import { LANES, LIMITS, decisionText, reasonText } from '../../lib/agents';
import { checkSelectedRequest } from '../../lib/agent-request-check';
import s from './starters.module.css';

export default function RequestCheck({ agent, refreshVersion }) {
  const [form, setForm] = useState({ model: '', lane: 'public', cost: '0.01', tokens: '512', tools: '' });
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(null);
  // Invalidate in-flight decisions when inputs or the saved rulebook change.
  const invalidate = () => { pending.current?.abort(); pending.current = null; setBusy(false); setResult(null); setError(''); };
  useEffect(() => { invalidate(); return () => pending.current?.abort(); }, [refreshVersion]);
  const set = (name, value) => { invalidate(); setForm(old => ({ ...old, [name]: value })); };
  return <section className="control-panel">
    <h2>Try a request</h2>
    <p className="help-text">Check {agent.name || 'this agent'} against its current and inherited rules. No spending, no prompt and nothing sent to a model. This checks rules only: it does not reserve budget, verify model or lane availability, or guarantee a later request.</p>
    <form onSubmit={async event => {
      event.preventDefault(); invalidate(); const controller = new AbortController(); pending.current = controller; setBusy(true);
      try { const decision = await checkSelectedRequest(agent.key_hash, secret, form, undefined, controller.signal); if (!controller.signal.aborted) setResult(decision); }
      catch (failure) { if (!controller.signal.aborted) setError(failure.message || 'The request could not be checked.'); }
      finally { if (!controller.signal.aborted) { pending.current = null; setBusy(false); } }
    }}>
      <fieldset className={s.fieldset} disabled={busy}><legend>Request details</legend>
        <div className="field"><label htmlFor="starter-agent-key">Selected agent’s API key</label><input id="starter-agent-key" type="password" autoComplete="off" spellCheck={false} required value={secret} onChange={event => { invalidate(); setSecret(event.target.value); }}/><p className="help-text">Kept in memory on this page. The connected management key is never used as a substitute.</p></div>
        <div className="field"><label htmlFor="starter-model">Model identifier</label><input id="starter-model" required maxLength={160} value={form.model} onChange={event => set('model', event.target.value)}/></div>
        <div className="two-fields"><div className="field"><label htmlFor="starter-lane">Lane</label><select id="starter-lane" value={form.lane} onChange={event => set('lane', event.target.value)}>{LANES.map(lane => <option key={lane}>{lane}</option>)}</select></div><div className="field"><label htmlFor="starter-cost">Estimated cost (USD)</label><input id="starter-cost" type="number" required min="0" max={LIMITS.usd} step="any" value={form.cost} onChange={event => set('cost', event.target.value)}/></div></div>
        <div className="field"><label htmlFor="starter-tokens">Maximum output tokens</label><input id="starter-tokens" type="number" min="1" max={LIMITS.tokens} step="1" value={form.tokens} onChange={event => set('tokens', event.target.value)}/></div>
        <div className="field"><label htmlFor="starter-tools">Declared tools (one per line or comma)</label><textarea id="starter-tools" rows={2} value={form.tools} onChange={event => set('tools', event.target.value)}/></div>
      </fieldset>
      {error && <p role="alert">{error}</p>}<Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Check request'}</Button>
    </form>
    {result && <div className={s.result} role="status"><strong>{decisionText(result.decision)}</strong>{result.reasons.length ? <ul>{result.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul> : <p>No rule in the current rulebooks blocks this estimate.</p>}</div>}
  </section>;
}
