'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api.js';
import { currentMonth, evidenceHref, laneLabel, laneReportPath, laneReportRangeError, laneSegments, monthRange, percent, PROOF_TIME_HREF, provenSentence, readLaneReport } from '../../lib/lane-report.js';
import s from './LaneReport.module.css';

function Bar({ title, segments }) {
  return <div className={s.barRow}><span className={s.barTitle}>{title}</span>
    <div className={s.bar} role="img" aria-label={`${title} by lane: ${segments.map(item => item.text).join(', ') || 'none'}`}>
      {segments.map(item => <span key={item.tone} className={s.segment} data-lane={item.tone} style={{ flexGrow: item.share }} title={item.text}/>)}
    </div></div>;
}

// Lane report: shown once the router answers. The route follows statements (404 while they are off) and inference-only
// keys are refused (403); in both cases nothing is shown.
export default function AccountLaneReport({ apiKey }) {
  const [month, setMonth] = useState(() => currentMonth()), [range, setRange] = useState(() => monthRange(currentMonth()));
  const [report, setReport] = useState(null), [shown, setShown] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(null);
  async function load(next) {
    const problem = laneReportRangeError(next);
    if (problem) { setError(problem); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const result = readLaneReport(await api(laneReportPath(next), { key: apiKey, signal: controller.signal }));
      if (!controller.signal.aborted) { setReport(result); setShown(true); }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (!shown && (e.status === 404 || e.status === 403)) return;
      setShown(true); setError(e.status === 429 ? 'Too many lane reports from this key. Try again within a minute.' : e.message);
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => { load(monthRange(currentMonth())); return () => request.current?.abort(); }, [apiKey]);
  if (!shown) return null;
  const pickMonth = value => { setMonth(value); if (value) setRange(monthRange(value)); };
  const r = report;
  return <section className="control-panel" aria-labelledby="lane-report-title"><h2 id="lane-report-title" tabIndex={-1}>Where your calls ran</h2>
    <p>{r?.scope === 'key' ? "This key's own calls" : "Your account's calls"} by lane, read from the lane each call's signed receipt records. The attested and unlinkable lanes run only on proven hardware: endpoints whose hardware attestation the router verified.</p>
    <form className={s.controls} onSubmit={e => { e.preventDefault(); load(range); }}>
      <div className="field"><label htmlFor="lane-report-month">Month (UTC)</label><input id="lane-report-month" type="month" value={month} max={currentMonth()} onChange={e => pickMonth(e.target.value)}/></div>
      <div className="field"><label htmlFor="lane-report-from">From</label><input id="lane-report-from" type="date" required value={range.from} max={range.to} onChange={e => setRange(v => ({ ...v, from: e.target.value }))}/></div>
      <div className="field"><label htmlFor="lane-report-to">To (included)</label><input id="lane-report-to" type="date" required value={range.to} min={range.from} onChange={e => setRange(v => ({ ...v, to: e.target.value }))}/></div>
      <Button type="submit" disabled={busy || !apiKey}>{busy ? 'Loading…' : 'Show'}</Button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {r && <div className={s.report} aria-live="polite">
      <p className={s.range}>{r.range.from} to {r.range.to} (UTC){r.range.so_far ? ', so far' : ''} · {r.totals.calls.toLocaleString('en-US')} calls · {r.totals.spend} USDG</p>
      <p className={s.headline}>{provenSentence(r)}</p>
      {r.totals.calls > 0 && <><Bar title="Calls" segments={laneSegments(r, 'calls')}/><Bar title="Spend" segments={laneSegments(r, 'spend')}/></>}
      <ul className={s.legend}>{r.lanes.filter(row => row.calls > 0 || row.lane !== null).map(row => <li key={row.lane ?? 'none'}>
        <span className={s.swatch} data-lane={row.lane ?? 'none'} aria-hidden="true"/><strong>{laneLabel(row.lane)}</strong>{row.proven && <span className={s.proven}>proven hardware</span>}
        <span className={s.figures}>{row.calls.toLocaleString('en-US')} calls · {percent(row.share_of_calls)} · {row.spend} USDG</span></li>)}</ul>
      <h3>Proven hardware by provider</h3>
      {r.providers.length ? <table className={s.table}><thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Lane</th><th scope="col">Calls</th><th scope="col">USDG</th><th scope="col">Evidence</th></tr></thead>
        <tbody>{r.providers.map(row => <tr key={`${row.lane} ${row.provider} ${row.model}`}>
          <td data-label="Provider">{row.provider}</td><td data-label="Model">{row.model}</td><td data-label="Lane">{laneLabel(row.lane)}</td>
          <td data-label="Calls">{row.calls.toLocaleString('en-US')}</td><td data-label="USDG">{row.spend}</td>
          <td data-label="Evidence"><a href={evidenceHref(row.provider)}>Hardware evidence</a></td></tr>)}</tbody></table>
        : <p>No calls ran on the attested or unlinkable lanes in this range.</p>}
      <p className="help-text">Hardware evidence opens the provider&apos;s attestation record on Verify, with its history. <a href={PROOF_TIME_HREF}>Proof-time</a> shows how recently each provider&apos;s hardware was verified. Whether a lane came from your default route, and requests refused because no endpoint on a lane could take them, are not recorded per call, so they are not counted here. The proof pack below includes this report for its calls and checks it offline.</p>
    </div>}
  </section>;
}
