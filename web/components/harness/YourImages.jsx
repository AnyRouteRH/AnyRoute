"use client";
// H167: share Chat's existing attachment path with its history tools.
import { createContext, useContext, useMemo, useState } from 'react';
import { collectYourImages, filterYourImages, yourImagesAccess } from '../../lib/your-images.js';
import { Modal } from '../UI';
import GeneratedImages from './GeneratedImages';
import s from './YourImages.module.css';

const InputContext = createContext(null);
export function YourImagesInputProvider({ onUse, children }) {
  return <InputContext.Provider value={onUse}>{children}</InputContext.Provider>;
}

function Gallery({ history, revision, busy, onOpen, onClose }) {
  const onUse = useContext(InputContext);
  const [query, setQuery] = useState(''), [model, setModel] = useState('');
  const images = useMemo(() => collectYourImages(history), [history, revision]);
  const models = [...new Set(images.map(image => image.model).filter(Boolean))].sort();
  const results = filterYourImages(images, { query, model });
  return <div className={s.body}>
    <p>Images saved in this browser’s encrypted Chat history, including other message versions. Browsing and downloading stay here.</p>
    <p>Newest saved chats first. Dates show when each chat was last saved.</p>
    <div className={s.filters}>
      <label>Search prompts<input autoFocus type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>Model<select value={model} onChange={event => setModel(event.target.value)}><option value="">All models</option>{models.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    </div>
    {!onUse && <p>Choose a model that reads images to use an image as input. Every model in a comparison must read images.</p>}
    <p role="status">{results.length} {results.length === 1 ? 'image' : 'images'}</p>
    {!results.length && <p>{images.length ? 'No images match. Try another word or model.' : 'No generated images are saved here yet. Keep history unlocked when making images in Chat. Only saved images are included.'}</p>}
    <ul className={s.cards}>{results.map(image => <li key={image.id}>
      <p className={s.prompt}>{image.snippet || 'No prompt text saved'}</p>
      <p className={s.meta}>{image.model || 'Model not recorded'} · Chat saved <time dateTime={new Date(image.at).toISOString()}>{new Date(image.at).toLocaleString()}</time></p>
      <GeneratedImages images={[image.url]} busy={busy || !onUse} onUse={async files => { if (history.unlocked && onUse) { await onUse(files); onClose(); } }} />
      <button type="button" className="text-button" disabled={busy} onClick={() => { if (history.unlocked) { onOpen(image); onClose(); } }}>Open chat<span className="sr-only">: {image.title}, {image.snippet}</span></button>
    </li>)}</ul>
    <p>Use as input adds an image to your draft. It is sent through the usual Chat request only when you send the draft.</p>
  </div>;
}

export default function YourImages({ history, revision, busy, checking, onAccess, onOpen }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="text-button" disabled={checking} onClick={() => setOpen(true)}>Your images</button>
    {open && <Modal title="Your images" onClose={() => setOpen(false)}>
      <YourImagesContent history={history} revision={revision} busy={busy} onOpen={onOpen} onAccess={onAccess} onClose={() => setOpen(false)} />
    </Modal>}
  </>;
}

export function YourImagesContent({ history, revision, busy, onOpen, onAccess, onClose }) {
  return history?.unlocked ? <Gallery history={history} revision={revision} busy={busy} onOpen={onOpen} onClose={onClose} /> : <div className={s.body}>
    <p>{yourImagesAccess(history)}</p>
    <button type="button" className="text-button" disabled={busy} onClick={() => { onClose(); onAccess(); }}>Open history settings</button>
  </div>;
}
