'use client';
import { useEffect, useRef, useState } from 'react';
import AccountShell from './AccountShell';
import { useAccountKey } from './useAccountKey';
import { api } from '../../lib/api';
import { eventLabel, signingLabel } from '../../lib/webhooks';
import { Button, CopyButton, Modal } from '../UI';
import s from './Webhooks.module.css';
function Events({ names, selected, onChange, id }) {
  return <fieldset className={s.events}><legend>Events</legend>{names.map(name => <label key={name} htmlFor={id + name}><input id={id + name} type="checkbox" checked={selected.includes(name)} onChange={e => onChange(e.target.checked ? [...selected, name] : selected.filter(n => n !== name))}/>{eventLabel(name)}</label>)}</fieldset>;
}
export default function Webhooks() {
  const [key, connect] = useAccountKey();
  return <AccountShell current="Webhooks" apiKey={key} onConnect={connect} onDisconnect={() => connect('')}><Manager key={key} apiKey={key}/></AccountShell>;
}
function Manager({ apiKey }) {
  const [rows, setRows] = useState([]), [names, setNames] = useState([]), [selected, setSelected] = useState([]), [url, setUrl] = useState('');
  const [error, setError] = useState(''), [disabled, setDisabled] = useState(false), [busy, setBusy] = useState(false), [secret, setSecret] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const request = (path, opts = {}) => api('/api/v1/webhooks' + path, { key: apiKey, ...opts });
  async function load() { const r = await request(''); if (mounted.current) { setRows(r.data); setNames(r.events); } }
  useEffect(() => { load().catch(e => { if (mounted.current) { if (e.status === 404) setDisabled(true); else setError(e.message); } }); }, [apiKey]);
  async function run(action) {
    setBusy(true); setError(''); setMessage('');
    try { const r = await action(); if (!mounted.current) return; if (r?.signing_secret) setSecret(r.signing_secret); await load(); }
    catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="control-panel"><h2>Manage destinations</h2>
    <p className="help-text">Use a management key to add account destinations. Owner/admin keys can manage linked destinations scoped to their own key. Signing is not switched on at anyroute.tech yet.</p>
    {error && <p className="error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {disabled ? <p role="status">Signed webhooks are not switched on for this router. Existing alert destinations keep their current delivery behaviour.</p> : <>
      <form onSubmit={e => { e.preventDefault(); run(async () => { const r = await request('', { method: 'POST', body: { webhook_url: url, events: selected } }); if (mounted.current) setUrl(''); return r; }); }}>
        <div className="field"><label htmlFor="webhook-url">HTTPS destination</label><input id="webhook-url" type="url" autoComplete="off" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)}/></div>
        <Events names={names} selected={selected} onChange={setSelected} id="new-hook-"/>
        <Button type="submit" disabled={busy || !selected.length}>Add destination</Button>
      </form>
      <p className="help-text">Secrets appear once. Verify the exact body bytes, allow at most five minutes of clock difference, and reject repeated event IDs. <a href="/docs/#signed-webhooks">Read verification instructions</a>.</p>
      <div className={s.destinations}>{rows.map(row => <Destination key={row.id} row={row} names={names} busy={busy} run={run} request={request} onMessage={setMessage}/>)}</div>
      <div className={s.actions}><Button secondary disabled={busy} onClick={() => run(load)}>Refresh</Button></div>
    </>}
    {secret && <Modal title="Save your signing secret" onClose={() => setSecret('')}><p>This secret is shown once. Anyone with it can sign notices accepted by your receiver. Rotation stops use of the previous secret.</p><code className={s.secret}>{secret}</code><div className={s.actions}><CopyButton text={secret} label="Copy secret"/><Button onClick={() => setSecret('')}>Saved</Button></div></Modal>}
  </section>;
}
function Destination({ row, names, busy, run, request, onMessage }) {
  const [selected, setSelected] = useState(row.events), [log, setLog] = useState(null);
  useEffect(() => setSelected(row.events), [row.events]);
  const path = '/' + encodeURIComponent(row.id);
  return <section><h3>{row.webhook_url}</h3><p>{signingLabel(row.signing)}</p>{row.legacy_rule_id && <p className="help-text">Linked to Spend Watch. Change its URL or remove it there.</p>}
    <Events names={names} selected={selected} onChange={setSelected} id={row.id}/>
    <div className={s.actions}>
      <Button secondary disabled={busy || !selected.length} onClick={() => run(() => request(path, { method: 'PATCH', body: { events: selected } }))}>Save events</Button>
      <Button secondary disabled={busy} onClick={() => run(() => request(path + '/rotate', { method: 'POST' }))}>Rotate secret</Button>
      <Button secondary disabled={busy || row.signing === 'revoked'} onClick={() => run(() => request(path + '/revoke', { method: 'POST' }))}>Revoke</Button>
      <Button secondary disabled={busy || row.signing === 'revoked'} onClick={() => run(async () => { const r = await request(path + '/test', { method: 'POST' }); onMessage('Endpoint check queued. Refresh the log after the worker runs.'); return r; })}>Send check event</Button>
      <Button secondary disabled={busy} onClick={() => run(async () => { const r = await request(path + '/deliveries'); setLog(r.data); return r; })}>Read delivery log</Button>
      {!row.legacy_rule_id && <Button secondary disabled={busy} onClick={() => run(() => request(path, { method: 'DELETE' }))}>Remove destination</Button>}
    </div>
    {log && <div className={s.log}>{log.length ? <table><caption>Last 100 delivery attempts</caption><thead><tr><th>Time</th><th>Event</th><th>Status</th><th>HTTP</th><th>Latency</th><th>Retries</th></tr></thead><tbody>{log.map((a, i) => <tr key={a.event_id + ':' + i}><td><time dateTime={a.at}>{new Date(a.at).toLocaleString()}</time></td><td>{eventLabel(a.event)}</td><td>{a.status}</td><td>{a.http_status ?? '—'}</td><td>{a.latency_ms} ms</td><td>{a.retry_count}</td></tr>)}</tbody></table> : <p>No delivery attempts recorded.</p>}</div>}
  </section>;
}
