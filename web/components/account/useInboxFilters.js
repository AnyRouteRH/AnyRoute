// H173: project the existing inbox; never persist item bodies or credentials.
'use client';
import { useEffect, useState } from 'react';
import { readSeen } from '../../lib/inbox.js';
import { projectInbox, selectedKinds } from '../../lib/inbox-filters.js';
export const INBOX_FILTER_EVENT = 'anyroute-inbox-filter-changed';
export default function useInboxFilters(state) {
  const [search, setSearch] = useState('');
  useEffect(() => {
    const sync = () => setSearch(window.location.search);
    sync(); window.addEventListener('popstate', sync); window.addEventListener(INBOX_FILTER_EVENT, sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener(INBOX_FILTER_EVENT, sync); };
  }, []);
  // Reading this bookmark also updates the header's total after a mark or undo.
  let since = '';
  try { if (state.page) since = readSeen(window.localStorage, state.page.seen_scope); } catch {}
  return { ...state, page: state.page ? projectInbox(state.page, since, selectedKinds(search)) : null };
}
