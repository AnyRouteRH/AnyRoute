'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
export default function useRunway(apiKey, revision = 0) {
  const [report, setReport] = useState(null);
  useEffect(() => {
    setReport(null);
    if (!apiKey) return;
    const ac = new AbortController(); let timer;
    const read = async () => {
      try { const value = await api('/api/v1/account/runway', { key: apiKey, signal: ac.signal }); if (!ac.signal.aborted) setReport(value); }
      catch { if (!ac.signal.aborted) setReport(null); }
      finally { if (!ac.signal.aborted) timer = setTimeout(read, 30_000); }
    };
    read();
    return () => { ac.abort(); clearTimeout(timer); };
  }, [apiKey, revision]);
  return report;
}
