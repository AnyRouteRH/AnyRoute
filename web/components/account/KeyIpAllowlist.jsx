'use client';
// E148: add IP settings to the existing key editor.
import { createContext, useContext, useEffect, useId, useState } from 'react';
import { api } from '../../lib/api';
import { addCurrentIp, saveKeyAllowedIps } from '../../lib/key-ip';
import { Button } from '../UI';
import s from './KeyIpAllowlist.module.css';

export const KeyIpContext = createContext(null);
export default function KeyIpAllowlist({ keyHash, current = false }) {
  const apiKey = useContext(KeyIpContext);
  const id = useId();
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!apiKey || !keyHash) return;
    const ac = new AbortController();
    setLoaded(false);
    api('/api/v1/keys/' + encodeURIComponent(keyHash), { key: apiKey, signal: ac.signal }).then(result => {
      if (!ac.signal.aborted) { setText((result.data.allowed_ips ?? []).join('\n')); setLoaded(true); }
    }).catch(e => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [apiKey, keyHash]);
  if (!apiKey || !keyHash) return null;
  const request = (path, options = {}) => api(path, { ...options, key: apiKey });
  const action = async fn => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <fieldset className={s.settings} disabled={busy || !loaded}>
    <legend>IP addresses</legend>
    <label htmlFor={id}>Only allow these IP addresses</label>
    <textarea id={id} rows={4} value={text} spellCheck={false} autoCapitalize="none" aria-describedby={id + '-help'} onChange={e => { setText(e.target.value); setNotice(''); }}/>
    <p id={id + '-help'} className="help-text">Enter one IPv4 or IPv6 address or CIDR range per line, up to 32. Leave empty to allow any IP address. Onion and unlinkable requests cannot use a restricted key.</p>
    {current && <p className="help-text">These restrictions also apply to your signed-in key. Keep another management key available in case your IP address changes.</p>}
    <div className="button-row">
      <Button secondary type="button" onClick={() => action(async () => {
        setText(await addCurrentIp(request, text)); setNotice('Your current IP address was added. Save to apply it.');
      })}>Use my current IP</Button>
      <Button secondary type="button" onClick={() => action(async () => {
        const allowed_ips = await saveKeyAllowedIps(request, keyHash, text);
        setNotice(allowed_ips ? 'Allowed IP addresses saved.' : 'IP restrictions removed.');
      })}>Save IP addresses</Button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </fieldset>;
}
