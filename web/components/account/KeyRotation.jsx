'use client';
// G158: use the account's existing one-time reveal and dialog.
import { useEffect, useId, useState } from 'react';
import { api } from '../../lib/api';
import { canRotateKey, rotateAccountKey, rotationChoices, rotationLines } from '../../lib/key-rotation';
import { Button, Modal } from '../UI';
import s from './KeyRotation.module.css';

export default function KeyRotation({ apiKey, keys = [], caller, onChanged, onSecret }) {
  const [links, setLinks] = useState({});
  const [selected, setSelected] = useState(null);
  const [grace, setGrace] = useState('24h');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => {
    if (!apiKey || !keys.length || ['read', 'inference'].includes(caller?.scope)) return;
    const ac = new AbortController();
    Promise.all(keys.map(async key => {
      const result = await api('/api/v1/keys/' + encodeURIComponent(key.hash) + '/rotation', { key: apiKey, signal: ac.signal });
      return [key.hash, result.data];
    })).then(rows => { if (!ac.signal.aborted) setLinks(Object.fromEntries(rows)); }).catch(e => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [apiKey, keys, caller?.scope]);
  if (!caller || ['read', 'inference'].includes(caller.scope) || !keys.length) return null;
  return <section className={'settings-panel ' + s.panel} aria-labelledby={id + '-title'}>
    <h3 id={id + '-title'}>Rotate a key</h3>
    <p>Replace an account-backed key while your apps switch to the new secret. The old key keeps working until its grace period or its earlier expiry ends. Spending history stays with the old key.</p>
    <ul className={s.list}>{keys.map(key => <li key={key.hash}>
      <strong>{key.name || 'Unnamed key'}</strong>
      <span className={s.label}>{key.label}</span>
      {rotationLines(links[key.hash], keys, links).map(line => <p key={line} className="help-text">{line}</p>)}
      {Object.hasOwn(links, key.hash) && canRotateKey(key, caller, links[key.hash]) && <Button secondary onClick={() => { setSelected(key); setGrace('24h'); setError(''); }}>Rotate</Button>}
    </li>)}</ul>
    {error && <p className="error" role="alert">{error}</p>}
    {selected && <Modal title="Rotate this key" onClose={() => { if (!busy) setSelected(null); }}>
      <p>Keep the old secret working while you update your apps. The replacement keeps this key’s name and settings. Keys funded on chain and agent-session keys cannot be rotated.</p>
      <form onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('');
        try {
          const result = await rotateAccountKey((path, options) => api(path, { ...options, key: apiKey }), selected.hash, grace);
          setLinks(previous => ({ ...previous, [selected.hash]: { ...result.rotation, from: links[selected.hash]?.from ?? null, to: result.data.hash } }));
          setSelected(null);
          onSecret(result.key);
          Promise.resolve(onChanged?.()).catch(() => {});
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      }}>
        <div className="form-field"><label htmlFor={id + '-grace'}>Grace period</label><select id={id + '-grace'} value={grace} disabled={busy} onChange={e => setGrace(e.target.value)}>{rotationChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        {selected.hash === caller.hash && <p className="help-text">This browser uses the old key. Copy the replacement now and sign in with it before the grace period ends.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? 'Rotating…' : 'Rotate and show secret'}</Button>
      </form>
    </Modal>}
  </section>;
}
