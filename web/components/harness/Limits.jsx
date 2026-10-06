"use client";
import { useMemo, useState, useSyncExternalStore } from 'react';
import { api, streamChat } from '../../lib/api';
import { createHarnessLimits } from '../../lib/harness-limits';
import { formatUsd, picoUsd } from '../../lib/agents';
import { CHAT_KEY, LIMIT_WORDS as W, limitsFromChat } from '../../lib/spending-limits';
import SpendingLimits, { LimitField, LimitGroup } from '../limits/SpendingLimits';
import { Button } from '../UI';
import s from './Limits.module.css';

export function useHarnessLimits() {
  const controller = useMemo(() => createHarnessLimits({ request: api, stream: streamChat,
    storage: { getItem: key => { try { return sessionStorage.getItem(key); } catch { return null; } },
      setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) } }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  return { ...controller, state };
}

// U102: the shared spending limits editor, on a tab-scoped chat key. The router enforces; this panel only maps fields.
export default function Limits({ limits, signedIn, busy, onStop }) {
  const { session } = limits.state;
  return <details id="chat-limits" className={s.limits}>
    <summary>{W.title} <span>{session ? 'On' : 'Off'}</span></summary>
    <ChatLimits key={session?.id || (session ? 'blocked' : 'new')} limits={limits} signedIn={signedIn} busy={busy} onStop={onStop}/>
  </details>;
}

function ChatLimits({ limits, signedIn, busy, onStop }) {
  const { session, busy: changing } = limits.state;
  const [form, setForm] = useState(() => limitsFromChat(session));
  const [error, setError] = useState('');
  const run = async fn => { setError(''); try { await fn(); } catch (e) { setError(e.message); } };
  const stop = { stopped: !!session?.stopped && (!session.stopped_until || Date.parse(session.stopped_until) > Date.now()), until: session?.stopped_until, ready: !!session?.ready, busy: changing,
    onStop: (_reason, until) => { onStop(); run(() => limits.stop(until)); }, onResume: () => run(limits.resume) };
  const field = (name, label, max, help) => <LimitField id={`chat-${name}`} label={label} help={help}><input id={`chat-${name}`} type="number" min={name === 'minutes' ? 1 : 0} max={max} step={name === 'minutes' ? 1 : 'any'} inputMode="decimal" required value={form[name]} onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))}/></LimitField>;
  return <div className={s.panel}>
    <p>Apply spending limits to chat in this browser tab, across its models and conversations. Calls use the same account balance and signed receipts.</p>
    <p>The router enforces the limits through a dedicated child key. It inherits the creating key’s restrictions. Its key stays in this tab’s session storage, like your sign-in key. Anyone with access to this tab can use it.</p>
    {session && !session.ready && <p>Chat is blocked until this session is revoked.</p>}
    <SpendingLimits id="chat" compact setups="chat" value={form} onChange={setForm} disabled={changing || (!!session && !session.ready)} stop={stop}>
      {(!session || session.ready) && <LimitGroup title="This chat key" disabled={changing}>
        {session ? <p>Total for this chat key: ${session.budget_usd}. Expires {new Date(session.expires_at).toLocaleString()}.</p> : <>
          {field('total', 'Total for this chat key ($)', CHAT_KEY.total, 'Total across all chats until this chat key expires.')}
          {field('minutes', 'Expire after (minutes)', CHAT_KEY.minutes, '1 to 1440 minutes; cannot outlive your account key.')}
        </>}
      </LimitGroup>}
    </SpendingLimits>
    {session ? <>
      <div className={s.actions}>
        <Button disabled={changing || !session.ready} onClick={() => run(() => limits.update(form))}>{W.save}</Button>
        <Button secondary disabled={changing} onClick={() => { onStop(); run(limits.remove); }}>{W.remove}</Button>
      </div>
      <p>See and stop “Chat in this browser” on <a href="/agents/">Agents</a>. The chat key’s total and expiry are fixed; remove spending limits to choose new ones.</p>
      <p>Remove spending limits revokes this chat key, then switches chat back to your account key. Sign out also revokes it. Closing the tab does not revoke it; it expires at the time above.</p>
    </> : <>
      <Button disabled={!signedIn || busy || changing} onClick={() => run(() => limits.enable(form))}>{changing ? 'Saving…' : 'Create chat key and save spending limits'}</Button>
      <p>{signedIn ? 'Requires a management or owner/admin key.' : 'Sign in to create a chat key with these limits.'}</p>
    </>}
    {(error || limits.state.error) && <p role="alert" className={s.error}>{error || limits.state.error}</p>}
  </div>;
}

export function ReplyApproval({ limits, messageId }) {
  const [changing, setChanging] = useState(false);
  const row = limits.state.approvals.find(a => a.messageId === messageId);
  if (!row) return null;
  const decide = async action => { setChanging(true); try { await limits.decide(messageId, action); } catch { /* controller exposes the failure */ } finally { setChanging(false); } };
  return <section className={s.approval} aria-label="Reply approval" aria-live="polite">
    <p><b>Approve this reply?</b> The router paused {row.model} under your spending limits. Approval expires {new Date(row.expires_at).toLocaleTimeString()} and is single use.</p>
    {row.max_cost_pico != null && <p>Maximum estimated cost: {formatUsd(picoUsd(row.max_cost_pico))}.</p>}
    <div className={s.actions}><Button disabled={changing} onClick={() => decide('approve')}>Approve and send</Button><Button secondary disabled={changing} onClick={() => decide('deny')}>Deny</Button></div>
    <p>You can also decide on <a href="/agents/">Agents</a> or Telegram if linked. This tab checks the same approval and resumes once approved.</p>
    {limits.state.error && <p role="alert" className={s.error}>{limits.state.error}</p>}
  </section>;
}
