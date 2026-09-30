'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/UI';
import { formatUsd, utcTime } from '../../lib/agents';
import { downloadLedgerPage, ledgerBounds, ledgerPage, ledgerPath } from '../../lib/agent-ledger';
import s from './activity.module.css';
export default function Activity({ agent, request, refreshVersion }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [bounds, setBounds] = useState({});
  const [page, setPage] = useState(null);
  const [cursor, setCursor] = useState('');
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const load = useCallback(async signal => {
    setBusy(true); setError(''); setPage(null);
    try { const value = ledgerPage(await request(ledgerPath(agent.key_hash, { ...bounds, cursor }), { signal })); if (!signal.aborted) setPage(value); }
    catch (e) { if (!signal.aborted) setError(e.message); }
    finally { if (!signal.aborted) setBusy(false); }
  }, [agent.key_hash, bounds, cursor, request]);
  useEffect(() => { const ac = new AbortController(); load(ac.signal); return () => ac.abort(); }, [load, refreshVersion]);
  const download = async format => {
    setDownloading(true); setError('');
    try {
      const file = await downloadLedgerPage(request, agent.key_hash, bounds, cursor, format);
      const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
      const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e.message); } finally { setDownloading(false); }
  };
  return <section className="control-panel"><h2>Activity &amp; receipts</h2>
    <p className="help-text">Requests evaluated by a rulebook or recorded as generations through AnyRoute. New records group the request’s policy checks and receipts. Earlier records without correlation stay separate and are marked unlinked. Errors before evaluation or generation creation are absent. The router reads request text in memory; this ledger contains no prompt or answer text.</p>
    <form onSubmit={e => { e.preventDefault(); if (from && to && from >= to) { setError('From must be before To.'); return; } setCursor(''); setHistory([]); setBounds(ledgerBounds(from, to)); }}><div className="two-fields"><div className="field"><label htmlFor="activity-from">From (UTC, inclusive)</label><input id="activity-from" type="date" value={from} onChange={e => setFrom(e.target.value)}/></div><div className="field"><label htmlFor="activity-to">To (UTC, exclusive)</label><input id="activity-to" type="date" value={to} onChange={e => setTo(e.target.value)}/></div></div><Button type="submit" disabled={busy}>Apply dates</Button></form>
    <div className="button-row"><Button secondary disabled={!page || downloading || busy} onClick={() => download('json')}>Download JSON page</Button><Button secondary disabled={!page || downloading || busy} onClick={() => download('csv')}>Download CSV page</Button></div>
    <p className="help-text">Newest first, up to 100 requests per page. Downloads contain this page. Daily totals cover the full selected range, in UTC. Policy events and their correlations are retained for 90 days while the retention worker runs. A verify link opens the existing receipt view and checker; it does not itself establish signature validity.</p>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Reading activity…</p>}
    {page && <><div className={s.scroll}><table className={s.table}><caption>Agent requests</caption><thead><tr>{['Time (UTC)', 'Decision', 'Model / lane', 'Tokens in / out', 'Charged USD', 'Receipt', 'Approval', 'Policy SHA-256'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{page.rows.map(row => <tr key={row.id}><td>{utcTime(row.time)}{row.unlinked && <small>Unlinked record</small>}</td><td>{row.decision}</td><td>{row.model || 'None'}<small>{row.lane || 'Not recorded'}</small></td><td>{row.tokens_in} / {row.tokens_out}</td><td>{formatUsd(row.cost_usd)}</td><td>{row.receipts.length ? row.receipts.map(r => r.receipt_id ? <a className="inline-link" key={r.generation_id} href={r.verify_url}>{r.receipt_id}</a> : <span key={r.generation_id}>No signed receipt</span>) : 'No receipt'}</td><td>{row.approval_id || 'None'}</td><td>{row.policy_sha256s.join('\n') || 'Not recorded'}</td></tr>)}</tbody></table></div>{!page.rows.length && <p>No activity recorded in this range.</p>}
      <div className="button-row"><Button secondary disabled={!history.length || busy} onClick={() => { setCursor(history.at(-1)); setHistory(old => old.slice(0,-1)); }}>Newer page</Button><Button secondary disabled={!page.next || busy} onClick={() => { setHistory(old => [...old,cursor]); setCursor(page.next); }}>Older page</Button></div>
      <div className={s.scroll}><table className={s.table}><caption>Daily totals (UTC)</caption><thead><tr>{['Day','Requests','Tokens in / out','Charged USD'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{page.totals.map(day => <tr key={day.day}><td>{day.day}</td><td>{day.requests}</td><td>{day.tokens_in} / {day.tokens_out}</td><td>{formatUsd(day.cost_usd)}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
