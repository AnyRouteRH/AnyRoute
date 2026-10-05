'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/UI';
import { connect, ensureChain, shortAddress } from '../../lib/wallet';
import { API_BASE } from '../../lib/api';
import { ENABLED, MANIFEST_URL, MANIFEST_SHA256, ethFromUnits, loadManifest, parseEth, usdFromUnits } from '../../lib/zkapi/protocol';
import { walletStore } from '../../lib/zkapi/storage';
const MODEL = 'meta-llama/llama-3.3-70b-instruct';
const usd = amount => '$' + Number(amount).toFixed(6);

export default function ZkapiWallet() {
  const client = useRef(null), store = useRef(null), prover = useRef(null);
  const [wallet, setWallet] = useState(null), [address, setAddress] = useState(''), [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('');
  const [quote, setQuote] = useState(null), [amount, setAmount] = useState('0.0003'), [minimum, setMinimum] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false), [backedUp, setBackedUp] = useState(false), [backup, setBackup] = useState('');
  const [restoreText, setRestoreText] = useState(''), [hash, setHash] = useState(''), [destination, setDestination] = useState('');
  const [lease, setLease] = useState(null), [prompt, setPrompt] = useState(''), [answer, setAnswer] = useState(null), [now, setNow] = useState(Date.now());
  const [admission, setAdmission] = useState(false);
  useEffect(() => {
    try { store.current = walletStore(localStorage); setWallet(store.current.read()); } catch { setError('Browser storage could not be read. Keep any existing backup; do not fund another note.'); }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const changed = () => { client.current?.prover?.dispose(); client.current = null; prover.current = null; setLease(null); setAddress(''); setBalance(''); setQuote(null); setStatus('Wallet account or chain changed. Reconnect before continuing.'); };
    const storageChanged = () => { try { setWallet(store.current.read()); setBackup(''); setBackedUp(false); } catch { setError('The wallet changed in another tab and could not be read. Keep your backup.'); } };
    window.addEventListener('storage', storageChanged);
    window.ethereum?.on?.('accountsChanged', changed); window.ethereum?.on?.('chainChanged', changed);
    return () => { clearInterval(timer); prover.current?.dispose(); window.removeEventListener('storage', storageChanged); window.ethereum?.removeListener?.('accountsChanged', changed); window.ethereum?.removeListener?.('chainChanged', changed); };
  }, []);
  async function run(message, action) {
    if (busy) return;
    setBusy(true); setError(''); setStatus(message);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'The operation could not finish. Keep your wallet backup.'); setStatus(''); }
    finally { try { if (store.current) setWallet(store.current.read()); } catch { setError('Browser storage is unavailable. Keep your exported backup.'); } setBusy(false); }
  }
  async function connectWallet() {
    setLease(null);
    const account = await connect();
    await ensureChain({ id: 11155111, name: 'Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' });
    setAddress(account); setDestination(account);
    const raw = await window.ethereum.request({ method: 'eth_getBalance', params: [account, 'latest'] });
    setBalance((Number(BigInt(raw)) / 1e18).toFixed(8));
    if (ENABLED && MANIFEST_URL) {
      if (!navigator.locks) throw new Error('This browser needs Web Locks to protect the note across tabs.');
      const manifest = await loadManifest(MANIFEST_URL, MANIFEST_SHA256);
      const [{ ZkapiClient }, { WalletChain }, { createProver }] = await Promise.all([import('../../lib/zkapi/client'), import('../../lib/zkapi/chain'), import('../../lib/zkapi/worker-client')]);
      prover.current?.dispose(); prover.current = createProver();
      const chain = new WalletChain(window.ethereum); await chain.verifyDeployment(manifest);
      client.current = new ZkapiClient({ manifest, store: store.current, chain, prover: prover.current, inferenceBase: (API_BASE || location.origin) + '/api/v1' });
      client.current.current();
      setAdmission(manifest.admission_enabled);
      setQuote(await client.current.quote()); setMinimum(manifest.request_charge_cap);
    }
    setStatus('Connected to Sepolia.');
  }
  const ready = !!client.current && !!address && !busy;
  const pending = wallet?.journal, note = wallet?.state, draft = wallet?.draft;
  const expiry = note?.expiry_ts ? new Date(note.expiry_ts * 1000).toLocaleString() : '';
  const liveLease = lease && lease.expires_at * 1000 > now;
  let amountUsd = null;
  try { if (quote) amountUsd = usdFromUnits(parseEth(amount), quote); } catch {}
  return <div className="zkapi-wallet">
    <div className="zkapi-banner" role="status">{ENABLED && MANIFEST_URL ? (client.current && !admission ? 'The operator has paused funding and new leases. Recovery and withdrawal remain accessible.' : 'Sepolia pilot · connect to check the pinned operator.') : 'Funding is not switched on yet. The hosted operator must be configured before this page can accept deposits.'}</div>
    <section className="zkapi-panel" aria-labelledby="zk-wallet"><span className="eyebrow">01 / CONNECT</span><h2 id="zk-wallet">Connect your wallet</h2>
      <p>Use Sepolia ETH only. Your browser wallet signs the vault transaction; its address is not included in lease or inference requests.</p>
      <Button disabled={busy || !store.current} onClick={() => run('Connecting to Sepolia…', connectWallet)}>{address ? 'Reconnect wallet' : 'Connect wallet'}</Button>
      {address && <p className="zkapi-data">{shortAddress(address)} · {balance} ETH · Sepolia</p>}
      {quote && <p>ETH/USD: {usd(Number(quote.answer) / 1e8)} · quote expires {new Date(quote.expires_at * 1000).toLocaleTimeString()}. Refresh it before funding.</p>}
    </section>
    <section className="zkapi-panel" aria-labelledby="zk-backup"><span className="eyebrow">02 / BACK UP</span><h2 id="zk-backup">Your note wallet</h2>
      <p>The note secret, balance blinding, signed state and recovery journal are saved unencrypted in this browser’s storage. Anyone with access to this browser or an export can use the note. Losing them can lose your funds. They are never sent to the operator or Anyroute.</p>
      <p>Export after deposit, before requesting a lease, and after each settlement. An older backup can be stale; never replace a newer pending journal. Runtime API keys stay in memory and disappear on reload. Prompts and answers stay in memory on this page.</p>
      <div className="button-row"><Button secondary disabled={busy || !store.current} onClick={() => run('Exporting your wallet…', async () => { setBackup(await store.current.backup()); setStatus('Copy the export to a safe place. It contains your note secrets.'); })}>Export / copy backup</Button></div>
      {backup && <><label htmlFor="zk-export">Wallet export — keep it secret</label><textarea id="zk-export" readOnly value={backup} rows={5} onFocus={e => e.target.select()} /><Button secondary disabled={busy} onClick={() => run('Copying your wallet…', async () => { await navigator.clipboard.writeText(backup); setBackup(''); setBackedUp(true); setStatus('Backup copied. Store it somewhere safe.'); })}>Copy wallet export</Button><label className="zkapi-check"><input type="checkbox" checked={backedUp} onChange={e => setBackedUp(e.target.checked)} />I saved this export in a safe place.</label></>}
      <details><summary>Restore a wallet backup</summary><label htmlFor="zk-restore">Paste the wallet export</label><textarea id="zk-restore" value={restoreText} onChange={e => setRestoreText(e.target.value)} rows={5} spellCheck={false} /><Button secondary disabled={busy || !store.current || !restoreText || !!note || !!draft} onClick={() => run('Restoring your wallet…', async () => { await store.current.restore(restoreText); setRestoreText(''); setBackup(''); setBackedUp(false); setStatus('Wallet restored. Connect its original operator to recover any pending lease.'); })}>Restore backup</Button></details>
      {note && <p className="zkapi-data">Note {note.note_id} · {ethFromUnits(note.current_balance)} ETH remaining<br /><strong>Withdraw before {expiry}.</strong>{note.expiry_ts * 1000 <= now && ' This note has expired.'}</p>}
    </section>
    <section className="zkapi-panel" aria-labelledby="zk-deposit"><span className="eyebrow">03 / DEPOSIT</span><h2 id="zk-deposit">Fund a note</h2><p>At most $5-equivalent per note through this page, excluding gas. This is a browser cap; the vault itself has no $5 deposit limit. Gas can cost more than the note’s value.</p>
      {minimum && quote && <p>Minimum: {ethFromUnits(minimum)} ETH ({usd(usdFromUnits(minimum, quote))}) for one proof-backed lease.</p>}
      <label htmlFor="zk-amount">Deposit amount in ETH</label><input id="zk-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={!!note || !!draft || busy} />
      {amountUsd !== null && <p>Quote value: {usd(amountUsd)} · ETH gas is additional.</p>}
      <label className="zkapi-check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I understand the storage, expiry, gas and protocol risks above.</label>
      <div className="button-row"><Button disabled={!ready || !admission || !acknowledged || !!note || !!draft || amountUsd === null || amountUsd > 5} onClick={() => run('Saving the note before wallet confirmation…', async () => { const tx = await client.current.deposit(address, parseEth(amount)); setHash(tx); setBackup(''); setBackedUp(false); setStatus('Transaction submitted. Confirm it below, then export your funded note.'); })}>Deposit ETH</Button><Button secondary disabled={!ready} onClick={() => run('Checking the finalized quote…', async () => { setQuote(await client.current.quote()); setStatus('Quote refreshed.'); })}>Refresh quote</Button></div>
      {draft && <p>A saved deposit is awaiting confirmation. Keep its export. If a hash was not returned, find the transaction in your wallet’s activity; do not deposit again.</p>}
      {draft?.stage === 'prepared' && !draft.hash && <Button secondary disabled={!ready || !admission} onClick={() => run('Retrying the saved, unsent note…', async () => { setHash(await client.current.retryDeposit(address)); setStatus('Deposit submitted. Confirm it below.'); })}>Retry saved, unsent deposit</Button>}
      {(draft || note) && <><label htmlFor="zk-hash">Deposit or withdrawal transaction hash</label><input id="zk-hash" value={hash || draft?.hash || wallet?.closing?.hash || ''} onChange={e => setHash(e.target.value)} spellCheck={false} />{draft && <Button secondary disabled={!ready} onClick={() => run('Checking the deposit on Sepolia…', async () => { await client.current.recoverDeposit(hash); setHash(''); setBackup(''); setBackedUp(false); setStatus('Deposit confirmed. Export the funded note before starting a lease.'); })}>Confirm / recover deposit</Button>}</>}
    </section>
    <section className="zkapi-panel" aria-labelledby="zk-pay"><span className="eyebrow">04 / PAY AND CHAT</span><h2 id="zk-pay">Start a bounded lease</h2><p>Generate a proof in your browser’s worker and receive an inference-only Anyroute key. One chat attempt per lease, at most $1 and 300 seconds, with up to 64 output tokens. New leases stop ten minutes before note expiry. Reloading loses the runtime key; retire the saved lease to recover its signed balance.</p>
      <Button disabled={!ready || !admission || !note || !!pending || !!wallet?.closing || !backedUp || note.expiry_ts * 1000 <= now + 600000} onClick={() => run('Generating the proof and requesting a lease…', async () => { setLease(await client.current.pay()); setAnswer(null); setBackup(''); setBackedUp(false); setStatus('Lease received. Export its recovery journal before chatting.'); })}>Start lease</Button>
      {lease && <p className="zkapi-data">Cap {usd(lease.cap)} · {liveLease ? `${Math.max(0, Math.ceil((lease.expires_at * 1000 - now) / 1000))} seconds left` : 'Expired — retire / recover below'} · spend reported here {answer ? usd(answer.spend) : 'not yet reported'}</p>}
      <p>Model: Llama 3.3 70B Instruct. Anyroute and the model provider read this ordinary prompt.</p><label htmlFor="zk-prompt">Your message</label><textarea id="zk-prompt" maxLength={4000} value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} />
      <Button disabled={!ready || !liveLease || !backedUp || !prompt.trim() || !!pending?.call_attempted} onClick={() => run('Sending your message to Anyroute…', async () => { setAnswer(await client.current.chat(MODEL, prompt)); setStatus('Answer received. Retire the lease to settle its actual spend.'); })}>Send message</Button>
      {answer && <div className="zkapi-answer"><p>{answer.text}</p>{answer.receipt && <a className="inline-link" href={'/verify/?r=' + encodeURIComponent(answer.receipt)}>Check the signed receipt</a>}</div>}
    </section>
    <section className="zkapi-panel" aria-labelledby="zk-close"><span className="eyebrow">05 / CLOSE</span><h2 id="zk-close">Settle, then withdraw</h2><p>Retirement stops use of the key. The Rust wallet verifies the signed successor and charge before changing your note. Pending settlement keeps the recovery journal. A signed balance is not an on-chain payout.</p>
      <Button secondary disabled={!ready || !pending} onClick={() => run('Retiring the lease and checking its successor…', async () => { setLease(null); const result = await client.current.retire(); setBackup(''); setBackedUp(false); setStatus(`Signed successor checked. Charge ${ethFromUnits(result.charge)} ETH. Export the updated note before withdrawal.`); })}>Retire / recover lease</Button>
      <label htmlFor="zk-destination">Withdraw to this Sepolia address</label><input id="zk-destination" value={destination} onChange={e => setDestination(e.target.value)} spellCheck={false} />
      <p>Sending to your funding address links those transactions. Your browser wallet pays the withdrawal gas. Check the full destination before signing.</p>
      <div className="button-row"><Button disabled={!ready || !note || !!pending || !!wallet?.closing || !backedUp || note.expiry_ts * 1000 <= now} onClick={() => run('Checking clearance and generating the withdrawal proof…', async () => { const tx = await client.current.withdraw(address, destination); setHash(tx); setStatus('Withdrawal submitted. Confirm it before clearing the browser note.'); })}>Withdraw remaining ETH</Button><Button secondary disabled={!ready || !note || !!pending} onClick={() => run('Checking the withdrawal on Sepolia…', async () => { await client.current.recoverClose(hash); setHash(''); setBackup(''); setBackedUp(false); setStatus('Withdrawal confirmed and the note is closed on-chain.'); })}>Confirm / recover withdrawal</Button></div>
    </section>
    <div className="zkapi-status" aria-live="polite" aria-atomic="true">{busy && <p>Working… keep this tab open.</p>}{status && <p>{status}</p>}{error && <p role="alert">{error}</p>}</div>
  </div>;
}
