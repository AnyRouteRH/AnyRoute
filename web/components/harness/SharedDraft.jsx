'use client';
import { useEffect, useRef, useState } from 'react';
import { clearSharedLocation, receiveSharedDraft, sharedLocation } from '../../lib/share-draft.js';

// Only draft setters and the existing image preparation path are available here.
export function useSharedDraft({ setDraft, addFiles, acceptsImages }) {
  const started = useRef(false);
  const current = useRef(null);
  current.current = { setDraft, addFiles };
  const [share, setShare] = useState(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const incoming = sharedLocation(window.location);
    if (!incoming.present && !incoming.id && !incoming.error) return;
    const apply = draft => {
      current.current.setDraft(draft.text);
      setShare({ ...draft, files: draft.files || [], ready: true });
      clearSharedLocation(window);
    };
    if (incoming.id) {
      setShare({ files: [], ready: false });
      const receive = navigator.serviceWorker ? receiveSharedDraft(navigator.serviceWorker, incoming.id) : Promise.reject();
      receive.then(apply).catch(() => { setShare({ files: [], error: true }); clearSharedLocation(window); });
    } else if (incoming.error) { setShare({ files: [], error: true }); clearSharedLocation(window); }
    else apply(incoming);
  }, []);
  useEffect(() => {
    if (!share?.files.length || !acceptsImages) return;
    const files = share.files;
    setShare(value => ({ ...value, files: [] }));
    current.current.addFiles(files); // Re-encoded JPEGs, stripped metadata and existing limits.
  }, [share, acceptsImages]);
  return share;
}

export default function SharedDraft({ share, signedIn, onSignIn, onChooseModel }) {
  if (!share) return null;
  return <div role="status">
    <p>{share.error ? 'This share could not be opened. Share it again with up to 6 PNG, JPEG, WebP or GIF images, each up to 8 MB.' : share.ready ? 'Shared draft ready. Review it, then press Send.' : 'Opening your shared draft…'}</p>
    {share.truncated && <p>Long shared text was shortened. Review it before sending.</p>}
    {share.files.length > 0 && <p>Choose a vision model to attach your shared images. <button type="button" className="text-button" onClick={onChooseModel}>Choose a vision model</button></p>}
    {share.ready && !signedIn && <p><button type="button" className="text-button" onClick={onSignIn}>Sign in to send</button></p>}
  </div>;
}
