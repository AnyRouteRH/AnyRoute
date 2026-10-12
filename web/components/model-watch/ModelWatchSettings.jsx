"use client";
import { useModelWatches } from './useModelWatches';
import s from './ModelWatch.module.css';
export default function ModelWatchSettings({ apiKey }) {
  const { value, error, busy, change } = useModelWatches(apiKey);
  return <section className="settings-panel" aria-labelledby="model-watch-title"><h3 id="model-watch-title">Model watch</h3>
    <p>Watch up to 20 models from their pages or catalogue options. Hear when every live route is unavailable, and when one recovers, after five minutes of steady readings. Choose Inbox and Telegram in Notifications.</p>
    {error && <p role="alert">{error}</p>}
    {!value && !error && <p role="status">Loading watched models…</p>}
    {value && <><p role="status">{value.data.length} of {value.limit} models watched</p><ul className={s.list}>{value.data.map(row => <li key={row.model}><a href={'/models/model/?id=' + encodeURIComponent(row.model)}>{row.name}</a><button type="button" className="text-button" disabled={busy} aria-label={'Unwatch ' + row.name} onClick={() => change(row.model, false)}>Unwatch</button></li>)}</ul></>}
  </section>;
}
