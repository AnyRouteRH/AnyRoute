"use client";
import { useMemo, useState, useSyncExternalStore } from 'react';
import { api, streamChat } from '../../lib/api';
import { createHarnessLimits } from '../../lib/harness-limits';
import { formatUsd, picoUsd } from '../../lib/agents';
import { Button } from '../UI';
import s from './Limits.module.css';

export function useHarnessLimits() {
  const controller = useMemo(() => createHarnessLimits({ request: api, stream: streamChat,
    storage: { getItem: key => { try { return sessionStorage.getItem(key); } catch { return null; } },
      setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) } }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  return { ...controller, state };
}

export default function Limits({ limits, signedIn, busy, onStop }) {
  const [form, setForm] = useState({ session: '5', day: '', approval: '', minutes: '60' });
  const [error, setError] = useState('');
  const { session, busy: changing } = limits.state;
  const run = async fn => { setError(''); try { await fn(); } catch (e) { setError(e.message); } };
  const field = (name, label, max, hint) => <label className={s.field}>
    <span>{label}</span><input type="number" min={name === 'minutes' ? 1 : 0.000001} max={max} step={name === 'minutes' ? 1 : 'any'} inputMode="decimal" value={form[name]} onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))} required={name === 'session' || name === 'minutes'} />
    {hint && <small>{hint}</small>}
  </label>;
  return <details id="chat-limits" className={s.limits}>
    <summary>Limits <span>{session ? 'On' : 'Off'}</span></summary>
    <div className={s.panel}>
      <p>Apply spending limits to chat in this browser tab, across its models and conversations. Calls use the same account balance and signed receipts.</p>
      <p>The router enforces the limits through a dedicated child key. It inherits the creating key’s restrictions. Its key stays in this tab’s session storage, like your sign-in key. Anyone with access to this tab can use it.</p>
      {session ? <>
        <p>{session.ready ? `Session cap: $${session.budget_usd}. Expires ${new Date(session.expires_at).toLocaleString()}.` : 'Chat is blocked until this session is revoked.'}</p>
        {session.policy?.caps?.per_day_usd && <p>Rolling 24-hour cap: ${session.policy.caps.per_day_usd}.</p>}
        {session.policy?.approval && <p>Ask first above ${session.policy.approval.above_usd} per reply, based on the router’s maximum estimated cost.</p>}
        <p>See and stop “Chat in this browser” on <a href="/agents/">Agents</a>. Stop prevents the next request; work already running may still be billed.</p>
        <div className={s.actions}>
          <Button secondary disabled={changing || !session.ready} onClick={() => { onStop(); run(limits.stop); }}>Stop chat spending</Button>
          {session.stopped && <Button secondary disabled={changing} onClick={() => run(limits.resume)}>Resume</Button>}
          <Button secondary disabled={changing} onClick={() => { onStop(); run(limits.remove); }}>Remove limits</Button>
        </div>
        <p>Remove limits revokes this child key, then returns chat to your account key. Sign out also revokes it. Closing the tab does not revoke it; it expires at the time above.</p>
      </> : <>
        <div className={s.fields}>
          {field('session', 'Session cap ($)', 1000, 'Total across all chats until this child key expires.')}
          {field('day', 'Rolling 24-hour cap ($)', 1_000_000, 'Optional. Includes replies still running.')}
          {field('approval', 'Ask me first above ($ per reply)', 1_000_000, 'Optional. Approval expires after 15 minutes and is single use.')}
          {field('minutes', 'Expire after (minutes)', 1440, '1 to 1440 minutes; cannot outlive your account key.')}
        </div>
        <Button disabled={!signedIn || busy || changing} onClick={() => run(() => limits.enable(form))}>{changing ? 'Saving…' : 'Create chat key and apply limits'}</Button>
        <p>{signedIn ? 'Requires a management or owner/admin key. Remove limits before choosing new amounts.' : 'Sign in to create a chat key with these limits.'}</p>
      </>}
      {(error || limits.state.error) && <p role="alert" className={s.error}>{error || limits.state.error}</p>}
    </div>
  </details>;
}

export function ReplyApproval({ limits, messageId }) {
  const [changing, setChanging] = useState(false);
  const row = limits.state.approvals.find(a => a.messageId === messageId);
  if (!row) return null;
  const decide = async action => { setChanging(true); try { await limits.decide(messageId, action); } catch { /* controller exposes the failure */ } finally { setChanging(false); } };
  return <section className={s.approval} aria-label="Reply approval" aria-live="polite">
    <p><b>Approve this reply?</b> The router paused {row.model} under its rulebook. Approval expires {new Date(row.expires_at).toLocaleTimeString()} and is single use.</p>
    {row.max_cost_pico != null && <p>Maximum estimated cost: {formatUsd(picoUsd(row.max_cost_pico))}.</p>}
    <div className={s.actions}><Button disabled={changing} onClick={() => decide('approve')}>Approve and send</Button><Button secondary disabled={changing} onClick={() => decide('deny')}>Deny</Button></div>
    <p>You can also decide on <a href="/agents/">Agents</a> or Telegram if linked. This tab checks the same approval and resumes once approved.</p>
    {limits.state.error && <p role="alert" className={s.error}>{limits.state.error}</p>}
  </section>;
}
