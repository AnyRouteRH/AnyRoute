'use client';
import { useEffect, useState } from 'react';
import { depositProgressView, readDepositProgress } from '../../lib/deposit-progress.js';
import s from './DepositProgress.module.css';
import { useDepositClock } from '../../lib/use-deposit-clock.js'; // B123

export default function DepositProgress({ apiKey }) {
  const now = useDepositClock(); // B123
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null); setError('');
    if (!apiKey) return;
    let stopped = false, timer;
    const load = async () => {
      clearTimeout(timer);
      try { const next = await readDepositProgress(apiKey); if (!stopped) { setData(next); setError(''); } }
      catch (e) { if (!stopped) setError(e.message || 'Could not read deposit status.'); }
      if (!stopped) timer = setTimeout(load, 5000);
    };
    load(); window.addEventListener('anyroute-deposit-sent', load);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('anyroute-deposit-sent', load); };
  }, [apiKey]);
  if (!apiKey || !error && !data?.deposits?.length) return null;
  // Pending deposits never disappear because a balance changed or the add-funds card closed.
  const pending = data?.deposits?.filter(d => !['final', 'credited'].includes(d.stage)) || [];
  const final = data?.deposits?.filter(d => ['final', 'credited'].includes(d.stage)).slice(0, 3) || [];
  return <section className={s.panel} aria-label="Deposit status">
    <h3>Deposit status</h3>
    {error && <p className="error" role="alert">{error} Deposit status may be out of date; the next refresh will try again.</p>}
    <ul aria-live="polite" aria-atomic="false">{[...pending, ...final].map(d => {
      const view = depositProgressView(d, now);
      return <li key={d.id} data-final={view.final}>
        {view.confirmation && <p><strong>{view.confirmation}</strong></p>}
        {d.tx_url && <a className="inline-link" href={d.tx_url} target="_blank" rel="noopener noreferrer">View transaction ↗</a>}
        {!d.tx_url && <code>{d.tx_hash}</code>}
        {view.worth && <p>{view.worth}</p>}
        <p>{view.status}</p>
        {d.note && <p className="help-text">{d.note}</p>}
        {d.capped && <p className="help-text">The per-deposit limit applies; the excess needs operator review.</p>}
      </li>;
    })}</ul>
  </section>;
}
