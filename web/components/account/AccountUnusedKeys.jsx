'use client';
import { useRef, useState } from 'react';
import { Button, Modal } from '../UI';
import KeyLastUsed from './KeyLastUsed.js';
import { api } from '../../lib/api';
import { keyName, unusedKeys, unusedKeysNotice, switchOffUnusedKeys } from '../../lib/unused-keys.js';
import s from './AccountUnusedKeys.module.css';

// B125: opt-in cleanup inside the existing Keys tab, with the same API authorization.
export default function AccountUnusedKeys({ apiKey, keys, currentHash, onChanged }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const candidates = unusedKeys(keys, currentHash).filter(key => !disabled.includes(key.hash));
  const picked = candidates.filter(key => selected.includes(key.hash));
  const close = () => { if (!lock.current) setConfirm(null); };

  async function switchOff() {
    if (lock.current || !confirm) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const outcome = await switchOffUnusedKeys((path, options) => api(path, { ...options, key: apiKey }),
        { keys: keys.filter(key => !disabled.includes(key.hash)), currentHash, selected: confirm, confirmed: true },
        hash => setDisabled(previous => [...previous, hash]));
      setResult(outcome); setSelected(outcome.failed.map(key => key.hash)); setConfirm(null);
      await onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not refresh the key list.');
    } finally {
      lock.current = false; setBusy(false);
    }
  }

  if (!apiKey || !currentHash) return null;
  return <section className={s.review} aria-label="Unused keys">
    {candidates.length > 0 && <div className="note">{unusedKeysNotice(candidates.length)}{' '}
      <button className="text-button" aria-expanded={open} aria-controls="unused-key-list" onClick={() => setOpen(!open)} disabled={busy}>Review them</button>
    </div>}
    {result && <div role="status"><p>{result.disabled.length} {result.disabled.length === 1 ? 'key switched' : 'keys switched'} off.</p>
      {result.failed.length > 0 && <ul>{result.failed.map(key => <li key={key.hash}>{key.name}: {key.message}</li>)}</ul>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {open && candidates.length > 0 && <div id="unused-key-list">
      <p>Choose keys to switch off. They can be switched back on later. This browser's key stays on.</p>
      <fieldset className={s.list} disabled={busy}><legend>Keys unused for at least 30 days</legend>
        {candidates.map(key => <label className={s.row} key={key.hash}>
          <input type="checkbox" checked={selected.includes(key.hash)} onChange={event => setSelected(previous => event.target.checked ? [...previous, key.hash] : previous.filter(hash => hash !== key.hash))}/>
          <span><strong>{keyName(key)}</strong>{key.management && <span className="badge">Management key</span>}<KeyLastUsed value={key.last_used}/></span>
        </label>)}
      </fieldset>
      <Button disabled={busy || !picked.length} onClick={() => setConfirm(picked.map(key => key.hash))}>Switch off selected</Button>
    </div>}
    {confirm && <Modal title="Switch off selected keys?" onClose={close}>
      <p>These keys will stop accepting requests. You can switch them back on from API keys.</p>
      <ul>{candidates.filter(key => confirm.includes(key.hash)).map(key => <li key={key.hash}>{keyName(key)}{key.management ? ' · Management key' : ''}</li>)}</ul>
      <div className="button-row"><Button disabled={busy} onClick={switchOff}>{busy ? 'Switching off…' : 'Confirm switch off'}</Button><Button secondary disabled={busy} onClick={close}>Cancel</Button></div>
    </Modal>}
  </section>;
}
