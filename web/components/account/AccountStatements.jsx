'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api.js';
import { downloadJson, statementPath } from '../../lib/statements.js';
import s from './Statements.module.css';
export default function AccountStatements({ apiKey }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0,7));
  const [statement, setStatement] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef(null);
  useEffect(() => { setStatement(null); setError(''); setBusy(false); request.current?.abort(); return () => request.current?.abort(); }, [apiKey, month]);
  async function load(event) {
    event.preventDefault(); request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setStatement(null); setError('');
    try { const result = await api(statementPath(month), { key: apiKey, signal: controller.signal }); if (!controller.signal.aborted) setStatement(result.data); }
    catch (e) { if (!controller.signal.aborted) setError(e.status === 404 ? 'No statement is available for this month. Monthly statements may not be switched on for this router yet.' : e.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const p = statement?.payload;
  return <section className="control-panel"><h2 tabIndex={-1}>Statements</h2><p>Download signed JSON or print a monthly statement to PDF. Monthly statements are not switched on yet by default.</p>
    <form onSubmit={load} className={s.controls}><div className="field"><label htmlFor="statement-month">Month (UTC)</label><input id="statement-month" type="month" required value={month} max={new Date().toISOString().slice(0,7)} onChange={e => setMonth(e.target.value)}/></div><Button type="submit" disabled={busy || !apiKey}>{busy ? 'Loading…' : 'Read statement'}</Button></form>
    {error && <p role="alert" className="error">{error}</p>}
    {p && <><div className={`button-row ${s.controls}`}><Button onClick={() => downloadJson(statement, `statement-${p.month}.json`)}>Download signed JSON</Button><Button secondary onClick={() => window.print()}>Print / Save PDF</Button><a href="/verify/#v-statement">Check the signature</a></div>
      <article className={s.print} data-monthly-statement><h2>AnyRoute · {p.month}{p.so_far ? ' · so far' : ''}</h2><p>{p.scope === 'account' ? 'Account statement' : 'This key only · attributed movements, not the account balance'}</p><p className={s.identifier}>{p.key_hash}</p><p>{p.from} to {p.to_exclusive} (exclusive), UTC</p>
        <dl className={s.totals}>{[['Opening balance','opening_balance'],['Deposits','deposits'],['Refunds','refunds'],['Usage charged','usage'],['Separate fees','fees'],['Other changes','other_changes'],['Closing balance','closing_balance']].map(([label, field]) => <div key={field}><dt>{label}</dt><dd>{p[field]} USDG</dd></div>)}<div><dt>Calls</dt><dd>{p.calls}</dd></div></dl>
        <p>Opening + deposits + refunds − usage − fees + other changes = closing. Difference: {p.reconciliation.difference} USDG.</p>
        {[['Usage by model','usage_by_model'],['Usage by key / agent','usage_by_key_agent'],['Usage by lane','usage_by_lane'],['Ledger movements','movements_by_kind']].map(([label, field]) => <section key={field}><h3>{label}</h3><table className={s.table}><thead><tr><th scope="col">{label}</th><th scope="col">USDG</th></tr></thead><tbody>{p[field].map((r,i) => <tr key={i}><td>{r.label || r.id || 'Not recorded'}{r.label && r.id && <small className={s.identifier}>{r.id}</small>}</td><td>{r.amount}</td></tr>)}</tbody></table>{!p[field].length && <p>No entries.</p>}</section>)}
        <p className={s.identifier}>Signed by receipt key {statement.key_id}. Generated {p.generated_at}. Download JSON to verify the signature.</p>{p.limits.map(line => <p key={line} className="help-text">{line}</p>)}<a href="/keep/">What the router keeps</a>
      </article></>}
  </section>;
}
