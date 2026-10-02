'use client';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useAccountKey } from './useAccountKey.js';
import useInbox from './useInbox';
import InboxTrigger from './InboxTrigger.js';
import AccountInbox from './AccountInbox';
import s from './Inbox.module.css';
function InboxDialog({ apiKey, onClose }) {
  const dialog = useRef(null);
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close(); }, []);
  return createPortal(<dialog ref={dialog} className={`modal ${s.dialog}`} aria-labelledby="inbox-panel-title" onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-head"><h2 id="inbox-panel-title">Inbox</h2><button className="icon-button" aria-label="Close inbox" onClick={onClose}>×</button></div><AccountInbox apiKey={apiKey} panel/></dialog>, document.body);
}
export default function InboxBell() {
  const [apiKey] = useAccountKey();
  const { page, error } = useInbox(apiKey);
  const [open, setOpen] = useState(false);
  const button = useRef(null);
  useEffect(() => setOpen(false), [apiKey]);
  if (!apiKey) return null;
  const count = page?.count;
  const close = () => { setOpen(false); button.current?.focus(); };
  return <><InboxTrigger connected={!!apiKey} count={count} error={error} open={open} onClick={() => setOpen(true)} buttonRef={button} className={s.bell} badgeClass={s.badge}/>{open && <InboxDialog key={apiKey} apiKey={apiKey} onClose={close}/>}</>;
}
