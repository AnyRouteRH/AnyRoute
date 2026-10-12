'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { savingsPath } from '../../lib/savings.js';
import SavingsResults from './SavingsResults.js';
import s from './Savings.module.css';
export default function AccountSavings({ apiKey }) {
  const [report, setReport] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError(''); setBusy(true);
    api(savingsPath, { key: apiKey, signal: controller.signal }).then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(e => { if (!controller.signal.aborted) setError(e.status === 404 ? 'Savings finder is not available on this router yet.' : 'Could not read ways to save. Try again.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [apiKey, revision]);
  return <section className={'control-panel ' + s.savings} aria-labelledby="savings-title">
    <div className="panel-heading"><h2 id="savings-title">Ways to save</h2><button type="button" className="text-button" disabled={busy} onClick={() => setRevision(n => n + 1)}>Refresh ways to save</button></div>
    <p>Find a similar model for less using your last 30 days of charged calls. Each comparison is an estimate at current catalogue prices, with no claim of equal quality.</p>
    {busy && <p role="status">Finding ways to save…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {report && <SavingsResults report={report}/>}
  </section>;
}
