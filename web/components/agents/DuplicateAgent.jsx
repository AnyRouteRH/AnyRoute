'use client';
// H171: the account's dialog and copy controls; the new secret stays in component memory.
import { useId, useRef, useState } from 'react';
import { Button, CopyButton, Modal } from '../UI';
import { duplicateAgent, duplicateName } from '../../lib/duplicate-agent';
import s from '../account/AccountShell.module.css';
import usePageCommand from '../commands/usePageCommand'; // J181

export default function DuplicateAgent({ agent, request, onChanged }) {
  const [open, setOpen] = useState(false), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [secret, setSecret] = useState('');
  const id = useId(), button = useRef(null);
  usePageCommand('duplicate-agent', () => { setName(duplicateName(agent.name)); setOpen(true); }, !busy, agent.key_hash); // J181
  const close = event => { if (busy) { event?.preventDefault?.(); return; } setOpen(false); setSecret(''); setError(''); button.current?.focus(); };
  return <section className="control-panel" aria-labelledby={id + '-title'}>
    <h2 id={id + '-title'}>Duplicate this agent</h2>
    <p>Start another agent with these rules and settings. It shares the account balance and has its own spending, approvals and Stop control.</p>
    <button ref={button} className="ar-button secondary" onClick={() => { setName(duplicateName(agent.name)); setOpen(true); }}>Duplicate</button>
    {open && <Modal title={secret ? 'Save your new API key' : 'Duplicate this agent'} onClose={close}>
      {secret ? <>
        <p>This secret is shown once. Keep it safe; anyone with it can use this key’s access and balance.</p>
        <code className={s.secret}>{secret}</code>
        <div className="button-row"><CopyButton text={secret} label="Copy key"/><Button onClick={close}>Done</Button></div>
      </> : <form onSubmit={async event => {
        event.preventDefault(); if (busy) return; setBusy(true); setError('');
        try {
          const result = await duplicateAgent(request, agent.key_hash, name);
          setSecret(result.key);
          onChanged?.();
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      }}>
        <div className="field"><label htmlFor={id + '-name'}>New agent name</label><input id={id + '-name'} value={name} onChange={e => setName(e.target.value)} maxLength={100} required disabled={busy} autoFocus/></div>
        <p>The current rulebook becomes its first version. Earlier versions, spend, past approvals, Stop state, rotation links, Telegram links and browser sign-ins stay with the original. A followed playbook becomes an independent rulebook.</p>
        {error && <p role="alert">{error}</p>}
        <div className="button-row"><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Duplicating…' : 'Duplicate and show secret'}</Button><Button type="button" secondary disabled={busy} onClick={close}>Cancel</Button></div>
      </form>}
    </Modal>}
  </section>;
}
