'use client';
import { useEffect, useRef, useState } from 'react';
import { loadKey } from '../../lib/api.js';
import { accountPoller } from '../../lib/account-poller.js';
import { observeAccountKey } from '../account/useAccountKey.js';
import { BalanceLink, BellButton } from './AccountTrigger.js';
import AccountDrawer from './AccountDrawer';
import s from './AccountStrip.module.css';
// U105: your balance and a bell on every page while a key is connected in this tab. Signed out: renders nothing, requests nothing.
export default function AccountStrip() {
  const [key, setKey] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [open, setOpen] = useState(false);
  const bell = useRef(null);
  useEffect(() => {
    const stop = observeAccountKey(setKey);
    // Chat connects and disconnects without the account event: re-read this tab's key when the visitor comes back (no request).
    const recheck = () => setKey(loadKey());
    window.addEventListener('focus', recheck); document.addEventListener('visibilitychange', recheck);
    return () => { stop(); window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck); };
  }, []);
  useEffect(() => {
    setSnapshot(null); setOpen(false);
    if (!key) return;
    return accountPoller(key).subscribe(setSnapshot);
  }, [key]);
  // Focus goes back to the bell once the drawer has left the page (while it is open, the rest of the page is inert).
  const wasOpen = useRef(false);
  useEffect(() => { if (wasOpen.current && !open) bell.current?.focus(); wasOpen.current = open; }, [open]);
  if (!key || snapshot?.fatal) return null;
  const close = () => setOpen(false);
  return <div className={s.strip}>
    <BalanceLink snapshot={snapshot} className={s.balance}/>
    <BellButton snapshot={snapshot} open={open} onClick={() => setOpen(true)} buttonRef={bell} className={s.bell} badgeClass={s.badge}/>
    {open && <AccountDrawer key={key} apiKey={key} snapshot={snapshot} onClose={close}/>}
  </div>;
}
