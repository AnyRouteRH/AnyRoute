'use client';
import { useRef, useState } from 'react';
import { Button } from '../../components/UI';
import styles from './rush.module.css';

export default function RushAdmin() {
  const [token, setToken] = useState('');
  const [days, setDays] = useState('30');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(null);
  async function load(event) {
    event.preventDefault(); setError(''); setData(null); setBusy(true);
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    try {
      const input = encodeURIComponent(JSON.stringify({ days: Number(days) }));
      const response = await fetch(`/trpc/rush?input=${input}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Service operator token required.' : 'Operations could not be read.');
      const body = await response.json();
      if (active.current === controller) setData(body.result.data);
    } catch (e) { if (active.current === controller && e.name !== 'AbortError') setError(e.message); }
    finally { if (active.current === controller) setBusy(false); }
  }
  function clear() { active.current?.abort(); active.current = null; setToken(''); setData(null); setError(''); setBusy(false); }
  return <section className={styles.panel} aria-label="Service operations">
    <form onSubmit={load} className={styles.form}>
      <label>Service operator token<input type="password" required value={token} onChange={e => { clear(); setToken(e.target.value); }} autoComplete="off" spellCheck={false} /></label>
      <label>UTC days<select value={days} onChange={e => { setDays(e.target.value); setData(null); }}>{[7, 30, 90].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <Button disabled={busy || !token} type="submit">{busy ? 'Reading…' : 'Read operations'}</Button>
      <Button secondary type="button" onClick={clear}>Clear</Button>
    </form>
    <p className={styles.note}>The token stays in this page’s memory and is sent only to this service’s operator API. Account keys cannot access these counts.</p>
    <p role="status" aria-live="polite">{error || (busy ? 'Reading operations…' : '')}</p>
    {data && <>
      <h2>Upstream balances</h2>
      {!data.upstream.enabled ? <p>Upstream monitoring is not switched on yet.</p> : <>
        <p className={styles.note}>Warn below ${data.upstream.warn_usd}; critical below ${data.upstream.critical_usd}. Unsupported means no balance API is connected. Unknown means a recent balance could not be read.</p>
        <div className={styles.scroll} tabIndex={0} role="region" aria-label="Upstream balances"><table><thead><tr><th scope="col">Provider</th><th scope="col">USD remaining</th><th scope="col">State</th><th scope="col">Last check</th><th scope="col">Unavailable until</th></tr></thead><tbody>{data.upstream.providers.map(p => <tr key={p.provider}><th scope="row">{p.provider}</th><td>{p.balance_usd == null ? 'Unknown' : p.balance_usd.toFixed(2)}</td><td>{p.status}</td><td>{p.checked_at || 'Not checked'}</td><td>{p.unavailable_until || 'No hold'}</td></tr>)}</tbody></table></div>
      </>}
      <h2>Daily account counts</h2>
      <p className={styles.note}>Counts cover first milestones in retained records, once per account. New wallet sign-ins count accounts created with a management key in the same transaction; accounts created earlier by a deposit are excluded. Deposits count the first positive credit. Calls count the first signed generation that was not cancelled and did not finish with an error. These daily totals do not describe a single cohort or a conversion rate.</p>
      <div className={styles.scroll} tabIndex={0} role="region" aria-label="Daily account counts"><table><thead><tr><th scope="col">UTC day</th><th scope="col">New wallet sign-ins</th><th scope="col">First deposit credited</th><th scope="col">First successful call</th></tr></thead><tbody>{data.funnel.map(d => <tr key={d.day}><th scope="row">{d.day}</th><td>{d.wallet_sign_ins}</td><td>{d.first_deposits}</td><td>{d.first_calls}</td></tr>)}</tbody></table></div>
      <p className={styles.note}>Catalogue caching: {data.catalog_cache_enabled ? 'on · 30 seconds per process' : 'not switched on yet'}.</p>
    </>}
  </section>;
}
