'use client';
// K195: next to the existing low-balance alert in Money.
import { useEffect, useId, useState } from 'react';
import { api } from '../../lib/api.js';
import { readBalancePause, saveBalancePause } from '../../lib/low-balance-pause.js';
import { Button } from '../UI';
import s from './Runway.module.css';
export default function LowBalancePauseSetting({ apiKey }) {
  const id = useId();
  const [setting, setSetting] = useState(null), [enabled, setEnabled] = useState(false), [amount, setAmount] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  useEffect(() => {
    const ac = new AbortController();
    setSetting(null); setEnabled(false); setAmount(''); setError(''); setSaved('');
    if (!apiKey) return () => ac.abort();
    readBalancePause(api, { key: apiKey, signal: ac.signal }).then(value => {
      if (!ac.signal.aborted) { setSetting(value); setEnabled(value.low_balance_usd !== null); setAmount(value.low_balance_usd === null ? '' : String(value.low_balance_usd)); }
    }).catch(e => { if (!ac.signal.aborted && e.status !== 403) setError('Balance pause settings could not be read.'); });
    return () => ac.abort();
  }, [apiKey]);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setSaved('');
    try { await saveBalancePause(api, enabled, amount, { key: apiKey }); setSaved(enabled ? 'Balance pause saved.' : 'Automatic balance pause turned off. Stopped agents stay stopped until you resume.'); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (!setting && !error) return null;
  return <section className="control-panel" aria-labelledby={id + '-title'}>
    <h3 id={id + '-title'}>Pause agents when your balance runs low</h3>
    {setting?.enabled ? <form onSubmit={save}>
      <label><input type="checkbox" checked={enabled} disabled={busy} onChange={e => { setEnabled(e.target.checked); setSaved(''); }}/> Pause agents automatically</label>
      <div className={s.fields}><label htmlFor={id}>Pause my agents when my balance falls below $<input id={id} inputMode="decimal" value={amount} disabled={busy || !enabled} onChange={e => { setAmount(e.target.value); setSaved(''); }} aria-describedby={id + '-help'}/></label><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save balance pause'}</Button></div>
      <p className="help-text" id={id + '-help'}>Off unless you choose it. Checks settled balance every minute, including the first check after saving. Agents stay stopped until you resume. A top-up above the amount re-arms the check. Resuming while below it will not trigger another pause until then. Notices follow your notification settings.</p>
      <a className="inline-link" href="/dashboard/#notifications">Choose notifications</a>
    </form> : setting && <p className="help-text">Balance pauses are not switched on yet.</p>}
    <p className="help-text">Requests already running may finish. Calls outside Anyroute are unaffected. <a className="inline-link" href="/agents/?command=resume-all">Resume all</a></p>
    {error && <p className="error" role="alert">{error}</p>}{saved && <p role="status">{saved}</p>}
  </section>;
}
