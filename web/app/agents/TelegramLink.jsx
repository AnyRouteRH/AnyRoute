'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/UI';
import { api } from '../../lib/api';
import { readTelegramLink, issueTelegramLink, unlinkTelegram } from '../../lib/telegram-linking';
import WeeklySummary from './WeeklySummary'; // B120

export default function TelegramLink({ principalKey }) {
  const [status, setStatus] = useState(null);
  const [code, setCode] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState(false);
  const request = useCallback((path, options = {}) => api(path, { ...options, key: principalKey }), [principalKey]);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null); setCode(null); setError(''); setOff(false);
    const refresh = () => readTelegramLink(request, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setStatus(data); if (data.linked) setCode(null);
    }).catch(e => { if (!controller.signal.aborted) { setOff(e.status === 404); setError(e.status === 404 ? '' : e.message); } });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [request]);
  if (off) return null;
  const act = async fn => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <section className="control-panel"><h2>Telegram</h2>
    <p className="help-text">Link this owner/admin key’s account for agent approvals and alerts. Send a one-time code to Anyroute’s bot; no API key is needed in Telegram. Telegram can read these messages. The link’s authority ends if the key expires, is disabled or loses its role.</p>
    <p className="help-text">Agent approvals and alerts are also in <a className="inline-link" href="/dashboard/#inbox">your inbox</a>.</p>
    <p role="status">{status ? status.linked ? `Linked to Telegram user ${status.telegram_user_id}.` : 'Telegram is not linked for this key.' : 'Reading Telegram status…'}</p>
    {status?.linked && <WeeklySummary request={request} />} {/* B120 */}
    {error && <p role="alert">{error}</p>}
    {status && <div className="button-row">{!status.linked && <Button disabled={busy} onClick={() => act(async () => setCode(await issueTelegramLink(request)))}>Link Telegram</Button>}<Button secondary disabled={busy} onClick={() => act(async () => { await unlinkTelegram(request); setCode(null); setStatus(await readTelegramLink(request)); })}>{status.linked ? 'Unlink Telegram' : 'Cancel linking'}</Button></div>}
    {code && <div><p>Send <code>/link {code.code}</code> in a private chat with Anyroute’s bot. Keep this code to yourself; it grants approval authority. It expires at {new Date(code.expires_at).toLocaleTimeString()} and works once.</p><p className="help-text">Status refreshes every five seconds. You can also send /unlink to the bot. Linking does not connect chat inference; /key and /forget manage that separately.</p></div>}
  </section>;
}
