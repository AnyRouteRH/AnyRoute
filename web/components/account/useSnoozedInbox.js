'use client';
// K187: reuse the normal inbox hook's key/loading boundary and H173's kind projection.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { snoozedInboxPage, snoozedSelected } from '../../lib/inbox-snooze.js';
export default function useSnoozedInbox(state, search) {
  const sleeping = snoozedSelected(search), [saved, setSaved] = useState(null);
  useEffect(() => {
    if (!sleeping || !state.key || !state.page || state.busy) return;
    const controller = new AbortController(), key = state.key, source = state.page;
    api('/api/v1/inbox?snoozed=true', { key, signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) setSaved({ key, source, page: snoozedInboxPage(source, page) });
    }).catch(error => { if (!controller.signal.aborted) setSaved({ key, source, error: error.message }); });
    return () => controller.abort();
  }, [sleeping, state.key, state.page, state.busy]);
  if (!sleeping || !state.page) return state;
  const current = saved?.key === state.key && saved?.source === state.page;
  return { ...state, page: current && saved.page ? saved.page : { ...state.page, data: [], count: 0 }, busy: state.busy || !current, error: state.error || (current ? saved.error : '') };
}
