'use client';
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import DepositProgress from './DepositProgress';
import DepositNextLine from './DepositNextLine';
import TrackDeposit from './TrackDeposit';
import { depositSender } from '../../lib/deposit-progress.js';
import { depositWaitText } from '../../lib/fast-credit.js';
import { api } from '../../lib/api.js';
import { connect, ensureChain, sendTransactions } from '../../lib/wallet.js';
import { fundingAmount, fundingOptions, fundingState, initialFunding, escrowFundingTransaction, validateCreditsTransactions } from '../../lib/add-funds.js';
import { defaultFundingOption } from '../../lib/funding-display.js'; // V96
import { FundingQuote } from './FundingDetails.js'; // V96
import { ANYR_CA } from '../ContractAddress';
import { Button, CopyButton } from '../UI';
import s from './AddFunds.module.css';

// ON1: reuse the router's deposit instructions and the existing wallet sender.
export default function AddFunds({ apiKey, balance, force = false, onBalance, onResume, disabled = false, showProgress = true }) {
  const [state, dispatch] = useReducer(fundingState, initialFunding);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState('');
  const [amount, setAmount] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const id = useId();
  const alive = useRef(false);
  const callbacks = useRef({ onBalance }); callbacks.current = { onBalance };
  const previous = useRef(balance);
  const eligible = !!apiKey && (force || balance != null && Number(balance) === 0);
  const tracking = data?.credits?.fast_credit?.enabled && state.phase === 'credited' || eligible || state.baseline != null && state.phase !== 'credited';
  useEffect(() => {
    if (!tracking) return;
    alive.current = true;
    const ac = new AbortController(); let timer;
    const read = async () => {
      try {
        const [credits, escrow, stock, status] = await Promise.all([
          api('/api/v1/credits', { key: apiKey, signal: ac.signal }), api('/api/v1/escrow', { signal: ac.signal }),
          api('/api/v1/escrow/deposits', { key: apiKey, signal: ac.signal }), api('/api/v1/status', { signal: ac.signal }),
        ]);
        if (ac.signal.aborted) return;
        const next = { credits: credits.data, escrow: escrow.data, stock: stock.data, chain: status.data?.chain, usdgEscrow: status.data?.escrow?.usdg };
        setData(next); setReadError('');
        const available = next.credits.available;
        dispatch({ type: 'observed', balance: available, total: next.credits.total_credits, fastCredit: next.credits.fast_credit });
        if (available != null && Number(available) !== Number(previous.current)) { previous.current = available; await callbacks.current.onBalance?.(available); }
      } catch (e) { if (!ac.signal.aborted) setReadError(e.message || 'Could not refresh funding details.'); }
      if (!ac.signal.aborted) timer = setTimeout(read, 5000);
    };
    read();
    return () => { alive.current = false; ac.abort(); clearTimeout(timer); };
  }, [apiKey, tracking]);
  const options = fundingOptions({ ...data, officialAnyr: ANYR_CA });
  const option = options.find(item => item.id === selected) || defaultFundingOption(options, ANYR_CA);
  const available = data?.credits?.available ?? balance;
  const pending = state.phase === 'pending';
  if (!eligible && !['pending', 'credited'].includes(state.phase)) return showProgress ? <DepositProgress apiKey={apiKey}/> : null;
  if (state.phase === 'dismissed') return <>{showProgress && <DepositProgress apiKey={apiKey}/>}<div className={s.reminder}>Your balance is ${Number(available || 0).toFixed(2)}. <button type="button" className="text-button" onClick={() => dispatch({ type: 'open' })}>Add funds{force ? ' to send this' : ''}</button>{onResume && Number(available) > 0 && <Button type="button" disabled={disabled} onClick={onResume}>Send now</Button>}</div></>;
  async function send() {
    setBusy(true); setError(''); let waiting = false;
    try {
      const raw = fundingAmount(amount, option);
      const from = await connect();
      const txs = option.kind === 'escrow' ? [escrowFundingTransaction(amount, option, from)] : validateCreditsTransactions((await api('/api/v1/credits/deposit-tx', { key: apiKey, method: 'POST', body: { amount } })).data, option, raw);
      await ensureChain({ id: data.chain.chain_id, name: 'Robinhood Chain', rpc: data.chain.public_rpc, explorer: data.chain.explorer });
      await sendTransactions(from, txs, depositSender(apiKey, option.kind === 'escrow' ? 'escrow' : 'usdg', status => { waiting ||= /waiting for confirmation/i.test(status); if (alive.current) dispatch({ type: 'pending', total: Number(data.credits.total_credits), status }); }));
      if (alive.current) dispatch({ type: 'pending', total: Number(data.credits.total_credits), status: 'Transaction sent. Follow the observed amount and credit status below.' });
    } catch (e) {
      if (alive.current) { setError(e.message); dispatch(waiting && !/failed on-chain/i.test(e.message) ? { type: 'pending', total: Number(data.credits.total_credits), status: 'Check your wallet transaction. Watching for credits; do not send again while it is pending.' } : { type: 'failed' }); }
    } finally { if (alive.current) setBusy(false); }
  }
  return <section className={s.card} aria-label={force ? 'Add funds to send this' : 'Add funds'}>
    <div className={s.heading}><h3>{force ? 'Add funds to send this' : Number(available) === 0 ? 'Your balance is $0. Add funds.' : 'Add funds'}</h3><button type="button" className="text-button" disabled={busy || pending} onClick={() => dispatch({ type: 'dismiss' })}>Dismiss</button></div>
    <p>Choose what to send on Robinhood Chain · chain ID 4663. Your wallet shows each transaction before you confirm.</p>
    {readError && <p className="error" role="alert">{readError} Funding status is unknown; the next refresh will try again.</p>}
    {!data && <p role="status">Reading deposit instructions…</p>}
    {data?.credits?.session && <p>This session uses its owner’s balance and its own spending cap. Ask the owner to add funds or update the session budget.</p>}
    {data && !data.credits?.session && options.length === 0 && <p>No deposit route is available for this key on Robinhood Chain. <a className="inline-link" href="/dashboard/#payments">Open Payments to inspect your account.</a> Escrow deposits require signing in with the sending wallet.</p>}
    {option && <>
      <div className={s.fields}><div><label htmlFor={id + '-token'}>Send token</label><select id={id + '-token'} value={option.id} disabled={busy || pending} onChange={e => { setSelected(e.target.value); setAmount('10'); setError(''); }}>{options.map(item => <option key={item.id} value={item.id}>{item.label || item.symbol}</option>)}</select></div><div><label htmlFor={id + '-amount'}>Amount in {option.symbol}</label><input id={id + '-amount'} inputMode="decimal" value={amount} disabled={busy || pending} onChange={e => setAmount(e.target.value)} /></div></div>
      <dl><div><dt>Send</dt><dd>{amount || '0'} {option.symbol}</dd></div><div><dt>Token address</dt><dd><code>{option.address}</code></dd></div><div><dt>{option.kind === 'escrow' ? 'Escrow address' : 'Credits contract'}</dt><dd><code>{option.to}</code></dd></div>{option.keyHash && <div><dt>Key hash</dt><dd><code>{option.keyHash}</code></dd></div>}{option.wallet && <div><dt>Send from</dt><dd><code>{option.wallet}</code></dd></div>}</dl>
      <FundingQuote option={option} amount={amount} />
      {option.kind === 'credits' ? <p>Approve {amount} USDG to the Credits contract, then call deposit with this key hash and {amount} USDG (6 decimals). Two wallet transactions. Do not transfer USDG directly to the contract.</p> : <p>{option.note && `${option.note} `}One token transfer from the wallet above. Other senders receive the credits in their own accounts. {depositWaitText(data.escrow.fast_credit)} Tokens stay in escrow.</p>}
      <div className={s.actions}><Button type="button" disabled={busy || pending || !!readError || option.kind === 'escrow' && !(option.credit_usd_per_token > 0)} onClick={send}>{busy ? 'Confirm in your wallet…' : pending ? 'Waiting for confirmation…' : 'Add funds with wallet'}</Button><CopyButton text={option.to} label={option.kind === 'escrow' ? 'Copy escrow address' : 'Copy contract address'}/></div>
      <DepositNextLine info={option.kind === 'escrow' ? data.escrow : data.credits} lane={option.kind === 'escrow' ? 'escrow' : 'usdg'}/>
      <TrackDeposit apiKey={apiKey} lane={option.kind === 'escrow' ? 'escrow' : 'usdg'}/>
    </>}
    {showProgress && <DepositProgress apiKey={apiKey}/>}
    {state.status && <p className={s.status} role="status" aria-live="polite">{state.status}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {onResume && Number(available) > 0 && <Button type="button" disabled={disabled || busy} onClick={onResume}>Send now</Button>}
    <p className={s.links}><a className="inline-link" href="/docs/#get-usdg">How do I get USDG?</a> · <a className="inline-link" href="/dashboard/#payments">See all payment options</a></p>
  </section>;
}
