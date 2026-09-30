'use client';
import { useEffect, useState } from 'react';
import { hostId } from '../../lib/hosts';
import s from './hosts.module.css';

export default function YourHost() {
  const [id, setId] = useState('');
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const update = () => setId(hostId(window.location.search, window.location.hash));
    update(); window.addEventListener('hashchange', update); window.addEventListener('popstate', update);
    return () => { window.removeEventListener('hashchange', update); window.removeEventListener('popstate', update); };
  }, []);
  useEffect(() => {
    if (!id) return;
    const ac = new AbortController(); setStatus(null); setMessage('Reading admission status…');
    fetch(`/api/v1/network/hosts/${encodeURIComponent(id)}/status`, { signal: ac.signal, cache: 'no-store' }).then(async res => {
      if (!res.ok) throw new Error(res.status === 404 ? 'Network admission status is unavailable for this host on this router.' : 'Admission status could not be read.');
      const data = await res.json(); if (!ac.signal.aborted) { setStatus(data); setMessage(''); }
    }).catch(error => { if (!ac.signal.aborted) setMessage(error.message); });
    return () => ac.abort();
  }, [id]);
  if (!id) return null;
  return <section className={s.record} aria-label="Your host admission status"><h2>Your host</h2><code>{id}</code>
    {message && <p role="status">{message}</p>}
    {status && <><p>Admission: <strong>{status.status}</strong>. Hardware check: {status.attested ? 'Fresh verification recorded' : 'No fresh verification recorded'}.</p>
      {status.reasons?.length > 0 && <ul>{status.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <p>Probation until: {status.probation_until ? new Date(status.probation_until).toLocaleString() : 'Not recorded'}. Routing weight: {status.weight}.</p></>}
    <p>Probation hosts receive a reduced share of eligible traffic while attested and healthy. Payouts to network hosts are not switched on yet. <a href="/docs/#network-host-signup">Host signup requirements</a>.</p>
  </section>;
}
