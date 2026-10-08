'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { scheduleDraft, failureWords, approvedScheduleRequests } from '../../lib/schedules.js';
import { Button } from '../UI';
import s from './Schedules.module.css';

const empty = { name: '', prompt: '', model: '', key_hash: '', cadence: 'daily', time_utc: '09:00', max_cost_usd: '0.05', paused: false };
export default function AccountSchedules({ apiKey, keys = [] }) {
  const [rows, setRows] = useState([]), [draft, setDraft] = useState(empty), [editing, setEditing] = useState(null);
  const [approvals, setApprovals] = useState([]), [approval, setApproval] = useState('');
  const [runs, setRuns] = useState([]), [selected, setSelected] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const request = (path = '', options = {}) => api('/api/v1/schedules' + path, { key: apiKey, ...options });
  async function refresh() { const result = await request(); setRows(result.data); setLoaded(true); }
  useEffect(() => { let live = true; api('/api/v1/schedules', { key: apiKey }).then(result => { if (live) { setRows(result.data); setLoaded(true); } }).catch(err => { if (live) { setError(err.type === 'feature_disabled' ? 'Scheduled prompts are not switched on yet.' : err.message); } }); return () => { live = false; }; }, [apiKey]);
  async function action(fn) { setBusy(true); setError(''); try { await fn(); await refresh(); } catch (err) { setError(err.message); } finally { setBusy(false); } }
  const change = field => event => setDraft(old => ({ ...old, [field]: event.target.value }));
  async function view(row) { setSelected(row); setApproval(''); const [result, approved] = await Promise.all([request('/' + row.id + '/runs'), api('/api/v1/agents/approvals?status=approved', { key: apiKey }).catch(() => ({ data: [] }))]); setRuns(result.data); setApprovals(approvedScheduleRequests(approved.data, row)); }
  useEffect(() => { if (!loaded) return; const id = new URLSearchParams(window.location.search).get('schedule'); const row = rows.find(item => item.id === id); if (row && !selected) action(() => view(row)); }, [loaded]);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('run'); if (id && runs.some(run => run.id === id)) document.getElementById('schedule-run-' + id)?.focus(); }, [runs]);
  const activeKeys = keys.filter(key => !key.disabled);
  return <section className="control-panel" aria-labelledby="schedules-title">
    <h2 id="schedules-title" tabIndex={-1}>Schedules</h2>
    <p>Save a prompt to run every hour, every day, or every Monday. Each run spends from your chosen key and follows its limits and rulebook.</p>
    <p className="help-text">Anyroute stores your prompt and the last ten replies encrypted at rest. Anyroute reads them to run and show results. Linked Telegram receives the schedule name and first 300 reply characters. Delete a schedule to remove its saved prompt and replies.</p>
    {error && <p role="alert">{error}</p>}
    {loaded && <>
      <form className={s.form} onSubmit={event => { event.preventDefault(); action(async () => { const body = { ...draft, time_utc: draft.cadence === 'hourly' ? null : draft.time_utc }; await request(editing ? '/' + editing : '', { method: editing ? 'PATCH' : 'POST', body }); setDraft(empty); setEditing(null); }); }}>
        <label htmlFor="schedule-name">Name<input id="schedule-name" required maxLength={100} value={draft.name} onChange={change('name')}/></label>
        <label htmlFor="schedule-prompt" className={s.wide}>Prompt<textarea id="schedule-prompt" required maxLength={64000} rows={5} value={draft.prompt} onChange={change('prompt')}/></label>
        <label htmlFor="schedule-model">Model<input id="schedule-model" required value={draft.model} onChange={change('model')}/></label>
        <label htmlFor="schedule-key">Key that pays<select id="schedule-key" required value={draft.key_hash} onChange={change('key_hash')}><option value="">Choose a key</option>{activeKeys.map(key => <option key={key.hash} value={key.hash}>{key.name || key.label || 'Account key'}</option>)}</select></label>
        <label htmlFor="schedule-cadence">How often<select id="schedule-cadence" value={draft.cadence} onChange={change('cadence')}><option value="hourly">Every hour</option><option value="daily">Every day</option><option value="monday">Every Monday</option></select></label>
        {draft.cadence !== 'hourly' && <label htmlFor="schedule-time">Time in UTC<input id="schedule-time" required type="time" value={draft.time_utc || '09:00'} onChange={change('time_utc')}/></label>}
        <label htmlFor="schedule-cost">Maximum cost per run ($)<input id="schedule-cost" required type="number" min="0.000000000001" max="1000" step="any" value={draft.max_cost_usd} onChange={change('max_cost_usd')}/></label>
        <div className="button-row"><Button disabled={busy} type="submit">{editing ? 'Save changes' : 'Save schedule'}</Button>{editing && <Button secondary type="button" onClick={() => { setEditing(null); setDraft(empty); }}>Cancel</Button>}</div>
      </form>
      {!rows.length && <p>No schedules saved yet.</p>}
      <ul className={s.list}>{rows.map(row => <li key={row.id}>
        <h3>{row.name}</h3><p>{row.paused ? 'Paused' : 'Next run: ' + new Date(row.next_at).toUTCString()} · Maximum ${row.max_cost_usd} per run</p>
        <div className="button-row">
          <Button secondary disabled={busy} onClick={() => action(() => view(row))}>View results</Button>
          <Button secondary disabled={busy} onClick={() => { setEditing(row.id); setDraft(scheduleDraft(row)); document.getElementById('schedule-name')?.focus(); }}>Edit</Button>
          <Button secondary disabled={busy} onClick={() => action(() => request('/' + row.id, { method: 'PATCH', body: { paused: !row.paused } }))}>{row.paused ? 'Resume' : 'Pause'}</Button>
          <Button secondary disabled={busy} onClick={() => action(async () => { await request('/' + row.id + '/run-now', { method: 'POST' }); await view(row); })}>Run now</Button>
          <Button secondary disabled={busy} onClick={() => action(async () => { await request('/' + row.id, { method: 'DELETE' }); if (selected?.id === row.id) { setSelected(null); setRuns([]); } })}>Delete schedule</Button>
        </div>
      </li>)}</ul>
      {selected && <section aria-labelledby="schedule-results-title"><h3 id="schedule-results-title">{selected.name}: saved results</h3><p className="help-text">The last ten runs. Failed runs show why they stopped; three failures in a row pause automatic runs.</p>{!runs.length && <p>No runs yet.</p>}{approvals.length > 0 && <div className="button-row"><label htmlFor="schedule-approval">Approved request<select id="schedule-approval" value={approval} onChange={event => setApproval(event.target.value)}><option value="">Choose an approval</option>{approvals.map(item => <option key={item.id} value={item.id}>Approved · expires {new Date(item.expires_at).toUTCString()}</option>)}</select></label><Button disabled={busy || !approval} onClick={() => action(async () => { await request('/' + selected.id + '/run-now', { method: 'POST', headers: { 'x-agent-approval': approval } }); await view(selected); })}>Run with approval</Button></div>}{runs.map(run => <article tabIndex={-1} key={run.id} id={'schedule-run-' + run.id}><h4>{new Date(run.started_at).toUTCString()}</h4><p>{run.status === 'succeeded' ? 'Finished' : run.status === 'running' ? 'Running' : 'Run stopped: ' + failureWords(run.reason)}</p>{run.reply !== null && <p className={s.reply}>{run.reply}</p>}</article>)}</section>}
    </>}
  </section>;
}
