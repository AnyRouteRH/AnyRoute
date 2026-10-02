'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, CopyButton, Modal } from '../UI';
import { AccountNavigation, AccountPreview } from './AccountViews.js';
import AccountConnect from './AccountConnect';
import s from './AccountShell.module.css';
export default function AccountShell({ current, apiKey, onConnect, onDisconnect, onNavigate, publicContent = false, children }) {
  const [secret, setSecret] = useState('');
  const content = useRef(null);
  const side = useRef(null);
  // Phones show the sections as one swipeable row: start it at the current section.
  useEffect(() => { const nav = side.current?.querySelector('nav'); const here = nav?.querySelector('[aria-current]'); if (nav && here && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = here.offsetLeft - nav.offsetLeft - 8; }, [current]);
  useEffect(() => {
    if (!apiKey && window.location.hash) content.current?.querySelector('h2')?.focus({ preventScroll: true });
  }, [current, apiKey]);
  return <div className={s.shell}>
    <aside className={s.sidebar} ref={side}><AccountNavigation current={current} onNavigate={onNavigate}/>
      <div className={s.connection}>{apiKey ? <><p className="help-text">Key connected · this tab only</p><Button secondary onClick={onDisconnect}>Disconnect</Button></> : <p className="help-text">Explore your account. Connect a key when you are ready.</p>}</div>
    </aside>
    <div className={s.content} ref={content}>
      {!apiKey && <AccountPreview current={current}><AccountConnect onConnect={onConnect} onSecret={setSecret}/></AccountPreview>}
      {(apiKey || publicContent) && children}
    </div>
    {secret && <Modal title="Save your API key" onClose={() => setSecret('')}><p>Keep this key safe. Anyone with it can use its account access and balance.</p><code className={s.secret}>{secret}</code><div className="button-row"><CopyButton text={secret} label="Copy key"/><Button onClick={() => setSecret('')}>Done</Button></div></Modal>}
  </div>;
}
