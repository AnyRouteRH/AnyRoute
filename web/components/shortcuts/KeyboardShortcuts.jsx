'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../UI';
import { registerCommand } from '../../lib/command-palette';
import { bindKeyboardShortcuts, SHORTCUTS_EVENT, shortcutsForPage } from '../../lib/keyboard-shortcuts';
import ShortcutKeys from './ShortcutKeys';
import s from './KeyboardShortcuts.module.css';

export default function KeyboardShortcuts() {
  const [page, setPage] = useState(null);
  const previous = useRef(null);
  useEffect(() => {
    const show = () => {
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      previous.current = document.activeElement;
      setPage(window.location.pathname);
    };
    const dispose = bindKeyboardShortcuts({ document, window, onOpen: show, navigate: href => window.location.assign(href) });
    const unregister = registerCommand('keyboard-shortcuts', show);
    window.addEventListener(SHORTCUTS_EVENT, show);
    return () => { dispose(); unregister(); window.removeEventListener(SHORTCUTS_EVENT, show); };
  }, []);
  const close = () => {
    setPage(null);
    requestAnimationFrame(() => { if (previous.current?.isConnected) previous.current.focus(); });
  };
  if (page === null) return null;
  const rows = shortcutsForPage(page);
  const groups = [...new Set(rows.map(row => row.group))];
  return <Modal title="Keyboard shortcuts" onClose={close}>
    <div className={s.sheet}>
      <p>Shortcuts for this page. Single keys work when you are outside a field.</p>
      {groups.map(group => <section key={group} aria-label={group}>
        <h3>{group}</h3>
        <dl>{rows.filter(row => row.group === group).map(row => <div key={row.id}>
          <dt>{row.label}{row.note && <small>{row.note}</small>}</dt><dd><ShortcutKeys id={row.id}/></dd>
        </div>)}</dl>
      </section>)}
      <a href="/docs/#keyboard-shortcuts">Read the shortcut guide</a>
    </div>
  </Modal>;
}
