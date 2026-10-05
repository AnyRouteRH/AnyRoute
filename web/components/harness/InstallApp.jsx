'use client';
import { useEffect, useState } from 'react';
import { listenForInstall } from '../../lib/harness-pwa';
import { Modal } from '../UI';
import s from './InstallApp.module.css';

export default function InstallApp() {
  const [state, setState] = useState({ prompt: null, installed: false, ios: false });
  const [instructions, setInstructions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const stop = listenForInstall(window, setState);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
        // Installation remains available if the browser offers it; ordinary browsing still works.
      });
    }
    return stop;
  }, []);
  if (state.installed || (!state.prompt && !state.ios)) return null;
  const install = async () => {
    if (!state.prompt || busy) return;
    setBusy(true);
    try {
      await state.prompt.prompt();
      await state.prompt.userChoice;
    } catch { setNotice('Open your browser menu to install Anyroute.'); }
    finally { setState(value => ({ ...value, prompt: null })); setBusy(false); }
  };
  return <>
    {state.prompt ? <button type="button" className={s.button} disabled={busy} onClick={install} title="Install Anyroute on your phone or desktop">Install app</button> :
      <button type="button" className={s.button} onClick={() => setInstructions(true)}>Add to Home Screen</button>}
    {notice && <span className="sr-only" role="status">{notice}</span>}
    {instructions && <Modal title="Install Anyroute" onClose={() => setInstructions(false)}>
      <div className={s.instructions}>
        <p>Install Anyroute on your phone or desktop.</p>
        <ol><li>Open this page in Safari.</li><li>Tap Share, then Add to Home Screen. You may need to scroll through the share menu.</li><li>Turn on Open as Web App if shown, then tap Add.</li></ol>
        <p>The app opens the Harness. Chat needs an internet connection. Its static pages and assets stay in this browser; requests and replies are never saved by the app cache.</p>
      </div>
    </Modal>}
  </>;
}
