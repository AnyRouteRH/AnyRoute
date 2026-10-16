'use client';
// J181: enter through the page's own callback, after its ordinary readiness checks.
import { useEffect, useRef } from 'react';
import { consumeCommand, registerCommand } from '../../lib/command-palette.js';
export default function usePageCommand(id, run, ready = true, target) {
  const callback = useRef(run);
  callback.current = run;
  useEffect(() => {
    if (!ready) return;
    const unregister = registerCommand(id, () => callback.current());
    if (consumeCommand(window.location, window.history, id, target)) callback.current();
    return unregister;
  }, [id, ready, target]);
}
