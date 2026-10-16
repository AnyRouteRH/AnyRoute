"use client";
import { useAccountKey } from '../account/useAccountKey';
import { useModelWatches } from './useModelWatches';
import usePageCommand from '../commands/usePageCommand'; // J181
export default function ModelWatchButton({ model }) {
  const [key] = useAccountKey();
  const { value, error, busy, change } = useModelWatches(key);
  usePageCommand('watch-model', () => { if (!value.data.some(row => row.model === model.id)) change(model.id, true); }, !!key && !!value && !busy); // J181
  if (!key) return <a className="text-button" href="/dashboard/#settings">Sign in to watch</a>;
  const watched = value?.data.some(row => row.model === model.id);
  return <div><button type="button" className="text-button" aria-pressed={!!watched} aria-label={(watched ? 'Unwatch ' : 'Watch ') + model.name} disabled={busy || !value} onClick={() => change(model.id, !watched)}>{busy ? 'Saving…' : watched ? 'Unwatch' : 'Watch'}</button>
    {error && <p className="help-text" role="status">{error}</p>}
  </div>;
}
export function ModelWatchMenu({ model }) {
  return <details><summary>Model options</summary><ModelWatchButton model={model}/></details>;
}
