'use client';
import { useEffect, useRef, useState } from 'react';
import { activityFilters, activityHref } from './charge-links.js';
// Restore exact instants (not just date-input precision), and keep all filters across edits/exports.
export function useTraceActivity({ recent, filters, setFilters, setForm, project, changeProject }) {
  const [ready, setReady] = useState(false);
  const latest = useRef(null);
  latest.current = { setFilters, setForm, changeProject };
  useEffect(() => {
    if (recent) return;
    const restore = () => {
      const { project: selectedProject, ...next } = activityFilters(window.location.href);
      latest.current.setFilters(next);
      latest.current.setForm({ key: next.key || '', model: next.model || '', from: next.from?.slice(0, 10) || '', to: next.to?.slice(0, 10) || '' });
      latest.current.changeProject(selectedProject || '');
      setReady(true);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [recent]);
  useEffect(() => {
    if (recent || !ready) return;
    const current = new URL(window.location.href);
    if (project && filters.missing_project) { setFilters(old => ({ ...old, missing_project: '' })); return; }
    if (filters.model && filters.missing_model) { setFilters(old => ({ ...old, missing_model: '' })); return; }
    const retained = activityFilters(current.href);
    const extra = Object.fromEntries(Object.entries(retained).filter(([name]) => !['kind', 'key', 'model', 'project', 'from', 'to'].includes(name) && !(name in filters)));
    if (Object.keys(extra).length) { setFilters(old => ({ ...extra, ...old })); return; }
    if (current.hash !== '#activity') return;
    const next = { ...filters, project };
    // Account navigation keeps the hash; unrelated query parameters survive filter edits.
    const target = new URL(activityHref(next), current);
    for (const name of Object.keys(activityFilters(current.href))) current.searchParams.delete(name);
    for (const [name, value] of target.searchParams) current.searchParams.set(name, value);
    window.history.replaceState(window.history.state, '', current.pathname + current.search + current.hash);
  }, [recent, ready, filters, project]);
}
