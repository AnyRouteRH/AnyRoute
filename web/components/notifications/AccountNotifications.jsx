'use client';
import { useEffect, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api';
import { NOTICE_ROWS, readNotifications, saveNotifications, localToUtc, utcToLocal } from '../../lib/notifications';
import s from './Notifications.module.css';
export default function AccountNotifications({ apiKey }) {
  const [value, setValue] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [quiet, setQuiet] = useState(false), [from, setFrom] = useState('22:00'), [to, setTo] = useState('08:00');
  function apply(data) {
    setValue(data); setQuiet(!!data.quiet_hours);
    if (data.quiet_hours) { setFrom(utcToLocal(data.quiet_hours.from_utc)); setTo(utcToLocal(data.quiet_hours.to_utc)); }
  }
  useEffect(() => {
    const controller = new AbortController(); setValue(null); setError(''); setStatus('');
    readNotifications(api, { key: apiKey, signal: controller.signal }).then(data => { if (!controller.signal.aborted) apply(data); }).catch(() => { if (!controller.signal.aborted) setError('Connect an account management key to read notifications.'); });
    return () => controller.abort();
  }, [apiKey]);
  function change(type, channel, checked) { setStatus(''); setValue(v => ({ ...v, channels: { ...v.channels, [type]: { ...v.channels[type], [channel]: checked } } })); }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setStatus('');
    try {
      if (quiet && from === to) throw new Error('Choose different start and end times.');
      apply(await saveNotifications(api, { ...value, quiet_hours: quiet ? { from_utc: localToUtc(from), to_utc: localToUtc(to) } : null }, { key: apiKey })); setStatus('Notifications saved.');
    } catch { setError('Notifications could not be saved. Check the times and try again.'); }
    finally { setBusy(false); }
  }
  return <section className="control-panel" aria-labelledby="notifications-title"><h2 id="notifications-title" tabIndex={-1}>Notifications</h2>
    <p>Choose what arrives in your inbox and Telegram. Approvals always arrive without waiting when their Telegram switch is on.</p>
    {error && <p role="alert">{error}</p>}{!value && !error && <p role="status">Reading notifications…</p>}
    {value && <form onSubmit={save}><fieldset disabled={busy} className={s.form}><legend className={s.legend}>Delivery choices</legend>
      {!value.telegram_linked && <p id="telegram-link-hint" className="help-text">Link Telegram from <a href="/agents/">Agents</a> to use its switches.</p>}
      <div className={s.heading} aria-hidden="true"><span>Notice</span><span>Inbox</span><span>Telegram</span></div>
      {NOTICE_ROWS.map(([type, title]) => <div key={type} className={s.row}><span>{title}</span>{['inbox', 'telegram'].map(channel => <label key={channel} className={s.switch}><input type="checkbox" role="switch" aria-label={`${title}: ${channel === 'inbox' ? 'Inbox' : 'Telegram'}`} aria-describedby={channel === 'telegram' && !value.telegram_linked ? 'telegram-link-hint' : undefined} checked={value.channels[type][channel]} disabled={channel === 'telegram' && !value.telegram_linked} onChange={e => change(type, channel, e.target.checked)}/><span aria-hidden="true"/></label>)}</div>)}
      <div className={s.quiet}><h3>Quiet hours for Telegram</h3>
        {!value.quiet_hours_available && <p className="help-text">Quiet-hour delivery is not switched on yet.</p>}
        <label><input type="checkbox" checked={quiet} disabled={!value.quiet_hours_available || !value.telegram_linked} onChange={e => { setQuiet(e.target.checked); setStatus(''); }}/> Wait during quiet hours</label>
        <div className={s.times}><label>From<input type="time" required value={from} disabled={!quiet || !value.quiet_hours_available || !value.telegram_linked} onChange={e => { setFrom(e.target.value); setStatus(''); }}/></label><label>To<input type="time" required value={to} disabled={!quiet || !value.quiet_hours_available || !value.telegram_linked} onChange={e => { setTo(e.target.value); setStatus(''); }}/></label></div>
        <p className="help-text">Times use your device’s local time and are saved in UTC. Save again after a daylight-saving or time-zone change. Notices wait and arrive together after quiet hours; approvals never wait.</p>
      </div><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save notifications'}</Button>
    </fieldset><p role="status">{status}</p></form>}
  </section>;
}
