'use client';
import { useEffect, useState } from 'react';
import { Button, Modal } from '../UI';
import { api } from '../../lib/api';
import { linkWallet, shortWallet, unlinkWallet } from '../../lib/linked-wallets';
export default function LinkedWalletsSettings({ apiKey }) {
  const [wallets, setWallets] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api('/api/v1/account/wallets', { key: apiKey, signal: controller.signal }).then(r => { if (!controller.signal.aborted) setWallets(r.data); }).catch(e => { if (!controller.signal.aborted && e.status !== 403) setError('Linked wallets could not be read. Try again.'); });
    return () => controller.abort();
  }, [apiKey]);
  async function change(remove) {
    setBusy(true); setError('');
    try {
      if (remove) await unlinkWallet(api, apiKey, remove);
      else await linkWallet(api, window.ethereum, apiKey);
      setConfirm(null);
      setWallets((await api('/api/v1/account/wallets', { key: apiKey })).data);
    } catch (e) { setError(e.code === 4001 ? 'Wallet signing was cancelled.' : e.message || 'The wallet change could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  if (wallets === null) return error ? <p role="alert">{error}</p> : null;
  return <section className="settings-panel"><h3>Linked wallets</h3>
    <p>Link another wallet so its deposits reach this account and it can pay another agent. Choose that wallet in your wallet app, then sign the one-time message.</p>
    <p>A wallet with its own account or a link elsewhere cannot be added. Accounts cannot be merged. Your original sign-in wallet stays the same.</p>
    <Button secondary disabled={busy} onClick={() => change()}>Link another wallet</Button>
    {wallets.length === 0 && <p>No other wallets linked.</p>}
    <ul>{wallets.map(w => <li key={w.wallet}><span title={w.wallet}>{shortWallet(w.wallet)}</span> · Linked <time dateTime={w.linked_at}>{new Date(w.linked_at).toLocaleDateString()}</time> <Button secondary disabled={busy} aria-label={`Unlink ${shortWallet(w.wallet)}`} onClick={() => setConfirm(w.wallet)}>Unlink</Button></li>)}</ul>
    {busy && <p role="status">Waiting for the wallet change…</p>}{error && <p role="alert">{error}</p>}
    {confirm && <Modal title="Unlink wallet" onClose={() => setConfirm(null)}><p>Unlink {shortWallet(confirm)}? Its future deposits will stop reaching this account. Past credits stay here.</p><div className="button-row"><Button disabled={busy} onClick={() => change(confirm)}>Unlink wallet</Button><Button secondary disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button></div></Modal>}
  </section>;
}
