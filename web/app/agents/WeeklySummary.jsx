'use client';
import { useEffect, useState } from 'react';
import { readWeeklySummaryPreference, setWeeklySummaryPreference } from '../../lib/weekly-summary';

export default function WeeklySummary({ request }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [controller, setController] = useState(null);
  useEffect(() => {
    const abort = new AbortController();
    setController(abort); setState(null); setError(''); setBusy(false);
    readWeeklySummaryPreference(request, { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) setState(data);
    }).catch(e => { if (!abort.signal.aborted && e.status !== 404) setError(e.message); });
    return () => abort.abort();
  }, [request]);
  const toggle = async optedIn => {
    setBusy(true); setError('');
    try {
      const data = await setWeeklySummaryPreference(request, optedIn, { signal: controller.signal });
      if (!controller.signal.aborted) setState(data);
    } catch (e) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  if (!state && !error) return null;
  return <div>
    {state && <><label className="check-label"><input type="checkbox" checked={state.opted_in} disabled={busy} onChange={e => toggle(e.target.checked)} /> Weekly summary on Mondays</label>
      <p className="help-text">Get last week’s agent spend, approvals and Stops from 09:00 UTC. Quiet weeks are skipped. Telegram can read the summary and agent names. One summary per account, within this link’s access.</p>
      <p className="help-text" role="status">{busy ? 'Saving weekly summary…' : state.opted_in ? 'Weekly summary is on.' : 'Weekly summary is off.'}</p></>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
