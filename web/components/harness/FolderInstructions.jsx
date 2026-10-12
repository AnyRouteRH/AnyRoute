"use client";
// G157: bridge the current chat from the existing history shell.
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { activeFolder, MAX_FOLDER_INSTRUCTIONS } from '../../lib/folder-instructions.js';
import s from './FolderInstructions.module.css';

const Folder = createContext(null);
export function FolderInstructionsProvider({ scope, onScope, children }) {
  return <Folder.Provider value={{ scope, onScope }}>{children}</Folder.Provider>;
}
export function FolderInstructionsBridge({ history, chatId, revision, onChange }) {
  const context = useContext(Folder);
  const change = useRef(onChange); change.current = onChange;
  const publish = context?.onScope;
  useEffect(() => {
    publish?.(history?.unlocked ? { history, chatId, refresh: () => change.current() } : null);
  }, [history, chatId, revision, publish]);
  useEffect(() => () => publish?.(null), [publish]);
  return null;
}
export const useCurrentFolderInstructions = () => activeFolder(useContext(Folder)?.scope)?.instructions || '';

export function FolderInstructionsEditor({ folder, onSave, disabled, chip = false }) {
  const [open, setOpen] = useState(false), [text, setText] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const id = useId(), field = useRef(null), trigger = useRef(null);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  const close = () => { setOpen(false); setText(''); setError(''); trigger.current?.focus(); };
  return <div className={s.root}>
    <button ref={trigger} type="button" className={chip ? s.chip : 'text-button'} disabled={disabled || pending} aria-expanded={open} aria-controls={`${id}-editor`} onClick={() => { if (open) close(); else { setText(folder.instructions || ''); setError(''); setOpen(true); } }}>{chip ? 'Folder instructions on' : 'Instructions'}</button>
    {open && <div className={s.editor} id={`${id}-editor`} role="group" aria-label={`Instructions for ${folder.name}`}>
      <label htmlFor={`${id}-text`}>Instructions for {folder.name}</label>
      <p>Apply to every chat in this folder, before its own system prompt. Changes apply from the next message.</p>
      <textarea ref={field} id={`${id}-text`} rows={6} value={text} maxLength={MAX_FOLDER_INSTRUCTIONS} disabled={disabled || pending} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); close(); } }} />
      <small>{text.length.toLocaleString()} / 4,000 characters · Clear the text to turn instructions off.</small>
      {error && <p role="alert">{error}</p>}
      <div className={s.actions}>
        <button type="button" className="text-button" disabled={disabled || pending} onClick={async () => {
          setPending(true); setError('');
          try { await onSave(text); close(); } catch (e) { setError(e?.message || 'Instructions could not be saved.'); }
          finally { setPending(false); }
        }}>{pending ? 'Saving…' : 'Save instructions'}</button>
        <button type="button" className="text-button" disabled={pending} onClick={close}>Cancel</button>
      </div>
    </div>}
  </div>;
}
export function FolderInstructionsChip({ busy }) {
  const context = useContext(Folder), folder = activeFolder(context?.scope);
  if (!folder?.instructions?.trim()) return null;
  return <FolderInstructionsEditor key={folder.id} folder={folder} chip disabled={busy} onSave={async text => {
    await context.scope.history.setFolderInstructions(folder.id, text);
    context.scope.refresh();
  }} />;
}
