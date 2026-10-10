'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { reliabilityPath } from '../../lib/reliability.js';
import ReliabilityResults from './ReliabilityResults.js';
import s from './Reliability.module.css';
export default function AccountReliability({ apiKey }) {
  const [report, setReport] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError(''); setBusy(true);
    api(reliabilityPath, { key: apiKey, signal: controller.signal }).then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(e => { if (!controller.signal.aborted) setError(e.status === 404 ? 'Reliability reports are not available on this router yet.' : 'Could not read your reliability report. Try again.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [apiKey, revision]);
  return <section id="account-reliability" className={'control-panel ' + s.report} aria-labelledby="reliability-title">
    <div className="panel-heading"><h2 id="reliability-title">Reliability</h2><button type="button" className="text-button" disabled={busy} onClick={() => setRevision(n => n + 1)}>Refresh reliability</button></div>
    <p>See how your calls went over the last seven days, by model.</p>
    {busy && <p role="status">Reading reliability…</p>}{error && <p role="alert" className="error">{error}</p>}
    {report && <ReliabilityResults report={report}/>}
  </section>;
}
