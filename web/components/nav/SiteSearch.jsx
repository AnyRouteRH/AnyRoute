'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchTasks, isSearchShortcut } from '../../lib/site-search';
import { GROUPS } from '../../lib/site-map';

const editable = target => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');

export default function SiteSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const dialog = useRef(null);
  const input = useRef(null);
  const results = useMemo(() => searchTasks(query), [query]);
  useEffect(() => {
    const show = () => { setQuery(''); setSelected(0); setOpen(true); };
    const shortcut = event => {
      if (isSearchShortcut(event, { pathname: location.pathname, editable: editable(event.target), dialogOpen: !!document.querySelector('dialog[open]') })) { event.preventDefault(); show(); }
    };
    window.addEventListener('anyroute:site-search', show);
    document.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('anyroute:site-search', show); document.removeEventListener('keydown', shortcut); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const node = dialog.current;
    node.showModal(); input.current?.focus();
    return () => { node.close(); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => {
    if (open) dialog.current?.querySelector(`[data-result="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, query]);
  const close = () => setOpen(false);
  const keys = event => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
      event.preventDefault();
      setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
      input.current?.focus();
    } else if (event.key === 'Enter' && event.target === input.current && results[selected]) {
      event.preventDefault(); window.location.assign(results[selected].href);
    }
  };
  return <dialog ref={dialog} id="site-search" className="modal site-search" aria-labelledby="site-search-title" onCancel={event => { event.preventDefault(); close(); }} onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={keys}>
    <div className="modal-head"><h2 id="site-search-title">Find anything</h2><button type="button" className="icon-button" aria-label="Close search" onClick={close}>×</button></div>
    <label className="eyebrow" htmlFor="site-search-query">Search tools and guides</label>
    <input ref={input} id="site-search-query" type="search" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls="site-search-results" aria-activedescendant={open && results[selected] ? `search-${results[selected].id}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} autoComplete="off" spellCheck="false" />
    <p className="search-status" role="status">{query.trim() ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : 'Start here'}</p>
    <div className="search-results" id="site-search-results" role="listbox" aria-label="Matching tasks">{open && results.map((task, index) => <a key={task.id} id={`search-${task.id}`} data-result={index} href={task.href} role="option" aria-selected={selected === index} onFocus={() => setSelected(index)} onMouseMove={() => setSelected(index)} onClick={close}>
      <small>{GROUPS.find(group => group.id === task.group).title}</small><strong>{task.title}</strong><span>{task.description}</span>
    </a>)}</div>
    {open && !results.length && <p className="search-empty">No matching tasks. Try another word or <a href="/docs/" onClick={close}>browse the docs</a>.</p>}
    <p className="search-help">↑ ↓ to choose · Enter to open · Esc to close</p>
  </dialog>;
}
