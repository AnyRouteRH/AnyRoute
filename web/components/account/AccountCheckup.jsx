'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Button } from '../UI';
import { accountCheckupItems, readAccountCheckup, readCheckupDismissed, writeCheckupDismissed, visibleCheckupItems } from '../../lib/account-checkup.js';
import s from './AccountCheckup.module.css';

export default function AccountCheckup({ apiKey, workspace, agents, agentsError, revision }) {
  const scope = workspace.me?.hash;
  const [data, setData] = useState(null), [dismissed, setDismissed] = useState([]), [storageError, setStorageError] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const ac = new AbortController(); setData(null); setError(''); setStorageError(false);
    const preferences = () => { try { setDismissed(readCheckupDismissed(window.localStorage, scope)); } catch { setDismissed([]); setStorageError(true); } };
    preferences();
    const read = () => readAccountCheckup((path, options) => api(path, { ...options, key: apiKey }), { workspace, signal: ac.signal }).then(value => { if (!ac.signal.aborted) setData(value); }).catch(e => { if (!ac.signal.aborted) setError(e.message); });
    read();
    const wake = () => { preferences(); if (document.visibilityState !== 'hidden') read(); };
    window.addEventListener('focus', wake); window.addEventListener('storage', preferences);
    document.addEventListener('visibilitychange', wake);
    return () => { ac.abort(); window.removeEventListener('focus', wake); window.removeEventListener('storage', preferences); document.removeEventListener('visibilitychange', wake); };
  }, [apiKey, scope, workspace, revision]);
  if (!scope) return null;
  const items = accountCheckupItems({ workspace, agents, ...data });
  const visible = visibleCheckupItems(items, dismissed);
  function remember(ids) {
    try { if (!writeCheckupDismissed(window.localStorage, scope, ids)) setStorageError(true); } catch { setStorageError(true); }
    setDismissed(ids);
  }
  return <section className={`control-panel ${s.card}`} aria-labelledby="account-checkup-title">
    <div className="panel-heading"><h3 id="account-checkup-title">Account checkup</h3><a className="inline-link" href="/docs/#account-checkup">About these checks</a></div>
    <p className="help-text">Review the safety controls visible to this key. Fix opens the existing control for you to choose and save.</p>
    {error ? <p role="status">{error}</p> : <>
      {!data && <p role="status">Reading account checks…</p>}
      {visible.length > 0 && <ul className={s.items}>{visible.map(item => <li key={item.id}><div><p>{item.sentence}{item.suggestion && <span className="badge">Suggestion</span>}</p><p className="help-text">{item.why}</p></div><div className={s.actions}><Button secondary href={item.href} aria-label={`Fix: ${item.sentence}`}>Fix</Button><button className="text-button" type="button" aria-label={`Dismiss: ${item.sentence}`} onClick={() => remember([...dismissed, item.id])}>Dismiss</button></div></li>)}</ul>}
      {data && !visible.length && <p role="status">No more suggestions from the checks read so far.</p>}
      {data?.errors.map(message => <p className="help-text" key={message}>{message}</p>)}
      {workspace.keysError && <p className="help-text">Other account keys could not be read. Checks cover the connected key only.</p>}
      {!agents && <p className="help-text">{agentsError ? 'Agent checks are unavailable to this key or could not be read.' : 'Reading agent checks…'}</p>}
      {dismissed.length > 0 && <button className="text-button" type="button" onClick={() => remember([])}>Show dismissed items</button>}
      <p className="help-text">Dismissals stay in this browser for this account key. IP lists and agent rules are suggestions, not a security assessment. Use Refresh account details after changing a key or agent.</p>
      {storageError && <p className="help-text" role="status">Browser storage is unavailable. Dismissals last for this view only.</p>}
    </>}
  </section>;
}
