"use client";
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { readModelWatches, changeModelWatch } from '../../lib/model-watch';
const event = 'anyroute-model-watch';
let cachedKey = '', cached = null, expires = 0;
function read(key) {
  if (cachedKey !== key || Date.now() >= expires) {
    cachedKey = key; expires = Date.now() + 10_000;
    cached = readModelWatches(api, { key });
  }
  return cached;
}
export function useModelWatches(apiKey) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; setValue(null); setError('');
    if (!apiKey) { cachedKey = ''; cached = null; expires = 0; }
    const load = () => apiKey && read(apiKey).then(result => { if (active) { setValue(result); setError(''); } }).catch(e => { if (active) setError(e.type === 'feature_disabled' ? 'Model watch is not switched on yet.' : 'Connect an account management key to watch models.'); });
    load(); window.addEventListener(event, load);
    return () => { active = false; window.removeEventListener(event, load); };
  }, [apiKey]);
  async function change(model, watched) {
    setBusy(true); setError('');
    try {
      const result = await changeModelWatch(api, model, watched, { key: apiKey });
      cachedKey = apiKey; cached = Promise.resolve(result); expires = Date.now() + 10_000;
      setValue(result); window.dispatchEvent(new Event(event));
    } catch (e) { setError(e.type === 'watch_limit' ? 'You can watch up to 20 models. Unwatch one in Settings first.' : 'The watch could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  return { value, error, busy, change };
}
