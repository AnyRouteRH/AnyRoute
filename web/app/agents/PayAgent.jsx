'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/UI';
import { api } from '../../lib/api';
import { decisionText, reasonText } from '../../lib/agents';
import { directoryPath } from '../../lib/agent-profiles';
import { connect, ensureChain, hasWallet, sendTransactions, shortAddress } from '../../lib/wallet';
import { CUSTODY, PAY_OFF, PAY_UNREAD, agentRequest, askPay, checkReceipt, confirmPay, instructionRows, isTxHash, memoDigest, payBody, payState, payees, readPayment, receiptRows, senderProblem } from '../../lib/agent-pay';
import s from './starters.module.css';

function Rows({ rows }) {
  return <dl className={s.settings}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

// Pay another agent: the selected agent's rulebook decides, the payer's own wallet sends, the router checks and signs.
export default function PayAgent({ agent }) {
  const [state, setState] = useState('loading');
  useEffect(() => {
    const ac = new AbortController();
    api('/api/v1/status', { signal: ac.signal }).then(r => { if (!ac.signal.aborted) setState(payState(r.data)); }).catch(() => { if (!ac.signal.aborted) setState('unknown'); });
    return () => ac.abort();
  }, []);
  return <section className="control-panel" id="pay-agent" aria-labelledby="pay-agent-title">
    <h2 id="pay-agent-title">Pay another agent</h2>
    <p className="help-text">{CUSTODY}</p>
    {state === 'loading' && <p role="status">Reading whether paying another agent is switched on…</p>}
    {state === 'off' && <p role="status">{PAY_OFF} <a className="inline-link" href="/docs/#agent-pay">How it works</a></p>}
    {state === 'unknown' && <p role="status">{PAY_UNREAD}</p>}
    {state === 'on' && (agent ? <PayForm key={agent.key_hash} agent={agent}/> : <p className="note">Select an agent after connecting. Its rulebook decides each payment.</p>)}
  </section>;
}

function PayForm({ agent }) {
  const [secret, setSecret] = useState('');
  const [mode, setMode] = useState('directory');
  const [tag, setTag] = useState(''), [found, setFound] = useState(null), [chosen, setChosen] = useState(null);
  const [wallet, setWallet] = useState(''), [amount, setAmount] = useState(''), [memo, setMemo] = useState('');
  const [decision, setDecision] = useState(null), [payment, setPayment] = useState(null), [txHash, setTxHash] = useState(''), [valid, setValid] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [step, setStep] = useState('');
  const sent = useRef(null);
  const reset = () => { setDecision(null); setPayment(null); setTxHash(''); setValid(null); setError(''); setStep(''); sent.current = null; };
  const run = async (name, work) => { setBusy(name); setError(''); try { await work(); } catch (e) { setError(e?.message || 'That did not work. Try again.'); } finally { setBusy(''); } };
  const send = () => agentRequest(agent.key_hash, secret);

  const search = e => { e.preventDefault(); return run('search', async () => { setChosen(null); setFound(payees(await api(directoryPath(tag)))); }); };
  const ask = e => {
    e?.preventDefault?.();
    return run('ask', async () => {
      const to = mode === 'directory' ? chosen?.id : wallet;
      const memoSha256 = await memoDigest(memo);
      const { body, errors } = payBody({ to, amount, memoSha256, approvalId: decision?.decision === 'approval_required' ? decision.approval_id : undefined });
      if (errors.length) throw new Error(errors.join(' '));
      const request = await send();
      const next = await askPay(request, body);
      setPayment(null); setTxHash(''); setValid(null); setDecision(next); sent.current = request;
    });
  };
  const fromWallet = () => run('wallet', async () => {
    const p = decision.payment;
    const address = await connect();
    const problem = senderProblem(address, p.from);
    if (problem) throw new Error(problem);
    await ensureChain({ id: p.chain_id, name: p.chain_name, rpc: p.rpc_url, explorer: p.explorer_url });
    const [hash] = await sendTransactions(address, [{ to: p.transfer_call.to, data: p.transfer_call.data, description: `Send ${p.amount} USDG to ${shortAddress(p.to)}` }], text => setStep(text));
    setTxHash(hash); setStep('Sent from your wallet. Confirm it below.');
  });
  const confirm = e => { e.preventDefault(); return run('confirm', async () => { if (!isTxHash(txHash)) throw new Error('Paste the 0x transaction hash of your USDG transfer.'); setValid(null); setPayment(await confirmPay(sent.current || await send(), decision.decision_id, txHash)); }); };
  const refresh = () => run('refresh', async () => { setValid(null); setPayment(await readPayment(sent.current || await send(), payment.decision_id)); });
  const verify = () => run('verify', async () => setValid(await checkReceipt(api, payment.receipt)));

  const fields = mode === 'directory'
    ? <><div className="field"><label htmlFor="pay-tag">Search the directory by capability</label><input id="pay-tag" maxLength={40} value={tag} onChange={e => setTag(e.target.value)}/></div>
      <Button type="button" secondary disabled={!!busy} onClick={search}>{busy === 'search' ? 'Searching…' : 'Search'}</Button>
      {found && !found.length && <p className="help-text">No agent in these results publishes a wallet for payments.</p>}
      {found?.length > 0 && <div role="radiogroup" aria-label="Agents that publish a wallet">{found.map(p => <p key={p.id}><label className="check-label"><input type="radio" name="pay-payee" checked={chosen?.id === p.id} onChange={() => { reset(); setChosen(p); }}/>{p.name} · {shortAddress(p.wallet)}</label></p>)}</div>}
      {chosen && <p className="help-text">Paying {chosen.name} at {chosen.wallet} (profile {chosen.id}).</p>}</>
    : <div className="field"><label htmlFor="pay-wallet">Recipient wallet (0x…)</label><input id="pay-wallet" spellCheck={false} autoComplete="off" maxLength={42} value={wallet} onChange={e => { reset(); setWallet(e.target.value); }}/></div>;
  const errorLine = error && <p role="alert" className="error">{error}</p>;
  const errorAt = payment ? 'payment' : decision?.payment ? 'confirm' : 'form';

  return <>
    <form onSubmit={ask}>
      <fieldset className={s.fieldset} disabled={!!busy}><legend>Who and how much</legend>
        <div className="field"><label htmlFor="pay-agent-key">Selected agent’s API key</label><input id="pay-agent-key" type="password" autoComplete="off" spellCheck={false} required value={secret} onChange={e => { reset(); setSecret(e.target.value); }}/><p className="help-text">Kept in memory on this page. The rulebook of {agent.name || 'this agent'} decides; the connected management key is never used instead.</p></div>
        <div className="button-row" role="radiogroup" aria-label="Recipient">{[['directory', 'An agent in the directory'], ['wallet', 'A wallet address']].map(([value, label]) => <label key={value} className="check-label"><input type="radio" name="pay-mode" checked={mode === value} onChange={() => { reset(); setMode(value); }}/>{label}</label>)}</div>
        {fields}
        <div className="two-fields"><div className="field"><label htmlFor="pay-amount">Amount (USDG)</label><input id="pay-amount" inputMode="decimal" autoComplete="off" required value={amount} onChange={e => { reset(); setAmount(e.target.value); }}/></div>
          <div className="field"><label htmlFor="pay-memo">Memo (optional)</label><input id="pay-memo" autoComplete="off" maxLength={500} value={memo} onChange={e => { reset(); setMemo(e.target.value); }}/><p className="help-text">Only its SHA-256 leaves this page.</p></div></div>
      </fieldset>
      <Button type="submit" disabled={!!busy}>{busy === 'ask' ? 'Asking…' : decision?.decision === 'approval_required' ? 'Check again' : 'Ask the rulebook'}</Button>
    </form>
    {errorAt === 'form' && errorLine}
    {decision && <div className={s.result} role="status">
      <strong>{decisionText(decision.decision)}</strong>
      {decision.reasons?.length > 0 && <ul>{decision.reasons.map((r, i) => <li key={i}>{reasonText(r)}</li>)}</ul>}
      {decision.decision === 'approval_required' && <p>Waiting for approval. Approve it under Approvals on this page or in linked Telegram, then check again with the same recipient and amount.</p>}
      {decision.decision === 'deny' && <p>Nothing to send. Change the recipient or amount, or the rulebook, and ask again.</p>}
      {decision.payment && !payment && <>
        <p>Send exactly this from a wallet linked to the account, then confirm with the transaction hash.</p>
        <Rows rows={instructionRows(decision.payment)}/>
        {decision.payment.warning && <p role="alert">{decision.payment.warning}</p>}
        <div className="button-row">{hasWallet() && <Button type="button" secondary disabled={!!busy || !decision.payment.from?.length} onClick={fromWallet}>{busy === 'wallet' ? 'Waiting for wallet…' : 'Send from my wallet'}</Button>}</div>
        {step && <p role="status">{step}</p>}
        <form onSubmit={confirm}><div className="field"><label htmlFor="pay-tx">Transaction hash</label><input id="pay-tx" spellCheck={false} autoComplete="off" maxLength={66} value={txHash} onChange={e => setTxHash(e.target.value)}/></div>
          <Button type="submit" disabled={!!busy}>{busy === 'confirm' ? 'Checking…' : 'Confirm payment'}</Button></form>
        {errorAt === 'confirm' && errorLine}
      </>}
    </div>}
    {payment && <div className={s.result} role="status">
      <strong>{payment.status_text}</strong>
      <Rows rows={receiptRows(payment)}/>
      <div className="button-row"><Button type="button" secondary disabled={!!busy} onClick={refresh}>{busy === 'refresh' ? 'Reading…' : 'Refresh status'}</Button>{payment.receipt && <Button type="button" secondary disabled={!!busy} onClick={verify}>{busy === 'verify' ? 'Checking…' : 'Check the signature'}</Button>}</div>
      {errorAt === 'payment' && errorLine}
      {valid !== null && <p>{valid ? 'Signature valid: signed by Anyroute’s published receipt key.' : 'Signature not valid.'}</p>}
      {payment.receipt && <details className={s.details}><summary>Signed receipt JSON</summary><pre className={s.json}>{JSON.stringify(payment.receipt, null, 2)}</pre></details>}
    </div>}
  </>;
}
