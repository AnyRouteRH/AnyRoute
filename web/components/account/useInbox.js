'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { INBOX_EVENT, readInbox } from '../../lib/inbox.js';
export default function useInbox(apiKey) {
  const [state, setState] = useState({ key: '', page: null, error: '', busy: false });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!apiKey) return;
    const controller = new AbortController();
    setState(old => ({ key: apiKey, page: old.key === apiKey ? old.page : null, busy: true, error: '' }));
    const request = (path, options) => api(path, { ...options, key: apiKey, signal: controller.signal });
    readInbox(request, { getItem: name => window.localStorage.getItem(name) }).then(page => { if (!controller.signal.aborted) setState({ key: apiKey, page, error: '', busy: false }); }).catch(error => { if (!controller.signal.aborted) setState({ key: apiKey, page: null, error: error.message, busy: false }); });
    return () => controller.abort();
  }, [apiKey, revision]);
  useEffect(() => {
    if (!apiKey) return;
    const timer = setInterval(refresh, 60000);
    window.addEventListener(INBOX_EVENT, refresh); window.addEventListener('focus', refresh); window.addEventListener('storage', refresh);
    return () => { clearInterval(timer); window.removeEventListener(INBOX_EVENT, refresh); window.removeEventListener('focus', refresh); window.removeEventListener('storage', refresh); };
  }, [apiKey, refresh]);
  return { ...(apiKey && state.key === apiKey ? state : { page: null, error: '', busy: !!apiKey }), refresh };
}
