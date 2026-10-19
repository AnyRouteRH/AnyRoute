'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAccountKey } from './account/useAccountKey';
import { YOUR_MODELS_PATH, yourModelsFromUrl, yourModelsUrl } from '../lib/your-models.js';

export default function useYourModels() {
  const [key] = useAccountKey();
  const [selected, setSelected] = useState(false), [result, setResult] = useState(null), [attempt, setAttempt] = useState(0);
  const active = !!key && selected;
  useEffect(() => {
    const restore = () => setSelected(yourModelsFromUrl(window.location.href));
    restore(); window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setResult(null);
    if (active) api(YOUR_MODELS_PATH, { key, signal: controller.signal })
      .then(report => { if (!controller.signal.aborted) setResult({ key, report }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, error: 'Could not read your models. Check your account connection and try again.' }); });
    return () => controller.abort();
  }, [key, active, attempt]);
  const current = active && result?.key === key ? result : null;
  return { signedIn: !!key, active, report: current?.report, error: current?.error,
    refresh: () => setAttempt(n => n + 1),
    select: value => { setSelected(value); window.history.pushState(window.history.state, '', yourModelsUrl(window.location.href, value)); },
  };
}
