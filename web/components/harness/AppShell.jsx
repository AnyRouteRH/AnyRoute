'use client';
import { useEffect, useState } from 'react';
import { isInstalled } from '../../lib/harness-pwa';
import './AppShell.css';

export default function AppShell() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const display = matchMedia('(display-mode: standalone)');
    const update = () => { document.documentElement.toggleAttribute('data-harness-standalone', isInstalled(navigator, matchMedia)); };
    update();
    const connection = () => setOffline(!navigator.onLine);
    connection();
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    display.addEventListener('change', update);
    return () => { display.removeEventListener('change', update); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); document.documentElement.removeAttribute('data-harness-standalone'); };
  }, []);
  return offline ? <div className="harness-connectivity" role="status">You’re offline. Reconnect to send messages. <a href="/offline.html">Connection help</a></div> : null;
}
