'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { readFirstCall } from '../../lib/first-call.js';
export default function useFirstCall(apiKey, initial, revision = 0) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!apiKey) return;
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState === 'hidden') return;
      reading = true;
      try {
        const snapshot = await readFirstCall(apiKey, api, controller.signal);
        if (!controller.signal.aborted) setState({ key: apiKey, snapshot });
      } finally { reading = false; }
    };
    read();
    const timer = setInterval(read, 15000);
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read); };
  }, [apiKey, revision, initial]);
  return apiKey ? state?.key === apiKey ? state.snapshot : initial || {} : {};
}
