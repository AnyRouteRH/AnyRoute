'use client';
import { useEffect, useState } from 'react';
import AccountShell from '../../components/account/AccountShell';
import { useAccountKey } from '../../components/account/useAccountKey';
import { api } from '../../lib/api.js';
import { whyExplanation, whyQuery } from '../../lib/why-refused.js';
import WhyView from '../../components/WhyView.js';
import s from './Why.module.css';
export default function Why() {
  const [key, setKey] = useAccountKey();
  const [query, setQuery] = useState({ type: '', id: '' });
  const [state, setState] = useState(null);
  useEffect(() => { setQuery(whyQuery(window.location.search)); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    if (key && query.type && query.id) api('/api/v1/refusals/' + encodeURIComponent(query.id) + '?type=' + query.type, { key, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setState({ key, ...query, data: value.data }); })
      .catch(() => { if (!controller.signal.aborted) setState({ key, ...query, data: null }); });
    return () => controller.abort();
  }, [key, query.type, query.id]);
  const details = state?.key === key && state?.id === query.id && state?.type === query.type ? state.data : null;
  return <AccountShell publicContent current="Agents" apiKey={key} onConnect={setKey} onDisconnect={() => setKey('')}>
    <div className={s.explanation}><WhyView explanation={whyExplanation(query.type)} signedIn={!!key} details={details}/></div>
  </AccountShell>;
}
