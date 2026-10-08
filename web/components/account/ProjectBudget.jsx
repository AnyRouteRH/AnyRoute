'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import s from './ProjectBudget.module.css';
// D139: account shell controls; budgets always cover the current UTC month.
export default function ProjectBudget({ apiKey, project = '' }) {
  const id = useId(), [name, setName] = useState(project), [projects, setProjects] = useState([]);
  const [record, setRecord] = useState(null), [amount, setAmount] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const current = useRef(null);
  const valid = /^[a-zA-Z0-9._-]{1,48}$/.test(name);
  useEffect(() => { setName(project); }, [project]);
  useEffect(() => { setStatus(''); }, [apiKey, name]);
  useEffect(() => {
    const controller = new AbortController(); setProjects([]);
    api('/api/v1/projects', { key: apiKey, signal: controller.signal }).then(value => { if (!controller.signal.aborted) setProjects(value.data); }).catch(() => {});
    return () => controller.abort();
  }, [apiKey, revision]);
  useEffect(() => {
    const controller = new AbortController(); current.current = controller; setRecord(null); setAmount(''); setError(''); setBusy(false);
    if (valid) {
      setBusy(true);
      api('/api/v1/projects/' + encodeURIComponent(name) + '/budget', { key: apiKey, signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setRecord(value.data); setAmount(value.data.budget_usd ?? ''); } }).catch(e => { if (!controller.signal.aborted) setError(e.status === 403 ? 'Connect an account management key to manage project budgets.' : e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }
    return () => controller.abort();
  }, [apiKey, name, valid, revision]);
  async function change(method) {
    const controller = current.current; if (!controller || controller.signal.aborted) return;
    setBusy(true); setError(''); setStatus('');
    try {
      await api('/api/v1/projects/' + encodeURIComponent(name) + '/budget', { key: apiKey, method, signal: controller.signal, ...(method === 'PUT' ? { body: { budget_usd: Number(amount) } } : {}) });
      if (!controller.signal.aborted) { setRevision(value => value + 1); setStatus(method === 'PUT' ? 'Budget saved.' : 'Budget removed.'); }
    } catch (e) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className={'control-panel ' + s.panel} aria-label="Project budget">
    <h3>Project budget</h3><p>Set a monthly limit for calls tagged with a project. The month starts at midnight UTC on its first day. Untagged calls keep their usual limits.</p>
    <label>Project<input list={id} maxLength={48} pattern="[a-zA-Z0-9._-]{1,48}" value={name} onChange={e => setName(e.target.value.toLowerCase())}/></label>
    <datalist id={id}>{projects.map(row => <option key={row.name} value={row.name}/>)}</datalist>
    {record && <><p>{record.name} · {record.month} UTC: ${record.spent_usd} charged{record.budget_usd !== null ? ' of $' + record.budget_usd : ' · No monthly budget'}. ${record.held_usd} reserved for pending calls.</p>
      <form onSubmit={e => { e.preventDefault(); change('PUT'); }}><label>Monthly budget in USD<input type="number" min="0" max="1000000" step="any" required value={amount} onChange={e => setAmount(e.target.value)}/></label><div className="button-row"><button className="button secondary" type="submit" disabled={busy}>Save budget</button><button className="text-button" type="button" disabled={busy || record.budget_usd === null} onClick={() => change('DELETE')}>Remove budget</button></div></form>
      <p className="help-text">Pending calls count toward the limit using their estimated maximum cost. A refused call costs nothing. Refunds do not restore the monthly allowance. At 80%, your inbox gets one notice per project each month; Telegram delivery depends on the service settings.</p></>}
    {!valid && <p className="help-text">Choose a project using letters, numbers, dots, underscores or hyphens.</p>}
    {busy && <p role="status">Reading or saving budget…</p>}{status && <p role="status">{status}</p>}{error && <p className="error" role="alert">{error}</p>}
  </section>;
}
