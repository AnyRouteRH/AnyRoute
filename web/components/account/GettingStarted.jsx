'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { gettingStartedSteps, gettingStartedHidden, readGettingStarted, readGettingStartedState as readPreferences, rememberGettingStartedReceipts, writeGettingStarted } from '../../lib/getting-started.js';
import styles from './GettingStarted.module.css';

export default function GettingStarted({ apiKey, workspace, agents, revision }) {
  const scope = workspace.me?.hash;
  const [data, setData] = useState(null);
  const [preferences, setPreferences] = useState(null);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setPreferences(null);
    if (!scope) return () => controller.abort();
    const refreshPreferences = () => { try { setPreferences(readPreferences(window.localStorage, scope)); } catch { setPreferences({}); setStorageError(true); } };
    refreshPreferences();
    const read = async () => {
      const initial = gettingStartedSteps({ workspace });
      const value = await readGettingStarted((path, options) => api(path, { ...options, key: apiKey }), { signal: controller.signal, readDeposits: !initial[0].done });
      if (controller.signal.aborted) return;
      try {
        const ids = [...(workspace.receipts || []).map(row => row.id), ...value.activity.map(row => row.receipt_id)];
        if (!rememberGettingStartedReceipts(window.localStorage, scope, ids)) setStorageError(true);
      } catch { setStorageError(true); }
      setData(value); refreshPreferences();
    };
    read().catch(() => {});
    const wake = () => { refreshPreferences(); if (document.visibilityState !== 'hidden') read().catch(() => {}); };
    window.addEventListener('focus', wake); window.addEventListener('storage', refreshPreferences);
    document.addEventListener('visibilitychange', wake);
    return () => { controller.abort(); window.removeEventListener('focus', wake); window.removeEventListener('storage', refreshPreferences); document.removeEventListener('visibilitychange', wake); };
  }, [apiKey, scope, workspace, revision]);
  const steps = gettingStartedSteps({ workspace, agents, ...data, checked: preferences?.checked });
  const complete = steps.every(step => step.done);
  useEffect(() => {
    if (!complete || !scope) return;
    try { if (!writeGettingStarted(window.localStorage, scope, { complete: true })) setStorageError(true); } catch { setStorageError(true); }
  }, [complete, scope]);
  if (!scope || !preferences || gettingStartedHidden(preferences, steps)) return null;
  return <section className={`control-panel ${styles.card}`} aria-labelledby="getting-started-title">
    <div className="panel-heading"><h3 id="getting-started-title">Getting started</h3><button type="button" className="text-button" onClick={() => {
      try { if (!writeGettingStarted(window.localStorage, scope, { hidden: true })) setStorageError(true); } catch { setStorageError(true); }
      setPreferences(old => ({ ...old, hidden: true }));
    }}>Hide</button></div>
    <p role="status">{steps.filter(step => step.done).length} of 5 done</p>
    <ol className={styles.steps}>{steps.map(step => <li key={step.id}>
      <span className={styles.tick} aria-label={step.done ? 'Done' : 'To do'}>{step.done ? '✓' : '○'}</span>
      <a className="inline-link" href={step.href}>{step.title}</a>
    </li>)}</ol>
    {!data && <p className="help-text" role="status">Read your account progress…</p>}
    {data?.errors.map(error => <p className="help-text" key={error}>{error}</p>)}
    <p className="help-text">Open one of your receipts to finish. Receipt visits and Hide stay in this browser for this account key.</p>
    {storageError && <p className="help-text" role="status">Allow browser storage to remember receipt visits and Hide after you leave.</p>}
  </section>;
}
