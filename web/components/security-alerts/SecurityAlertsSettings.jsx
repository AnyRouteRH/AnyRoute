'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { readSecurityAlerts, saveSecurityAlerts } from '../../lib/security-alerts';
export default function SecurityAlertsSettings({ apiKey }) {
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setEnabled(null); setError('');
    readSecurityAlerts(api, { key: apiKey, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setEnabled(result.enabled);
    }).catch(() => {});
    return () => controller.abort();
  }, [apiKey]);
  if (enabled === null) return null;
  async function change() {
    setBusy(true); setError('');
    try {
      const result = await saveSecurityAlerts(api, !enabled, { key: apiKey });
      setEnabled(result.enabled);
    } catch { setError('Security alerts could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  return <section className="settings-panel"><h3>Security alerts</h3>
    <p>Keep a record of key, rulebook, Stop, Resume, Telegram and team changes in your inbox. Linked Telegram accounts receive alerts too.</p>
    <label><input type="checkbox" checked={enabled} disabled={busy} onChange={change}/> Security alerts</label>
    {busy && <p role="status">Saving security alerts…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
