'use client';
import { useEffect, useId, useState } from 'react';
import { api } from '../../lib/api.js';
import { alertAmount } from '../../lib/runway.js';
import { Button } from '../UI';
import s from './Runway.module.css';
export default function LowBalanceSetting({ apiKey }) {
  const id = useId();
  const [setting, setSetting] = useState(null), [amount, setAmount] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  useEffect(() => {
    const ac = new AbortController(); setSetting(null); setAmount(''); setError(''); setSaved('');
    if (!apiKey) return () => ac.abort();
    api('/api/v1/account/low-balance', { key: apiKey, signal: ac.signal }).then(value => {
      if (!ac.signal.aborted) { setSetting(value); setAmount(value.low_balance_usd === null ? '' : String(value.low_balance_usd)); }
    }).catch(e => { if (!ac.signal.aborted && e.status !== 403) setError('Balance alert settings could not be read.'); });
    return () => ac.abort();
  }, [apiKey]);
  async function save(event) {
    event.preventDefault(); setError(''); setSaved(''); setBusy(true);
    try { const low_balance_usd = alertAmount(amount); await api('/api/v1/account/low-balance', { key: apiKey, method: 'PATCH', body: { low_balance_usd } }); setSaved(low_balance_usd === null ? 'Balance alert turned off.' : 'Balance alert saved.'); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (!setting && !error) return null;
  return <section className="control-panel" aria-labelledby={id + '-heading'}>
    <h3 id={id + '-heading'}>Balance alert</h3>
    {setting?.enabled ? <form onSubmit={save}>
      <div className={s.fields}><label htmlFor={id}>Tell me when my balance drops below $<input id={id} inputMode="decimal" value={amount} disabled={busy} onChange={e => { setAmount(e.target.value); setSaved(''); }} aria-describedby={id + '-help'}/></label><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save alert'}</Button></div>
      <p className="help-text" id={id + '-help'}>Leave the amount blank to turn it off. Checked every five minutes. You’ll see an inbox alert and a Telegram message if linked. Another alert is possible after your balance rises above this amount.</p>
    </form> : setting && <p className="help-text">Balance alerts are not switched on yet.</p>}
    {error && <p className="error" role="alert">{error}</p>}{saved && <p role="status">{saved}</p>}
  </section>;
}
