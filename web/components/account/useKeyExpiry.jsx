'use client';
// C127: enhance the existing key dialog; team keys never get an expiry control.
import { createContext, useContext, useEffect, useState } from 'react';
import { expiryAllowed, expiryPatch, localExpiryDate } from '../../lib/key-expiry.js';
import { KeyExpiryFields } from './KeyExpiry.js';

export const KeyExpiryContext = createContext(null);

export function useKeyExpiry(existing, live) {
  const caller = useContext(KeyExpiryContext);
  const [choice, setChoice] = useState(existing?.expiresAt ? 'date' : 'never');
  const [date, setDate] = useState(localExpiryDate(existing?.expiresAt));
  const [changed, setChanged] = useState(false);
  const allowed = live && expiryAllowed(existing, caller);
  return {
    fields: allowed && <KeyExpiryFields choice={choice} date={date} edited={changed} current={existing?.current} onChoice={value => { setChoice(value); setChanged(true); }} onDate={value => { setDate(value); setChanged(true); }}/>,
    wrapSave: save => values => save({ ...values, ...(allowed ? expiryPatch({ choice, date, changed, existing, caller }) : {}) }),
  };
}

export function useExpiryClock(keys) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const next = Math.min(60_000, ...(keys || []).map(key => Date.parse(key.expires_at) - now + 1).filter(ms => ms > 0));
    const timer = setTimeout(update, next);
    document.addEventListener('visibilitychange', update);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, [keys, now]);
  return now;
}
