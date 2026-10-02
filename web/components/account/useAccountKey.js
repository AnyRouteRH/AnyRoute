'use client';
import { useCallback, useEffect, useState } from 'react';
import { clearKey, loadKey, saveKey } from '../../lib/api.js';
const eventName = 'anyroute-account-key';
export function storeAccountKey(value) {
  if (value) saveKey(value); else clearKey();
  window.dispatchEvent(new CustomEvent(eventName, { detail: value }));
}
export function observeAccountKey(onChange) {
  const read = event => onChange(event?.type === eventName ? event.detail : loadKey());
  read(); window.addEventListener(eventName, read);
  window.addEventListener('storage', read);
  return () => { window.removeEventListener(eventName, read); window.removeEventListener('storage', read); };
}
export function useAccountKey() {
  const [key, setKey] = useState('');
  useEffect(() => observeAccountKey(setKey), []);
  const connectKey = useCallback(value => { storeAccountKey(value); setKey(value); }, []);
  return [key, connectKey];
}
