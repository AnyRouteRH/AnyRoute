'use client';
import { useEffect, useRef } from 'react';
import { checkupTarget, checkupControl } from '../../lib/account-checkup-target.js';

// J177: open and focus existing editors after their guarded reads finish.
export default function AccountCheckupTarget({ enabled, tab, keys, onEdit }) {
  const opened = useRef('');
  useEffect(() => {
    if (!enabled) return;
    const target = checkupTarget(window.location.search);
    if (!target || target.tab !== tab) return;
    if (target.hash) {
      const key = keys.find(key => key.id === target.hash);
      if (!key) return;
      const id = target.control + ':' + target.hash;
      if (opened.current !== id) { opened.current = id; onEdit({ type: target.control === 'limit' ? 'limits' : 'key', data: key }); }
    }
    const go = () => {
      const field = checkupControl(document, target);
      if (!field || field.matches(':disabled')) return false;
      const dialog = field.closest('dialog'); if (dialog && !dialog.open) return false;
      const details = field.closest('details'); if (details) details.open = true;
      field.scrollIntoView({ block: 'center' }); field.focus({ preventScroll: true });
      const url = new URL(window.location.href); url.searchParams.delete('checkup'); url.searchParams.delete('checkup_key');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      return true;
    };
    if (go()) return;
    const observer = new MutationObserver(() => { if (go()) stop(); });
    const timer = setTimeout(() => observer.disconnect(), 15000);
    const stop = () => { observer.disconnect(); clearTimeout(timer); };
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'open'] });
    return stop;
  }, [enabled, tab, keys, onEdit]);
  return null;
}
