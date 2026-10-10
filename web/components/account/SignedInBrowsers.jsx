'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '../UI';
import { api, clearKey } from '../../lib/api';
import { browserTime, listBrowsers, signOutBrowsers } from '../../lib/browser-sessions.js';
import s from './SignedInBrowsers.module.css';

export default function SignedInBrowsers({ apiKey, onSignedOut, onChanged }) {
  const [rows, setRows] = useState([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setRows([]); setReady(false); setError(''); setNotice(''); setConfirm(null);
    if (apiKey) listBrowsers((path, options) => api(path, { ...options, key: apiKey }), { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setRows(result); setReady(true); } })
      .catch(e => { if (!controller.signal.aborted) setError(e.status === 403 ? 'Connect an account management key to manage signed-in browsers.' : 'Could not read signed-in browsers.'); });
    return () => controller.abort();
  }, [apiKey]);
  async function signOut() {
    if (lock.current || !confirm) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    let signedOut = false;
    try {
      const result = await signOutBrowsers((path, options) => api(path, { ...options, key: apiKey }), { ...confirm, confirmed: true }, row => {
        setRows(previous => previous.filter(item => item.hash !== row.hash));
        if (row.current) { signedOut = true; clearKey(); onSignedOut?.(); }
      });
      if (signedOut) return;
      setNotice(`${result.disabled.length} ${result.disabled.length === 1 ? 'browser signed' : 'browsers signed'} out.`);
      if (result.failed.length) setError(`Could not sign out ${result.failed.map(row => row.label).join(', ')}. Try again.`);
      setConfirm(null);
      setRows(await listBrowsers((path, options) => api(path, { ...options, key: apiKey })));
      await onChanged?.();
    } catch { if (!signedOut) setError('Could not complete sign-out. Refresh the list and try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const close = () => { if (!lock.current) setConfirm(null); };
  if (!apiKey) return null;
  return <section className="settings-panel" aria-labelledby="signed-in-browsers-title">
    <h3 id="signed-in-browsers-title">Signed-in browsers</h3>
    <p>Manage wallet sign-ins to your account. Each row is a sign-in key, which can be shared by tabs. Browser labels are approximate.</p>
    <p className="help-text">Last used records a charged call, not browsing. Keys connected by hand and team or agent sessions are managed separately.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!ready && !error && <p role="status">Reading signed-in browsers…</p>}
    {ready && !rows.length && <p>No active wallet sign-ins.</p>}
    <ul className={s.list}>{rows.map(row => <li className={s.row} key={row.hash}>
      <div><strong>{row.browser_label}</strong>{row.current && <span className="badge">This browser</span>}
        <p>Signed in: <time dateTime={row.created_at}>{browserTime(row.created_at)}</time><br/>
          Last used for a call: {row.last_used ? <time dateTime={row.last_used}>{browserTime(row.last_used)}</time> : 'Never'}</p>
      </div>
      <Button secondary disabled={busy} aria-label={`Sign out ${row.current ? 'this browser' : row.browser_label}`} onClick={() => setConfirm({ hash: row.hash, label: row.browser_label, current: row.current })}>Sign out</Button>
    </li>)}</ul>
    {ready && rows.some(row => !row.current) && <Button secondary disabled={busy} onClick={() => setConfirm({ allOthers: true })}>Sign out all other browsers</Button>}
    {confirm && <Modal title={confirm.allOthers ? 'Sign out all other browsers?' : 'Sign out this browser?'} onClose={close}>
      <p>{confirm.allOthers ? 'All other active wallet sign-in keys will stop accepting new requests. This browser’s key stays on.' : `${confirm.label} will stop accepting new requests.${confirm.current ? ' You will need to sign in again.' : ''}`}</p>
      <p>Requests already running may finish. Account funds and history stay in place. An owner can switch a key back on from API keys.</p>
      <div className="button-row"><Button disabled={busy} onClick={signOut}>{busy ? 'Signing out…' : 'Confirm sign out'}</Button><Button secondary disabled={busy} onClick={close}>Cancel</Button></div>
    </Modal>}
  </section>;
}
