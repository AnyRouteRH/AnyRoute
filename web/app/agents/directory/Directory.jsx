'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { directoryPath } from '../../../lib/agent-profiles';
import ProfileCard from '../profile/ProfileCard';
import PublishProfile from './PublishProfile';
export default function Directory() {
  const [tag, setTag] = useState(''), [filter, setFilter] = useState(''), [cursor, setCursor] = useState('');
  const [page, setPage] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    const ac = new AbortController(); setPage(null); setError('');
    api(directoryPath(filter, cursor), { signal: ac.signal }).then(setPage).catch(e => { if (!ac.signal.aborted) setError(e.status === 404 ? 'Public profiles are not switched on.' : e.message); });
    return () => ac.abort();
  }, [filter, cursor]);
  return <><section className="control-panel"><form onSubmit={e => { e.preventDefault(); setCursor(''); setFilter(tag); }}><label>Capability tag <input value={tag} maxLength={40} onChange={e => setTag(e.target.value)}/></label> <button type="submit">Search</button></form></section>
    {error && <p role="alert">{error}</p>}{!error && !page && <p role="status">Reading directory…</p>}
    {page?.data.map(card => <ProfileCard key={card.anyroute.id} card={card}/>)}
    {page && !page.data.length && <p>No matching public profiles.</p>}
    {page?.next_cursor && <button onClick={() => setCursor(page.next_cursor)}>Next page</button>}
    {cursor && <button onClick={() => setCursor('')}>First page</button>}
    <PublishProfile/></>;
}
