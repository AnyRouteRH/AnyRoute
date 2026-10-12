"use client";
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '../UI';
import { CHAT_CAP_PRESETS, capDollars, createCapGuard, parseCap, readDefaultCap, validCap, writeDefaultCap } from '../../lib/chat-cap.js';
import s from './ChatCap.module.css';

const CapContext = createContext(null);
export const ChatCapProvider = CapContext.Provider;
export function useChatCap({ lanes, setLanes, draft, files, settings, system, key, privateMode }) {
  const [defaultCap, setDefaultCap] = useState(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(null);
  const [editor, setEditor] = useState(null);
  const [storageNote, setStorageNote] = useState('');
  const guard = useRef(null);
  guard.current ??= createCapGuard();
  const cap = validCap(lanes[0]?.spendingCap) ? lanes[0].spendingCap : null;
  useEffect(() => { try { setDefaultCap(readDefaultCap(window.localStorage)); } catch { setDefaultCap(null); } setReady(true); }, []);
  useEffect(() => {
    if (ready && lanes.some(lane => lane.spendingCap === undefined)) setLanes(current => current.map(lane => ({ ...lane, spendingCap: current[0]?.spendingCap === undefined ? defaultCap : current[0].spendingCap })));
  }, [ready, lanes, defaultCap, setLanes]);
  useEffect(() => { setPending(null); }, [lanes, draft, files, settings, system, key, privateMode]);
  const updateCap = value => { setLanes(current => current.map(lane => ({ ...lane, spendingCap: value }))); setPending(null); setEditor(null); };
  return {
    cap, defaultCap, pending, editor, storageNote, ready,
    check: (requests, resume) => guard.current.check(lanes, cap, requests, resume, setPending),
    reset: () => { setLanes(current => current.map(lane => ({ ...lane, spendingCap: defaultCap }))); setPending(null); },
    open: mode => setEditor(mode), close: () => setEditor(null),
    save: value => {
      if (editor !== 'default') return updateCap(value);
      setDefaultCap(value);
      let saved = false; try { saved = writeDefaultCap(window.localStorage, value); } catch {}
      setStorageNote(saved ? '' : 'This browser cannot save the default. It lasts for this visit.');
      setEditor(null);
    },
    sendAnyway: () => { if (!pending) return; setPending(null); guard.current.sendAnyway(pending.resume); },
  };
}

// Wrap the existing running cost chip; saved-history rows keep their original rendering.
export function ChatCapCost({ children, control, busy }) {
  return <div className={s.cost}><button type="button" className={s.chip} disabled={busy || !control.ready} aria-label="Set this chat’s spending cap" aria-haspopup="dialog" onClick={() => control.open('chat')}>
    {children}<span>{control.cap ? `Stop this chat at $${capDollars(control.cap)}` : 'Set a chat cap'}</span>
  </button></div>;
}
export function ChatCapSettings() {
  const control = useContext(CapContext);
  if (!control) return null;
  return <section className={s.settings} aria-label="Chat settings"><h3>Chat settings</h3><p>Default cap for new chats: {control.defaultCap ? `$${capDollars(control.defaultCap)}` : 'No cap'}</p>
    <Button type="button" secondary disabled={!control.ready} onClick={() => control.open('default')}>Set default cap</Button>{control.storageNote && <p role="status">{control.storageNote}</p>}
  </section>;
}
export function ChatCapNotice({ control, busy }) {
  const pending = control.pending;
  if (!pending) return null;
  return <div className={s.notice} role="alert"><p>{pending.estimate === null ? `Check this chat’s $${capDollars(pending.cap)} cap` : `This chat would pass its $${capDollars(pending.cap)} cap`}</p>
    <p>{pending.estimate === null ? 'The next request’s cost cannot be estimated.' : `Spent $${capDollars(String(pending.spent)) || '0'} · next request about $${capDollars(String(pending.estimate)) || '0'}.`} This is a browser guard. Actual charges can differ.</p>
    <div className={s.actions}><Button type="button" secondary disabled={busy} onClick={() => control.open('raise')}>Raise cap</Button><Button type="button" disabled={busy} onClick={control.sendAnyway}>Send anyway</Button></div>
  </div>;
}
export function ChatCapDialogs({ control }) {
  if (!control.editor) return null;
  return <CapEditor key={control.editor} mode={control.editor} value={control.editor === 'default' ? control.defaultCap : control.cap} onSave={control.save} onClose={control.close} />;
}
function CapEditor({ mode, value, onSave, onClose }) {
  const [amount, setAmount] = useState(capDollars(value));
  const [error, setError] = useState('');
  const save = value => {
    if (mode === 'raise' && value !== null && BigInt(value) <= BigInt(valueOfCap)) return setError('Choose an amount above the current cap.');
    onSave(value);
  };
  const valueOfCap = value || '0';
  return <Modal title={mode === 'default' ? 'Default cap for new chats' : mode === 'raise' ? 'Raise this chat’s cap' : 'Stop this chat at an amount'} onClose={onClose}>
    <div className={s.editor}><p>{mode === 'default' ? 'New chats inherit this amount. Existing chats keep their own caps.' : 'Hold a send when the chat’s spent total plus the next request’s estimate would pass this amount.'} Key budgets and agent rulebooks provide hard limits.</p>
      <div className={s.actions} aria-label="Cap presets">{CHAT_CAP_PRESETS.map(preset => <Button type="button" key={preset} secondary onClick={() => save(parseCap(preset))}>${preset}</Button>)}</div>
      <form onSubmit={event => { event.preventDefault(); try { save(parseCap(amount)); } catch (error) { setError(error.message); } }}>
        <label htmlFor="chat-cap-amount">Custom amount in dollars</label><input autoFocus id="chat-cap-amount" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setError(''); }} aria-describedby={error ? 'chat-cap-error' : undefined} />
        {error && <p id="chat-cap-error" role="alert">{error}</p>}<div className={s.actions}><Button type="submit">{mode === 'raise' ? 'Raise cap' : 'Save cap'}</Button><Button type="button" secondary onClick={() => save(null)}>Remove cap</Button></div>
      </form><p>Estimates include text input, expected output and a listed request fee. Image, audio, search and separate reasoning charges can add to the bill.</p>
    </div>
  </Modal>;
}
