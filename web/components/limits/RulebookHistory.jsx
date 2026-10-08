'use client';
// D144: history sits beside the existing rulebook card and reuses its request/auth flow.
import { useEffect, useState } from 'react';
import { Button } from '../UI';
import { utcTime } from '../../lib/agents';
import { historyPath, restorePath, savedByLabel, historySource, restoreConfirmation } from '../../lib/rulebook-history';
import s from './RulebookHistory.module.css';

export default function RulebookHistory({ keyHash, request, playbook, revision, disabled, onRestored }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open || playbook) return;
    const ac = new AbortController(); setVersions(null); setError('');
    request(historyPath(keyHash), { signal: ac.signal }).then(result => {
      if (!ac.signal.aborted) setVersions(Array.isArray(result.data) ? result.data : []);
    }).catch(e => { if (!ac.signal.aborted) setError(e?.message || 'History could not be read.'); });
    return () => ac.abort();
  }, [open, playbook, keyHash, request, revision, reload]);
  const restore = async version => {
    if (!window.confirm(restoreConfirmation(utcTime(version.saved_at)))) return;
    setBusy(true); setError('');
    try {
      await request(restorePath(keyHash), { method: 'POST', body: { sha256: version.sha256 } });
      setReload(value => value + 1); onRestored?.();
    } catch (e) { setError(e?.message || 'The version could not be restored.'); }
    finally { setBusy(false); }
  };
  return <details className={s.history} open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>History</summary>
    {playbook ? <p>This key follows playbook <a href="/dashboard/#playbooks">{playbook.name}</a>. Its rules change with that playbook. Stop following it before restoring this key’s own rules.</p> : <>
      <p className="help-text">The latest 50 saved versions, newest first. Changes compare each version with the one before it. Saving again keeps another version.</p>
      {error && <p role="alert">{error}</p>}
      {error && !busy && <Button type="button" secondary onClick={() => setReload(value => value + 1)}>Read history again</Button>}
      {!versions && !error && open && <p role="status">Reading history…</p>}
      {versions?.length === 0 && <p>No saved versions yet.</p>}
      <ol className={s.versions}>{(versions || []).map(version => <li key={version.id}>
        <p><time dateTime={version.saved_at}>{utcTime(version.saved_at)}</time> · {savedByLabel(version.saved_by)} · {historySource(version.source)}</p>
        {version.diff?.removed?.length > 0 && <><h4>Removed</h4><ul>{version.diff.removed.map((line, index) => <li key={index}>{line}</li>)}</ul></>}
        {version.diff?.added?.length > 0 && <><h4>Added</h4><ul>{version.diff.added.map((line, index) => <li key={index}>{line}</li>)}</ul></>}
        {!version.diff?.added?.length && !version.diff?.removed?.length && <p>No changes to the rulebook sentences.</p>}
        <Button type="button" secondary disabled={disabled || busy} onClick={() => restore(version)}>Restore this version</Button>
      </li>)}</ol>
      {busy && <p role="status">Restoring rules…</p>}
    </>}
  </details>;
}
