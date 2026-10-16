'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { readWatching } from '../../lib/watching.js';
import s from './Watching.module.css';

export default function AccountWatching({ apiKey }) {
  const [state, setState] = useState(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setState(null);
    readWatching(api, { key: apiKey, signal: controller.signal }).then(groups => {
      if (!controller.signal.aborted) setState({ key: apiKey, groups });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ key: apiKey, error: 'Watching settings could not be read. Connect an account management key and try again.' });
    });
    return () => controller.abort();
  }, [apiKey, revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('anyroute:notifications-saved', refresh);
    return () => window.removeEventListener('anyroute:notifications-saved', refresh);
  }, []);
  const current = state?.key === apiKey ? state : null;
  return <section className="control-panel" aria-labelledby="watching-title">
    <div className={s.heading}><h2 id="watching-title" tabIndex={-1}>What you’re watching</h2><button className="text-button" type="button" onClick={() => setRevision(value => value + 1)}>Refresh watching settings</button></div>
    <p>See your watches, thresholds and schedules together. Follow a link to change the original setting.</p>
    <p className="help-text">Delivery choices come from Notifications above. Sending also depends on the feature being switched on for the service and the destination being linked. <a href="/docs/#watching">How watching works</a></p>
    {!current && <p role="status">Reading watching settings…</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {current?.groups && <div className={s.groups}>{current.groups.map(group => <section key={group.id} className={s.group} aria-labelledby={'watching-' + group.id}>
      <h3 id={'watching-' + group.id}>{group.title}</h3><p className="help-text">{group.channels}</p>
      {group.note && <p>{group.note}</p>}
      {group.state === 'unavailable' && <p>This feature is unavailable for this account or service.</p>}
      {group.state === 'error' && <p role="alert">Some settings could not be read. Refresh to try again.</p>}
      {group.items.length > 0 ? <ul className={s.list}>{group.items.map(row => <li key={row.id}><div><strong>{row.title}</strong><p>{row.setting}</p></div><a href={row.href} aria-label={'Change ' + row.title}>Change</a></li>)}</ul> : group.state === 'ready' && <p>{group.empty}</p>}
      <a className="inline-link" href={group.href}>{group.action}</a>
    </section>)}</div>}
  </section>;
}
