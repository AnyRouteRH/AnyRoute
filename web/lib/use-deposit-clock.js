'use client';
// B123: the API poll refreshes the estimate; this clock keeps it moving between reads.
import { useEffect, useState } from 'react';
export function useDepositClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
