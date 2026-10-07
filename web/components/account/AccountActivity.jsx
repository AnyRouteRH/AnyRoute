'use client';
import ProjectFilter from './ProjectFilter.js'; // C134
import { useProjectActivity } from '../../lib/project-activity.js'; // C134
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { ACTIVITY_KINDS, ACTIVITY_LABELS, activityBounds, activityChips, activityPage, activityPath, exportActivity } from '../../lib/activity.js';
import ActivityList from './ActivityList.js';
import ActivityReceipt from './ActivityReceipt';
import './activity.css';
export default function AccountActivity({ apiKey, keys = [], recent = false }) {
  const [filters, setFilters] = useState(recent ? { kind: 'call' } : {});
  const [form, setForm] = useState({ key: '', model: '', from: '', to: '' });
  const [page, setPage] = useState({ rows: [], next: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [revision, setRevision] = useState(0);
  const { project, changeProject, api } = useProjectActivity(setRevision); // C134
  const loadController = useRef(null), exportController = useRef(null);
  const request = (path, options) => api(path, { ...options, key: apiKey });
  useEffect(() => {
    const controller = new AbortController(); loadController.current = controller;
    setPage({ rows: [], next: null }); setError(''); setBusy(true);
    request(activityPath(filters, '', 'json', recent ? 5 : 50), { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setPage(activityPage(value)); }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); loadController.current?.abort(); exportController.current?.abort(); };
  }, [apiKey, filters, revision, recent]);
  async function more() {
    const controller = new AbortController(); loadController.current = controller; setBusy(true); setError('');
    try { const next = activityPage(await request(activityPath(filters, page.next), { signal: controller.signal })); if (!controller.signal.aborted) setPage(old => ({ ...next, rows: [...old.rows, ...next.rows] })); }
    catch (e) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function download(format) {
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setError('');
    try {
      const file = await exportActivity(request, filters, format, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); URL.revokeObjectURL(url);
    } catch (e) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (exportController.current === controller) setExporting(false); }
  }
  const changeKind = kind => setFilters(old => { const next = { ...old }; if (kind) next.kind = kind; else delete next.kind; return next; });
  return <section className="control-panel account-activity" aria-label={recent ? 'Recent calls' : 'Activity'}>
    <div className="panel-heading">{recent ? <h3>Recent calls</h3> : <h2>Activity</h2>}<a className="inline-link" href={recent ? '/dashboard/#activity' : '/dashboard/#receipts'}>{recent ? 'See all your activity' : 'Open receipt tools'}</a></div>
    {!recent && <><p>Follow calls, approvals, alerts and funds in one list. Call amounts subtract from your balance; agreement amounts describe wallet escrow movements. Other agent events cost zero.</p>
      <div className="activity-kinds" role="group" aria-label="Filter activity kind">{['', ...ACTIVITY_KINDS].map(kind => <button key={kind} className="activity-chip" aria-pressed={(filters.kind || '') === kind} onClick={() => changeKind(kind)}>{kind ? ACTIVITY_LABELS[kind] : 'All activity'}</button>)}</div>
      <form className="activity-filters" onSubmit={e => { e.preventDefault(); if (form.from && form.to && form.from >= form.to) { setError('The start date must be before the end date.'); return; } setFilters(old => ({ kind: old.kind, key: form.key, model: form.model.trim(), ...activityBounds(form.from, form.to) })); }}>
        <label>Key or agent<select value={form.key} onChange={e => setForm(old => ({ ...old, key: e.target.value }))}><option value="">All visible keys</option>{keys.map(key => <option key={key.hash} value={key.hash}>{key.name || key.label || 'Account key'}</option>)}</select></label>
        <label>Model<input value={form.model} onChange={e => setForm(old => ({ ...old, model: e.target.value }))}/></label>
        <label>From (UTC)<input type="date" value={form.from} onChange={e => setForm(old => ({ ...old, from: e.target.value }))}/></label>
        <label>Before (UTC)<input type="date" value={form.to} onChange={e => setForm(old => ({ ...old, to: e.target.value }))}/></label>
        <button className="button secondary" type="submit">Apply filters</button>
      </form>
      <div className="activity-filters"><ProjectFilter value={project} onChange={changeProject}/></div> {/* C134 */}
      <div className="activity-kinds" aria-label="Applied filters">{activityChips(filters).map(chip => <button key={chip.name} className="activity-chip" onClick={() => { setFilters(old => ({ ...old, [chip.name]: '' })); setForm(old => ({ ...old, [chip.name]: '' })); }}>Remove {chip.label} ×</button>)}</div>
      <div className="activity-actions"><button className="text-button" onClick={() => setRevision(old => old + 1)} disabled={busy || exporting}>Refresh</button>{['csv', 'json'].map(format => <button key={format} className="text-button" disabled={exporting || busy} onClick={() => download(format)}>Export {format.toUpperCase()}</button>)}{exporting && <button className="text-button" onClick={() => exportController.current?.abort()}>Cancel export</button>}<a className="inline-link" href="/dashboard/#spend-watch">Open spending tools</a></div>
      <p className="help-text">{page.scope === 'account' ? 'Account access; agent events follow your team permissions.' : 'This key’s visible activity.'} Alerts cover the retained feed. Receipts show what was recorded; use their checks to inspect the evidence. Some oracle events appear after their ruling is linked. Exports read successive pages; records can change while you export.</p></>}
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p role="status">Reading activity…</p>}
    {!busy && !error && !page.rows.length && <p>No activity in this range.</p>}
    <ActivityList rows={page.rows} renderReceipt={row => <ActivityReceipt row={row} apiKey={apiKey}/>}/>
    {!recent && page.next && <button className="button secondary" disabled={busy} onClick={more}>Load more activity</button>}
  </section>;
}
