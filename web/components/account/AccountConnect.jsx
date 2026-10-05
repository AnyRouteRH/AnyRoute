'use client';
import { useEffect, useState } from 'react';
import { api, validKey } from '../../lib/api.js';
import { walletApiKey } from '../../lib/wallet.js';
import { Button } from '../UI';
import s from './AccountShell.module.css';
export default function AccountConnect({ onConnect, onSecret }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [escrow, setEscrow] = useState(null);
  useEffect(() => { const ac = new AbortController(); api('/api/v1/escrow', { signal: ac.signal }).then(r => setEscrow(!!r.data?.enabled)).catch(() => {}); return () => ac.abort(); }, []);
  async function run(getKey) {
    setBusy(true); setError('');
    try {
      const value = await getKey();
      if (!validKey(value)) throw new Error('Enter a valid Anyroute API key.');
      await api('/api/v1/key', { key: value.trim() });
      await onConnect(value.trim());
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const wallet = () => run(async () => { const key = await walletApiKey('Wallet key'); onSecret(key); return key; });
  return <div className={s.form}>
    <h3>Sign in</h3>
    <div className="button-row"><Button disabled={busy} onClick={wallet}>Sign in with wallet</Button>
      {escrow === false && <Button secondary disabled={busy} onClick={() => run(async () => { const r = await api('/api/v1/keys', { method: 'POST', body: { name: 'Account key' } }); onSecret(r.key); return r.key; })}>Create a key</Button>}
    </div>
    <p className="help-text">No email or password: your browser wallet signs in and you get its API key. Then open Payments to add funds.</p>
    <form onSubmit={e => { e.preventDefault(); run(() => draft); }}>
      <div className="field"><label htmlFor="account-key">Or connect an API key</label><input id="account-key" type="password" autoComplete="off" spellCheck={false} required value={draft} onChange={e => setDraft(e.target.value)}/></div>
      <Button type="submit" secondary disabled={busy}>{busy ? 'Connecting…' : 'Connect your key'}</Button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <p className="help-text">Your key stays in this browser tab’s session storage until you disconnect or close the tab. Use a management key or an owner/admin key to manage agents.</p>
    <details open><summary>New here?</summary><p>Sign in with your browser wallet to get its API key, then open Payments to deposit a listed token. Keep the key safe and use it to connect apps.</p>
      <p className="help-text">Routers using USDG credits also let you create a key directly, then deposit USDG to that key.</p><a className="inline-link" href="/docs/#payments">Read payment and wallet instructions</a> · <a className="inline-link" href="/docs/#quickstart">Read the API quickstart</a>
    </details>
    <p className="help-text">For ordinary calls, the router reads request text in memory to route it. <a href="/keep/" className="inline-link">See what we keep</a>.</p>
  </div>;
}
