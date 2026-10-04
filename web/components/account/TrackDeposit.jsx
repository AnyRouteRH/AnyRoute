'use client';
import { useId, useState } from 'react';
import { api } from '../../lib/api.js';
import { Button } from '../UI';
import s from './DepositProgress.module.css';
export default function TrackDeposit({ apiKey, lane }) {
  const id = useId();
  const [hash, setHash] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  if (!apiKey) return null;
  return <form className={s.track} onSubmit={async e => {
    e.preventDefault(); setMessage('');
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) return setMessage('Enter the transaction hash from your wallet.');
    setBusy(true);
    try {
      await api('/api/v1/credits/deposits', { key: apiKey, method: 'POST', body: { tx_hash: hash.trim(), lane } });
      window.dispatchEvent(new Event('anyroute-deposit-sent'));
      setHash(''); setMessage('Watching this transaction. Only deposits for this account receive credits here.');
    } catch (error) { setMessage(error.message || 'Could not save the transaction. Try again.'); }
    finally { setBusy(false); }
  }}>
    <label htmlFor={id}>Sent from another wallet app? Paste the transaction hash to track it.</label>
    <input id={id} value={hash} onChange={e => setHash(e.target.value)} disabled={busy} spellCheck="false" autoCapitalize="none" maxLength={66}/>
    <Button type="submit" secondary disabled={busy || !hash.trim()}>{busy ? 'Saving transaction…' : 'Track transaction'}</Button>
    {message && <p className="help-text" role="status">{message}</p>}
  </form>;
}
