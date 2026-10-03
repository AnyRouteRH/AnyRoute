'use client';
import { useEffect, useState } from 'react';
import { API_BASE } from '../../lib/api';
import { describeFacilitator } from '../../lib/facilitator';

/** Whether this router's facilitator is switched on, read from GET /api/v1/status when the page opens. */
export default function FacilitatorState() {
  const [state, setState] = useState({ text: 'Reading this router’s status…' });
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`${API_BASE}/api/v1/status`, { signal: ctl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => setState(describeFacilitator(j.data)))
      .catch(e => { if (e.name !== 'AbortError') setState({ text: 'Could not read /api/v1/status, so this page cannot say whether the facilitator is on.' }); });
    return () => ctl.abort();
  }, []);
  return <p className="note" role="status" data-on={state.on ? 'true' : 'false'}>{state.text}</p>;
}
