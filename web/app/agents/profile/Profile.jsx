'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import ProfileCard from './ProfileCard';
export default function Profile() {
  const [card, setCard] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id || !/^[A-Za-z0-9_-]{24}$/.test(id)) { setError('Supply a public profile id.'); return; }
    const ac = new AbortController();
    api('/api/v1/agents/profiles/' + encodeURIComponent(id), { signal: ac.signal }).then(setCard).catch(e => { if (!ac.signal.aborted) setError(e.status === 404 ? 'Profile unavailable or public profiles are not switched on.' : e.message); });
    return () => ac.abort();
  }, []);
  return error ? <p role="alert">{error}</p> : card ? <ProfileCard card={card} detail/> : <p role="status">Reading public profile…</p>;
}
